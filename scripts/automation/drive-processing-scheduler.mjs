import { DRIVE_INTAKE_FOLDER_ID, DriveIntakeError, collectDriveIntakeMetadata } from "./drive-intake.mjs";
import { driveResultEventId, processVerifiedDriveIntake } from "./drive-intake-runtime.mjs";
import { createDriveReleaseEvidenceAdapter } from "./drive-release-binding.mjs";

const MAX_FILES = 100;

function fail(code) {
  throw new DriveIntakeError(code);
}

async function requireLease(assertLease) {
  try {
    if (await assertLease() !== true) fail("drive_schedule_monitor_lease_lost");
  } catch {
    fail("drive_schedule_monitor_lease_lost");
  }
}

function checkedSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 ||
      snapshot.trust !== "untrusted_drive_metadata" ||
      snapshot.folderId !== DRIVE_INTAKE_FOLDER_ID ||
      !Array.isArray(snapshot.files) || snapshot.files.length > MAX_FILES) {
    fail("drive_schedule_snapshot_invalid");
  }
  const seen = new Set();
  for (const file of snapshot.files) {
    if (!file || typeof file.version !== "string" ||
        !/^[0-9]{1,20}$/u.test(file.version)) fail("drive_schedule_version_missing");
    driveResultEventId(file);
    if (seen.has(file.id)) fail("drive_schedule_duplicate_file");
    seen.add(file.id);
  }
  return snapshot.files;
}

// Called only from the existing scheduled monitor while it owns the global
// lease. A file without an owner-verified binding is not claimed or read.
// One new file at most is processed per tick; processed revisions may be
// rechecked by the idempotent claim and cannot issue a second publication.
export async function processScheduledDriveIntake({
  secrets = process.env,
  assertLease,
  snapshotImpl = collectDriveIntakeMetadata,
  adapterImpl = createDriveReleaseEvidenceAdapter,
  processImpl = processVerifiedDriveIntake,
} = {}) {
  if (secrets?.YUTAKASA_DRIVE_SCHEDULED_ENABLED !== "true" ||
      secrets?.YUTAKASA_DRIVE_PROCESSING_ENABLED !== "true" ||
      secrets?.YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED !== "true") {
    fail("drive_schedule_disabled");
  }
  if (typeof assertLease !== "function" || typeof snapshotImpl !== "function" ||
      typeof adapterImpl !== "function" || typeof processImpl !== "function") {
    fail("drive_schedule_contract_missing");
  }
  await requireLease(assertLease);
  const adapter = adapterImpl({ secrets });
  if (typeof adapter?.inspectVerifiedBinding !== "function" ||
      typeof adapter.loadVerifiedResult !== "function" ||
      typeof adapter.verifyReleaseEvidence !== "function") {
    fail("drive_schedule_contract_missing");
  }
  const snapshot = await snapshotImpl({ credentials: secrets });
  const files = checkedSnapshot(snapshot);
  const summary = {
    scanned: files.length, unbound: 0, processed: 0,
    alreadyProcessed: 0, blocked: 0, deferred: 0,
  };
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    await requireLease(assertLease);
    const key = {
      fileId: file.id, modifiedTime: file.modifiedTime,
      driveVersion: file.version, eventId: driveResultEventId(file),
    };
    const bound = await adapter.inspectVerifiedBinding(key);
    if (bound === null) {
      summary.unbound += 1;
      continue;
    }
    if (bound?.eventId !== key.eventId ||
        !/^[a-f0-9]{64}$/u.test(bound.contentSha256 ?? "")) {
      fail("drive_schedule_binding_invalid");
    }
    await requireLease(assertLease);
    const result = await processImpl({
      snapshot: { ...snapshot, files: [file] },
      credentials: secrets,
      ledgerSecrets: secrets,
      assertLease,
      loadVerifiedResult: adapter.loadVerifiedResult,
      verifyReleaseEvidence: adapter.verifyReleaseEvidence,
    });
    if (!result || ["processed", "alreadyProcessed", "blocked"].some((name) =>
      !Number.isSafeInteger(result[name]) || result[name] < 0 || result[name] > 1) ||
      result.processed + result.alreadyProcessed + result.blocked !== 1) {
      fail("drive_schedule_result_invalid");
    }
    summary.processed += result.processed;
    summary.alreadyProcessed += result.alreadyProcessed;
    summary.blocked += result.blocked;
    if (result.processed === 1) {
      summary.deferred = files.length - index - 1;
      break;
    }
  }
  return summary;
}
