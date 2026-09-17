import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DriveIntakeError, getDriveOAuthAccessToken } from "./drive-intake.mjs";
import { createDriveResultLedger } from "./drive-result-ledger.mjs";

export const DRIVE_RESULT_FOLDER_ID = "11nYD_FzHqnYKbOy2zPBge3Y_of2tM-m5";

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const PDF_LIMIT = 5 * 1024 * 1024;
const JSON_LIMIT = 256 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 30_000;
const RENDERER = fileURLToPath(new URL("./render-drive-result.py", import.meta.url));

function fail(code) {
  throw new DriveIntakeError(code);
}

function safeEventId(eventId) {
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{6,80}$/u.test(eventId)) {
    fail("drive_result_event_invalid");
  }
  return eventId;
}

function validateReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail("drive_result_report_invalid");
  }
  const eventId = safeEventId(report.eventId);
  if (
    typeof report.completedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(report.completedAt) ||
    !Number.isFinite(Date.parse(report.completedAt))
  ) {
    fail("drive_result_date_invalid");
  }
  if (
    !Array.isArray(report.tests) || report.tests.length === 0 ||
    report.tests.some((item) =>
      !item || item.failed !== 0 || !Number.isSafeInteger(item.passed) || item.passed < 0
    ) ||
    !Array.isArray(report.unverifiedItems) || report.unverifiedItems.length !== 0 ||
    !Array.isArray(report.observations) || report.observations.length !== 3
  ) {
    fail("drive_result_release_evidence_incomplete");
  }
  const times = report.observations.map((value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      ? Date.parse(value)
      : NaN
  );
  if (
    times.some((value) => !Number.isFinite(value)) ||
    times[0] >= times[1] || times[1] >= times[2] ||
    times[2] - times[0] < 20 * 60 * 1000
  ) {
    fail("drive_result_release_evidence_incomplete");
  }
  return eventId;
}

async function requireCheck(check, argument, code) {
  if (typeof check !== "function") fail(code);
  let passed;
  try {
    passed = await check(argument);
  } catch {
    fail(code);
  }
  if (passed !== true) fail(code);
}

async function boundedJson(response, code) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > JSON_LIMIT) {
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
      if (total > JSON_LIMIT) fail(`${code}_response_too_large`);
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail(`${code}_response_invalid`);
  }
}

async function requestJson(url, init, code, fetchImpl, allowedStatuses = [200]) {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!allowedStatuses.includes(response?.status)) fail(`${code}_http_failure`);
    return await boundedJson(response, code);
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail(`${code}_request_failed`);
  }
}

function verifyFile(file, { name, sha256, md5, size, eventId }) {
  if (
    !file || typeof file.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(file.id) ||
    file.name !== name ||
    file.mimeType !== "application/pdf" ||
    file.trashed !== false ||
    !Array.isArray(file.parents) ||
    file.parents.length !== 1 ||
    file.parents[0] !== DRIVE_RESULT_FOLDER_ID ||
    file.appProperties?.yutakasaEventId !== eventId ||
    file.appProperties?.yutakasaSha256 !== sha256 ||
    file.md5Checksum?.toLowerCase() !== md5 ||
    Number(file.size) !== size
  ) {
    fail("drive_result_file_verification_failed");
  }
  return file.id;
}

