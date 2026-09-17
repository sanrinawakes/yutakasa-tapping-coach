import { createHash } from "node:crypto";

import {
  DRIVE_INTAKE_FOLDER_ID,
  DriveIntakeError,
  getDriveOAuthAccessToken,
} from "./drive-intake.mjs";

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const EXPORTED = new Map([
  ["application/vnd.google-apps.document", {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
  }],
  ["application/vnd.google-apps.spreadsheet", {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  }],
]);
const BINARY_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "image/png",
  "image/jpeg",
]);

function fail(code) {
  throw new DriveIntakeError(code);
}

function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(id);
}

async function boundedBody(response, code) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_BYTES) {
    fail(`${code}_too_large`);
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    fail(`${code}_invalid`);
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) fail(`${code}_invalid`);
      total += chunk.byteLength;
      if (total > MAX_BYTES) fail(`${code}_too_large`);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail(`${code}_failed`);
  }
  return Buffer.concat(chunks, total);
}

async function request(url, headers, code, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response?.status !== 200) fail(`${code}_http_failure`);
    return await boundedBody(response, code);
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail(`${code}_request_failed`);
  }
}

// Read one item from a previously validated intake snapshot. Returned bytes
// stay in memory; callers must keep them out of logs and external AI prompts.
export async function fetchDriveIntakeContent({
  file,
  credentials = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (
    !file || !validId(file.id) ||
    typeof file.name !== "string" || file.name.length === 0 || file.name.length > 1024 ||
    typeof file.modifiedTime !== "string" ||
    !Number.isFinite(Date.parse(file.modifiedTime)) ||
    typeof file.mimeType !== "string" ||
    (!BINARY_MIME_TYPES.has(file.mimeType) && !EXPORTED.has(file.mimeType))
  ) {
    fail("drive_intake_content_input_invalid");
  }
  const accessToken = await getDriveOAuthAccessToken({ credentials, fetchImpl });
  const headers = { Authorization: `Bearer ${accessToken}` };
  const metadataUrl = new URL(`${FILES_URL}/${file.id}`);
  metadataUrl.searchParams.set(
    "fields",
    "id,name,mimeType,modifiedTime,parents,size,md5Checksum,trashed",
  );
  const metadataBytes = await request(
    metadataUrl.toString(), headers, "drive_intake_content_metadata", fetchImpl,
  );
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes));
  } catch {
    fail("drive_intake_content_metadata_invalid");
  }
  if (
    metadata?.id !== file.id ||
    metadata.name !== file.name ||
    metadata.mimeType !== file.mimeType ||
    metadata.modifiedTime !== file.modifiedTime ||
    metadata.trashed !== false ||
    !Array.isArray(metadata.parents) ||
    !metadata.parents.includes(DRIVE_INTAKE_FOLDER_ID) ||
    (metadata.size !== undefined &&
      (!/^\d+$/u.test(String(metadata.size)) || Number(metadata.size) > MAX_BYTES)) ||
    (metadata.md5Checksum !== undefined &&
      (typeof metadata.md5Checksum !== "string" ||
        !/^[a-f0-9]{32}$/iu.test(metadata.md5Checksum)))
  ) {
    fail("drive_intake_content_metadata_mismatch");
  }
  const exportAs = EXPORTED.get(file.mimeType);
  const contentUrl = exportAs
    ? new URL(`${FILES_URL}/${file.id}/export`)
    : new URL(`${FILES_URL}/${file.id}`);
  if (exportAs) contentUrl.searchParams.set("mimeType", exportAs.mimeType);
  else contentUrl.searchParams.set("alt", "media");
  const bytes = await request(
    contentUrl.toString(), headers, "drive_intake_content", fetchImpl,
  );
  if (bytes.length === 0) fail("drive_intake_content_empty");
  if (file.mimeType === "application/pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    fail("drive_intake_content_pdf_invalid");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    !exportAs && metadata.md5Checksum &&
    createHash("md5").update(bytes).digest("hex") !== metadata.md5Checksum.toLowerCase()
  ) {
    fail("drive_intake_content_checksum_mismatch");
  }
  return {
    fileId: file.id,
    mimeType: exportAs?.mimeType ?? file.mimeType,
    extension: exportAs?.extension ?? "",
    sha256,
    bytes,
  };
}
