#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeSnapshotFile } from "./yutakasa-production-snapshot.mjs";

export const DRIVE_INTAKE_FOLDER_ID = "16q1toSGCWB0WyI7zH2KAKNzvENL9FfLT";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const FOLDER_URL = `${FILES_URL}/${DRIVE_INTAKE_FOLDER_ID}?fields=id,name,mimeType,trashed`;
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const MAX_FILES = PAGE_SIZE * MAX_PAGES;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_RESPONSE_MAX_BYTES = 1024 * 1024;
const LIST_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export class DriveIntakeError extends Error {
  constructor(code) {
    super(code);
    this.name = "DriveIntakeError";
    this.code = code;
  }
}

function fail(code) {
  throw new DriveIntakeError(code);
}

function requiredCredential(source, key) {
  const value = source?.[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8192 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    fail(`drive_credential_missing_or_invalid_${key.toLowerCase()}`);
  }
  return value;
}

function validateCredentials(source) {
  if (source?.GOOGLE_DRIVE_API_KEY !== undefined) {
    const apiKey = requiredCredential(source, "GOOGLE_DRIVE_API_KEY");
    if (apiKey.length > 512 || /\s/u.test(apiKey)) {
      fail("drive_credential_missing_or_invalid_google_drive_api_key");
    }
    return { kind: "api_key", apiKey };
  }
  return {
    kind: "oauth",
    clientId: requiredCredential(source, "GOOGLE_DRIVE_CLIENT_ID"),
    clientSecret: requiredCredential(source, "GOOGLE_DRIVE_CLIENT_SECRET"),
    refreshToken: requiredCredential(source, "GOOGLE_DRIVE_REFRESH_TOKEN"),
  };
}

async function boundedJson(response, maxBytes, code) {
  const declaredLength = response.headers?.get?.("content-length");
  if (
    declaredLength &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    fail(`${code}_response_too_large`);
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    fail(`${code}_response_invalid`);
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) fail(`${code}_response_invalid`);
      total += chunk.byteLength;
      if (total > maxBytes) fail(`${code}_response_too_large`);
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, total),
      ),
    );
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail(`${code}_response_invalid`);
  }
}

async function requestJson(url, options, maxBytes, code, fetchImpl) {
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DriveIntakeError(`${code}_timeout`));
    }, REQUEST_TIMEOUT_MS);
  });
  const request = (async () => {
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    if (response?.status !== 200) fail(`${code}_http_failure`);
    return boundedJson(response, maxBytes, code);
  })();
  try {
    return await Promise.race([request, timedOut]);
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail(`${code}_request_failed`);
  } finally {
    clearTimeout(timer);
  }
}

async function refreshAccessToken(credentials, fetchImpl) {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });
  const result = await requestJson(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    TOKEN_RESPONSE_MAX_BYTES,
    "drive_token",
    fetchImpl,
  );
  if (
    typeof result?.access_token !== "string" ||
    result.access_token.length < 10 ||
    result.access_token.length > 8192 ||
    typeof result.token_type !== "string" ||
    result.token_type.toLowerCase() !== "bearer"
  ) {
    fail("drive_token_schema_invalid");
  }
  return result.access_token;
}

// File content and writes require user OAuth. The API key used by the
// metadata-only monitor must never be accepted as a write credential.
export async function getDriveOAuthAccessToken({
  credentials = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  return refreshAccessToken({
    clientId: requiredCredential(credentials, "GOOGLE_DRIVE_CLIENT_ID"),
    clientSecret: requiredCredential(credentials, "GOOGLE_DRIVE_CLIENT_SECRET"),
    refreshToken: requiredCredential(credentials, "GOOGLE_DRIVE_REFRESH_TOKEN"),
  }, fetchImpl);
}

function validateFile(file) {
  if (
    !file ||
    typeof file !== "object" ||
    typeof file.id !== "string" ||
    file.id.length === 0 ||
    file.id.length > 256 ||
    typeof file.name !== "string" ||
    file.name.length === 0 ||
    file.name.length > 1024 ||
    typeof file.mimeType !== "string" ||
    file.mimeType.length === 0 ||
    file.mimeType.length > 256 ||
    typeof file.modifiedTime !== "string" ||
    !Number.isFinite(Date.parse(file.modifiedTime))
  ) {
    fail("drive_file_schema_invalid");
  }
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
  };
}

