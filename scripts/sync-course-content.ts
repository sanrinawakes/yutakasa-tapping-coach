import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  GOOGLE_DOC_TRANSCRIPTS,
  getTranscriptUrl,
} from "../src/lib/transcript-config";

interface GeneratedCourseDocument {
  id: string;
  title: string;
  content: string;
}

interface GeneratedCourseContent {
  generatedAt: string;
  sourceCount: number;
  totalChars: number;
  contentSha256: string;
  documents: GeneratedCourseDocument[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(
  SCRIPT_DIR,
  "../src/generated/course-content.json"
);
const MIN_TOTAL_CHARS = 400_000;
const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPTS = 4;
const CONCURRENCY = 4;
const PRIVATE_CACHE_BUCKET = "yutakasa-build-cache";
const PRIVATE_CACHE_PATH = "course-content.json";

let buildCacheClient: SupabaseClient | null | undefined;

function contentSha256(documents: GeneratedCourseDocument[]): string {
  return createHash("sha256")
    .update(
      documents
        .map(
          (document) =>
            `${document.id}\n${document.title}\n${document.content}`
        )
        .join("\n---\n")
    )
    .digest("hex");
}

function hasExpectedDocuments(data: GeneratedCourseContent): boolean {
  if (
    data.sourceCount !== GOOGLE_DOC_TRANSCRIPTS.length ||
    data.totalChars < MIN_TOTAL_CHARS ||
    data.documents.length !== GOOGLE_DOC_TRANSCRIPTS.length ||
    data.contentSha256 !== contentSha256(data.documents)
  ) {
    return false;
  }

  return GOOGLE_DOC_TRANSCRIPTS.every((source, index) => {
    const generated = data.documents[index];
    return (
      generated?.id === source.id &&
      generated.title === source.title &&
      generated.content.trim().length > 100
    );
  });
}

function parseGeneratedContent(raw: string): GeneratedCourseContent | null {
  try {
    const data = JSON.parse(raw) as GeneratedCourseContent;
    return hasExpectedDocuments(data) ? data : null;
  } catch {
    return null;
  }
}

function isCurrent(data: GeneratedCourseContent): boolean {
  const generatedAt = new Date(data.generatedAt).getTime();
  return (
    Number.isFinite(generatedAt) &&
    Date.now() - generatedAt < MAX_CACHE_AGE_MS
  );
}

async function readLocalGeneratedContent(): Promise<GeneratedCourseContent | null> {
  try {
    return parseGeneratedContent(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function writeGeneratedContent(data: GeneratedCourseContent) {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(data)}\n`, "utf8");
}

function getBuildCacheClient(): SupabaseClient | null {
  if (buildCacheClient !== undefined) return buildCacheClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  buildCacheClient =
    url && key
      ? createClient(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;
  return buildCacheClient;
}

async function readPrivateSnapshot(): Promise<GeneratedCourseContent | null> {
  const client = getBuildCacheClient();
  if (!client) return null;

  const { data, error } = await client.storage
    .from(PRIVATE_CACHE_BUCKET)
    .download(PRIVATE_CACHE_PATH);
  if (error || !data) {
    console.warn("Verified private course snapshot is unavailable.");
    return null;
  }

  const parsed = parseGeneratedContent(await data.text());
  if (!parsed) {
    console.warn("Verified private course snapshot failed validation.");
  }
  return parsed;
}

async function writePrivateSnapshot(data: GeneratedCourseContent) {
  const client = getBuildCacheClient();
  if (!client) return;

  const { error } = await client.storage
    .from(PRIVATE_CACHE_BUCKET)
    .upload(PRIVATE_CACHE_PATH, `${JSON.stringify(data)}\n`, {
      contentType: "application/json",
      upsert: true,
    });
  if (error) throw error;
}

async function fetchTranscriptWithRetry(
  source: (typeof GOOGLE_DOC_TRANSCRIPTS)[number]
): Promise<GeneratedCourseDocument> {
  let latestError: unknown;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(getTranscriptUrl(source.id), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const content = (await response.text()).trim();
      if (content.length <= 100) {
        throw new Error(`content too short: ${content.length} characters`);
      }

      return { ...source, content };
    } catch (error) {
      latestError = error;
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * 2 ** (attempt - 1))
        );
      }
    }
  }

  throw new Error(
    `Failed to fetch ${source.title} after ${FETCH_ATTEMPTS} attempts: ${String(latestError)}`
  );
}

async function fetchAllTranscripts(): Promise<GeneratedCourseDocument[]> {
  const results = new Array<GeneratedCourseDocument>(
    GOOGLE_DOC_TRANSCRIPTS.length
  );
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, GOOGLE_DOC_TRANSCRIPTS.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= GOOGLE_DOC_TRANSCRIPTS.length) return;
        results[index] = await fetchTranscriptWithRetry(
          GOOGLE_DOC_TRANSCRIPTS[index]
        );
      }
    }
  );

  await Promise.all(workers);
  return results;
}

async function main() {
  const forceSync = process.env.FORCE_COURSE_CONTENT_SYNC === "1";
  const localSnapshot = await readLocalGeneratedContent();
  if (!forceSync && localSnapshot && isCurrent(localSnapshot)) {
    console.log("Course content is current; reusing the generated server bundle.");
    return;
  }

  const privateSnapshot = await readPrivateSnapshot();
  if (!forceSync && privateSnapshot && isCurrent(privateSnapshot)) {
    await writeGeneratedContent(privateSnapshot);
    console.log("Course content is current; restored the verified private snapshot.");
    return;
  }

  const startedAt = Date.now();
  try {
    const documents = await fetchAllTranscripts();
    const totalChars = documents.reduce(
      (total, document) => total + document.content.length,
      0
    );
    if (totalChars < MIN_TOTAL_CHARS) {
      throw new Error(
        `Course content validation failed: ${totalChars} characters is below ${MIN_TOTAL_CHARS}.`
      );
    }

    const generated: GeneratedCourseContent = {
      generatedAt: new Date().toISOString(),
      sourceCount: documents.length,
      totalChars,
      contentSha256: contentSha256(documents),
      documents,
    };

    await writeGeneratedContent(generated);
    await writePrivateSnapshot(generated).catch(() => {
      console.warn("Could not refresh the private course snapshot.");
    });
    console.log(
      `Generated ${documents.length} course documents (${totalChars} characters) in ${Date.now() - startedAt}ms; sha256=${generated.contentSha256.slice(0, 12)}.`
    );
  } catch (error) {
    const fallback = privateSnapshot ?? localSnapshot;
    if (!fallback) throw error;
    await writeGeneratedContent(fallback);
    console.warn(
      `Google Docs sync failed; using the last verified private snapshot: ${String(error)}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
