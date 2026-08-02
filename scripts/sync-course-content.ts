import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_ATTEMPTS = 3;
const CONCURRENCY = 8;

function hasExpectedDocuments(data: GeneratedCourseContent): boolean {
  if (
    data.sourceCount !== GOOGLE_DOC_TRANSCRIPTS.length ||
    data.totalChars < MIN_TOTAL_CHARS ||
    data.documents.length !== GOOGLE_DOC_TRANSCRIPTS.length
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

async function canReuseGeneratedContent(): Promise<boolean> {
  if (process.env.FORCE_COURSE_CONTENT_SYNC === "1") return false;

  try {
    const raw = await readFile(OUTPUT_PATH, "utf8");
    const data = JSON.parse(raw) as GeneratedCourseContent;
    const generatedAt = new Date(data.generatedAt).getTime();
    return (
      Number.isFinite(generatedAt) &&
      Date.now() - generatedAt < MAX_CACHE_AGE_MS &&
      hasExpectedDocuments(data)
    );
  } catch {
    return false;
  }
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
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
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
  if (await canReuseGeneratedContent()) {
    console.log("Course content is current; reusing the generated server bundle.");
    return;
  }

  const startedAt = Date.now();
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

  const contentSha256 = createHash("sha256")
    .update(
      documents
        .map(
          (document) =>
            `${document.id}\n${document.title}\n${document.content}`
        )
        .join("\n---\n")
    )
    .digest("hex");
  const generated: GeneratedCourseContent = {
    generatedAt: new Date().toISOString(),
    sourceCount: documents.length,
    totalChars,
    contentSha256,
    documents,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(generated)}\n`, "utf8");
  console.log(
    `Generated ${documents.length} course documents (${totalChars} characters) in ${Date.now() - startedAt}ms; sha256=${contentSha256.slice(0, 12)}.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
