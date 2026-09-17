import { createHash } from "node:crypto";

import { DRIVE_INTAKE_FOLDER_ID, DriveIntakeError } from "./drive-intake.mjs";
import { fetchDriveIntakeContent } from "./drive-intake-content.mjs";
import { createDriveIntakeLedger } from "./drive-intake-ledger.mjs";
import { publishVerifiedDriveResult } from "./drive-result.mjs";

const HEARTBEAT_MS = 30_000;
const SOURCE_CHANGED = new Set([
  "drive_intake_content_metadata_mismatch",
  "drive_intake_content_changed_during_export",
  "drive_intake_content_checksum_mismatch",
]);

function fail(code) {
  throw new DriveIntakeError(code);
}

function checkedFile(file, requireVersion = false) {
  if (!file || typeof file !== "object" ||
      typeof file.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(file.id) ||
      typeof file.name !== "string" || file.name.length < 1 || file.name.length > 1024 ||
      typeof file.mimeType !== "string" || file.mimeType.length < 1 || file.mimeType.length > 256 ||
      (file.version !== undefined &&
        (typeof file.version !== "string" || !/^[0-9]{1,20}$/u.test(file.version))) ||
      typeof file.modifiedTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(file.modifiedTime) ||
      !Number.isFinite(Date.parse(file.modifiedTime))) {
    fail("drive_runtime_file_invalid");
  }
  if (requireVersion && file.version === undefined) {
    fail("drive_runtime_file_version_missing");
  }
  return file;
}

function checkedSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 ||
      snapshot.trust !== "untrusted_drive_metadata" ||
      snapshot.folderId !== DRIVE_INTAKE_FOLDER_ID ||
      !Array.isArray(snapshot.files) || snapshot.files.length > 100_000) {
    fail("drive_runtime_snapshot_invalid");
  }
  const seen = new Set();
  for (const file of snapshot.files) {
    checkedFile(file, true);
    if (seen.has(file.id)) fail("drive_runtime_duplicate_file");
    seen.add(file.id);
  }
  return snapshot.files;
}

// Stable across retries, independent of the customer's filename and content.
export function driveResultEventId(file) {
  checkedFile(file);
  return "drive_" + createHash("sha256")
    .update(JSON.stringify([
      file.id, new Date(file.modifiedTime).toISOString(),
      ...(file.version === undefined ? [] : [file.version]),
    ]))
    .digest("hex").slice(0, 32);
}

async function requireLease(check, code) {
  try {
    if (await check() !== true) fail(code);
  } catch {
    fail(code);
  }
}

function heartbeat({ assertLease, ledger, file, claimId, intervalMs }) {
  let stopped = false;
  let failed = false;
  let running = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped || failed) return;
    running = running.then(async () => {
      try {
        await requireLease(assertLease, "drive_runtime_monitor_lease_lost");
        if (await ledger.renew(file, claimId) !== true) failed = true;
      } catch {
        failed = true;
      }
    });
  }, intervalMs);
  timer.unref?.();
  return {
    async assertOwned() {
      if (failed) fail("drive_runtime_file_lease_lost");
      await requireLease(assertLease, "drive_runtime_monitor_lease_lost");
      if (await ledger.renew(file, claimId) !== true) fail("drive_runtime_file_lease_lost");
      if (failed) fail("drive_runtime_file_lease_lost");
      return true;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
      return !failed;
    },
  };
}