function multipart(metadata, pdfBytes) {
  const boundary = `yutakasa_${randomUUID().replaceAll("-", "")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export async function renderVerifiedResultPdf(report, {
  python = "python3",
  fontPath,
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yutakasa-result-"));
  await fs.chmod(directory, 0o700);
  const outputPath = path.join(directory, "report.pdf");
  try {
    const input = JSON.stringify(report);
    if (Buffer.byteLength(input) > 64 * 1024) fail("drive_result_report_too_large");
    await new Promise((resolve, reject) => {
      const child = spawn(python, [RENDERER, outputPath], {
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          PATH: process.env.PATH,
          ...(fontPath ? { YUTAKASA_PDF_FONT_PATH: fontPath } : {}),
        },
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), RENDER_TIMEOUT_MS);
      child.on("error", () => reject(new DriveIntakeError("drive_result_renderer_unavailable")));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new DriveIntakeError("drive_result_render_failed"));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
    const stat = await fs.lstat(outputPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
        stat.size < 100 || stat.size > PDF_LIMIT) {
      fail("drive_result_pdf_invalid");
    }
    const pdf = await fs.readFile(outputPath);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
        !pdf.subarray(-6).toString("ascii").includes("%%EOF")) {
      fail("drive_result_pdf_invalid");
    }
    return pdf;
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail("drive_result_render_failed");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// Caller must hold its durable exclusive run lease. No automatic upload path
// invokes this until OAuth and the release-evidence binding are installed.
export async function publishVerifiedDriveResult({
  report,
  credentials = process.env,
  fetchImpl = globalThis.fetch,
  renderPdf = renderVerifiedResultPdf,
  assertLease,
  assertEvidence,
  publicationLedger,
  ledgerSecrets = process.env,
} = {}) {
  if (credentials?.YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED !== "true") {
    fail("drive_result_publication_disabled");
  }
  const eventId = validateReport(report);
  await requireCheck(assertEvidence, report, "drive_result_evidence_required");
  await requireCheck(assertLease, undefined, "drive_result_lease_required");
  const ledger = publicationLedger ?? createDriveResultLedger({
    secrets: ledgerSecrets,
    fetchImpl,
  });
  if (
    typeof ledger?.reserve !== "function" ||
    typeof ledger.uncertain !== "function" ||
    typeof ledger.confirm !== "function"
  ) fail("drive_result_ledger_invalid");
  const pdf = await renderPdf(report);
  if (!Buffer.isBuffer(pdf) || pdf.length < 100 || pdf.length > PDF_LIMIT ||
      !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    fail("drive_result_pdf_invalid");
  }
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const md5 = createHash("md5").update(pdf).digest("hex");
  const date = new Date(report.completedAt);
  if (!Number.isFinite(date.getTime())) fail("drive_result_date_invalid");
  // Event ID, unlike a completion timestamp, is immutable across retries.
  // Drive permits duplicate names, so the durable event claim below is also
  // mandatory before the first POST.
  const name = `豊かさBOT_対応結果_${eventId}.pdf`;
  const expected = { name, sha256, md5, size: pdf.length, eventId };

  const token = await getDriveOAuthAccessToken({ credentials, fetchImpl });
  const headers = { Authorization: `Bearer ${token}` };
  const folderUrl = new URL(`${FILES_URL}/${DRIVE_RESULT_FOLDER_ID}`);
  folderUrl.searchParams.set("fields", "id,name,mimeType,trashed,capabilities(canAddChildren)");
  const folder = await requestJson(folderUrl.toString(), { method: "GET", headers }, "drive_result_folder", fetchImpl);
  if (
    folder?.id !== DRIVE_RESULT_FOLDER_ID ||
    folder.name !== "処理結果" ||
    folder.mimeType !== "application/vnd.google-apps.folder" ||
    folder.trashed !== false ||
    folder.capabilities?.canAddChildren !== true
  ) {
    fail("drive_result_folder_identity_or_access_invalid");
  }

  const listUrl = new URL(FILES_URL);
  listUrl.searchParams.set(
    "q",
    // Search by the deterministic name as well as verifying appProperties.
    // An OAuth client rotation may hide appProperties written by an older
    // app; finding that file by name must stop a duplicate upload.
    `'${DRIVE_RESULT_FOLDER_ID}' in parents and trashed = false and name = '${name}'`,
  );
  listUrl.searchParams.set("spaces", "drive");
  listUrl.searchParams.set("corpora", "user");
  listUrl.searchParams.set("pageSize", "100");
  listUrl.searchParams.set(
    "fields",
    "kind,nextPageToken,incompleteSearch,files(id,name,mimeType,parents,appProperties,md5Checksum,size,trashed)",
  );
  const listed = await requestJson(
    listUrl.toString(), { method: "GET", headers }, "drive_result_list", fetchImpl,
  );
  if (
    listed?.kind !== "drive#fileList" ||
    listed.incompleteSearch !== false ||
    listed.nextPageToken ||
    !Array.isArray(listed.files) ||
    listed.files.length > 1
  ) {
    fail("drive_result_list_invalid");
  }
  const reservation = await ledger.reserve({ eventId, sha256, name });
  if (!["reserved", "pending", "confirmed", "conflict"].includes(reservation)) {
    fail("drive_result_ledger_response_invalid");
  }
  if (reservation === "conflict") fail("drive_result_event_conflict");
  if (listed.files.length === 1) {
    const fileId = verifyFile(listed.files[0], expected);
    await requireCheck(assertLease, undefined, "drive_result_lease_required");
    await requireCheck(assertEvidence, report, "drive_result_evidence_required");
    if (await ledger.confirm({ eventId, sha256, fileId }) !== true) {
      fail("drive_result_ledger_confirm_failed");
    }
    return { ok: true, fileId, deduplicated: true };
  }
  if (reservation !== "reserved") fail("drive_result_publication_pending");
  await requireCheck(assertLease, undefined, "drive_result_lease_required");
  // Rendering, OAuth refresh, and Drive listing can outlive the release
  // evidence checked at entry. Recheck immediately before the only POST.
  await requireCheck(assertEvidence, report, "drive_result_evidence_required");
  const metadata = {
    name,
    mimeType: "application/pdf",
    parents: [DRIVE_RESULT_FOLDER_ID],
    appProperties: { yutakasaEventId: eventId, yutakasaSha256: sha256 },
  };
  const { body, contentType } = multipart(metadata, pdf);
  const uploadUrl = new URL(UPLOAD_URL);
  uploadUrl.searchParams.set("uploadType", "multipart");
  uploadUrl.searchParams.set(
    "fields",
    "id,name,mimeType,parents,appProperties,md5Checksum,size,trashed",
  );
  // Once reserved, any failure leaves a durable row that forbids another POST.
  // A later run may only reconcile by verifying an existing Drive file.
  try {
    const uploaded = await requestJson(
      uploadUrl.toString(),
      { method: "POST", headers: { ...headers, "Content-Type": contentType }, body },
      "drive_result_upload",
      fetchImpl,
      [200, 201],
    );
    const fileId = verifyFile(uploaded, expected);
    const getUrl = new URL(`${FILES_URL}/${fileId}`);
    getUrl.searchParams.set(
      "fields",
      "id,name,mimeType,parents,appProperties,md5Checksum,size,trashed",
    );
    const confirmed = await requestJson(
      getUrl.toString(), { method: "GET", headers }, "drive_result_readback", fetchImpl,
    );
    verifyFile(confirmed, expected);
    if (await ledger.confirm({ eventId, sha256, fileId }) !== true) {
      fail("drive_result_ledger_confirm_failed");
    }
    return { ok: true, fileId, deduplicated: false };
  } catch (error) {
    try {
      await ledger.uncertain({ eventId, sha256 });
    } catch {
      // The posting row still blocks a retry if this update is unavailable.
    }
    if (error instanceof DriveIntakeError) throw error;
    fail("drive_result_publication_failed");
  }
}