export async function collectDriveIntakeMetadata({
  credentials = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const auth = validateCredentials(credentials);
  const accessToken = auth.kind === "oauth"
    ? await refreshAccessToken(auth, fetchImpl)
    : undefined;
  // A key identifies the Cloud project for publicly shared files. Keep it in
  // the request header so it cannot appear in URLs or ordinary request logs.
  const headers = auth.kind === "api_key"
    ? { "X-Goog-Api-Key": auth.apiKey }
    : { Authorization: `Bearer ${accessToken}` };
  const folder = await requestJson(
    FOLDER_URL,
    { method: "GET", headers },
    TOKEN_RESPONSE_MAX_BYTES,
    "drive_folder",
    fetchImpl,
  );
  if (
    folder?.id !== DRIVE_INTAKE_FOLDER_ID ||
    folder.name !== "受付" ||
    folder.mimeType !== "application/vnd.google-apps.folder" ||
    folder.trashed !== false
  ) {
    fail("drive_folder_identity_invalid");
  }
  const seenPageTokens = new Set();
  const seenFileIds = new Set();
  const files = [];
  let pageToken;
  let pageCount = 0;

  while (pageCount < MAX_PAGES) {
    const url = new URL(FILES_URL);
    url.searchParams.set(
      "q",
      `'${DRIVE_INTAKE_FOLDER_ID}' in parents and trashed = false`,
    );
    url.searchParams.set("spaces", "drive");
    // Public-folder API-key requests have no signed-in user corpus.
    if (auth.kind === "oauth") url.searchParams.set("corpora", "user");
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    url.searchParams.set(
      "fields",
      "kind,nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)",
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const result = await requestJson(
      url.toString(),
      {
        method: "GET",
        headers,
      },
      LIST_RESPONSE_MAX_BYTES,
      "drive_list",
      fetchImpl,
    );
    pageCount += 1;
    if (
      result?.kind !== "drive#fileList" ||
      result.incompleteSearch === true ||
      !Array.isArray(result.files) ||
      result.files.length > PAGE_SIZE
    ) {
      fail("drive_list_schema_or_search_invalid");
    }
    if (
      result.incompleteSearch !== undefined &&
      result.incompleteSearch !== false
    ) {
      fail("drive_list_schema_or_search_invalid");
    }
    for (const rawFile of result.files) {
      const file = validateFile(rawFile);
      if (seenFileIds.has(file.id)) fail("drive_pagination_duplicate_file");
      seenFileIds.add(file.id);
      files.push(file);
      if (files.length > MAX_FILES) fail("drive_pagination_limit_exceeded");
    }
    const next = result.nextPageToken;
    if (next === undefined || next === null || next === "") break;
    if (
      typeof next !== "string" ||
      next.length > 8192 ||
      seenPageTokens.has(next)
    ) {
      fail("drive_pagination_token_mismatch");
    }
    seenPageTokens.add(next);
    pageToken = next;
    if (pageCount === MAX_PAGES) fail("drive_pagination_limit_exceeded");
  }
  files.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const observedAt = now().toISOString();
  return {
    schemaVersion: 1,
    trust: "untrusted_drive_metadata",
    folderId: DRIVE_INTAKE_FOLDER_ID,
    observedAt,
    pageCount,
    files,
  };
}

export async function pollDriveIntakeToFile({
  outputPath,
  ...options
} = {}) {
  if (typeof outputPath !== "string" || !outputPath) fail("drive_output_path_missing");
  let parentStat;
  try {
    parentStat = fs.lstatSync(path.dirname(path.resolve(outputPath)));
  } catch {
    fail("drive_output_parent_not_private");
  }
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o777) !== 0o700
  ) {
    fail("drive_output_parent_not_private");
  }
  const metadata = await collectDriveIntakeMetadata(options);
  try {
    writeSnapshotFile(outputPath, metadata);
    const stat = fs.lstatSync(outputPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      fail("drive_output_not_private");
    }
  } catch {
    fail("drive_output_write_failed");
  }
  return {
    ok: true,
    fileCount: metadata.files.length,
    pageCount: metadata.pageCount,
  };
}

export async function runDriveIntakeCli(argv = process.argv.slice(2)) {
  if (argv.length !== 1) fail("drive_usage_output_path_required");
  const summary = await pollDriveIntakeToFile({ outputPath: argv[0] });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runDriveIntakeCli().catch((error) => {
    const code =
      error instanceof DriveIntakeError
        ? error.code
        : "drive_intake_unexpected_failure";
    process.stdout.write(
      `${JSON.stringify({ ok: false, reasonCodes: [code] })}\n`,
    );
    process.exitCode = 1;
  });
}