// Deliberately has no CLI or scheduled entry point. The release record loader
// must be implemented against authoritative ticket/release evidence before a
// production caller can use this. It receives only an opaque ID and hash, never
// the customer's bytes or filename.
export async function processVerifiedDriveIntake({
  snapshot,
  credentials = process.env,
  ledgerSecrets = process.env,
  assertLease,
  loadVerifiedResult,
  verifyReleaseEvidence,
  ledger,
  readContent = fetchDriveIntakeContent,
  publishResult = publishVerifiedDriveResult,
  heartbeatMs = HEARTBEAT_MS,
} = {}) {
  if (credentials?.YUTAKASA_DRIVE_PROCESSING_ENABLED !== "true" ||
      credentials?.YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED !== "true") {
    fail("drive_runtime_disabled");
  }
  if (typeof assertLease !== "function" ||
      typeof loadVerifiedResult !== "function" ||
      typeof verifyReleaseEvidence !== "function" ||
      typeof readContent !== "function" ||
      typeof publishResult !== "function" ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 ||
      heartbeatMs > HEARTBEAT_MS) {
    fail("drive_runtime_contract_missing");
  }
  const files = checkedSnapshot(snapshot);
  const intakeLedger = ledger ?? createDriveIntakeLedger({ secrets: ledgerSecrets });
  if (typeof intakeLedger.claim !== "function" ||
      typeof intakeLedger.renew !== "function" ||
      typeof intakeLedger.finish !== "function") {
    fail("drive_runtime_contract_missing");
  }
  const summary = { processed: 0, alreadyProcessed: 0, blocked: 0 };
  for (const file of files) {
    await requireLease(assertLease, "drive_runtime_monitor_lease_lost");
    const claimed = await intakeLedger.claim(file);
    if (claimed?.state === "processed") {
      summary.alreadyProcessed += 1;
      continue;
    }
    if (claimed?.state !== "acquired") {
      if (!["busy", "needs_review", "stale", "revision_conflict"].includes(claimed?.state)) {
        fail("drive_runtime_claim_invalid");
      }
      summary.blocked += 1;
      continue;
    }
    if (typeof claimed.claimId !== "string") fail("drive_runtime_claim_invalid");
    const guard = heartbeat({ assertLease, ledger: intakeLedger, file, claimId: claimed.claimId,
      intervalMs: heartbeatMs });
    let publicationStarted = false;
    let caught;
    try {
      await guard.assertOwned();
      const content = await readContent({ file, credentials });
      if (content?.fileId !== file.id ||
          typeof content.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(content.sha256)) {
        fail("drive_runtime_content_invalid");
      }
      const eventId = driveResultEventId(file);
      const binding = await loadVerifiedResult({
        fileId: file.id, modifiedTime: file.modifiedTime,
        driveVersion: file.version ?? null,
        contentSha256: content.sha256, eventId,
      });
      if (binding?.contentSha256 !== content.sha256 ||
          binding?.fileId !== file.id ||
          binding?.modifiedTime !== file.modifiedTime ||
          binding?.driveVersion !== (file.version ?? null) ||
          binding?.report?.eventId !== eventId) {
        fail("drive_runtime_release_binding_invalid");
      }
      await guard.assertOwned();
      publicationStarted = true;
      const publication = await publishResult({
        report: binding.report, credentials, ledgerSecrets,
        assertLease: () => guard.assertOwned(),
        assertEvidence: async (report) => {
          if (report !== binding.report) return false;
          try {
            return await verifyReleaseEvidence({
              fileId: file.id, modifiedTime: file.modifiedTime,
              driveVersion: file.version ?? null,
              contentSha256: content.sha256, eventId, report,
            }) === true;
          } catch {
            return false;
          }
        },
      });
      if (publication?.ok !== true ||
          typeof publication.fileId !== "string" ||
          !/^[A-Za-z0-9_-]{1,200}$/u.test(publication.fileId)) {
        fail("drive_runtime_publication_invalid");
      }
      await guard.assertOwned();
      if (await verifyReleaseEvidence({
        fileId: file.id, modifiedTime: file.modifiedTime,
        driveVersion: file.version ?? null,
        contentSha256: content.sha256, eventId, report: binding.report,
      }) !== true) {
        fail("drive_runtime_release_evidence_expired");
      }
      if (await guard.stop() !== true) fail("drive_runtime_file_lease_lost");
      await requireLease(assertLease, "drive_runtime_monitor_lease_lost");
      if (await intakeLedger.finish(file, claimed.claimId, { status: "processed" }) !== true) {
        fail("drive_runtime_finish_unconfirmed");
      }
      summary.processed += 1;
    } catch (error) {
      caught = error;
      const owned = await guard.stop();
      if (owned) {
        const failureCode = SOURCE_CHANGED.has(error?.code)
          ? "source_changed"
          : publicationStarted ? "external_outcome_unknown" : "processing_failed";
        try {
          await guard.assertOwned();
          await intakeLedger.finish(file, claimed.claimId, {
            status: "needs_review", failureCode,
          });
        } catch {
          // Expiry leaves the claim blocked until the next claim marks review.
        }
      }
    }
    if (caught) {
      if (caught instanceof DriveIntakeError) throw caught;
      fail("drive_runtime_processing_failed");
    }
  }
  return summary;
}
