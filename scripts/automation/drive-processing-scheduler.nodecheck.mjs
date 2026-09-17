import assert from "node:assert/strict";
import test from "node:test";

import { DriveIntakeError, DRIVE_INTAKE_FOLDER_ID } from "./drive-intake.mjs";
import { driveResultEventId } from "./drive-intake-runtime.mjs";
import { processScheduledDriveIntake } from "./drive-processing-scheduler.mjs";

const SECRETS = {
  YUTAKASA_DRIVE_SCHEDULED_ENABLED: "true",
  YUTAKASA_DRIVE_PROCESSING_ENABLED: "true",
  YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED: "true",
};
const FILES = ["unbound_file", "bound_file", "later_file"].map((id) => ({
  id, name: `${id}.pdf`, mimeType: "application/pdf",
  modifiedTime: "2026-09-17T02:00:00.000Z", version: "42", size: "100",
}));
const SNAPSHOT = {
  schemaVersion: 1, trust: "untrusted_drive_metadata",
  folderId: DRIVE_INTAKE_FOLDER_ID, files: FILES,
};

test("scheduled processing is disabled before metadata, binding, or content reads", async () => {
  let calls = 0;
  await assert.rejects(processScheduledDriveIntake({
    secrets: { ...SECRETS, YUTAKASA_DRIVE_SCHEDULED_ENABLED: undefined },
    assertLease: async () => { calls += 1; return true; },
    snapshotImpl: async () => { calls += 1; },
    adapterImpl: () => { calls += 1; },
    processImpl: async () => { calls += 1; },
  }), (error) => error instanceof DriveIntakeError && error.code === "drive_schedule_disabled");
  assert.equal(calls, 0);
});

test("unbound revisions are not claimed or read; one verified file is processed", async () => {
  const events = [];
  const result = await processScheduledDriveIntake({
    secrets: SECRETS,
    assertLease: async () => { events.push("lease"); return true; },
    snapshotImpl: async () => SNAPSHOT,
    adapterImpl: () => ({
      inspectVerifiedBinding: async (key) => {
        events.push(`inspect:${key.fileId}`);
        assert.equal(key.eventId,
          driveResultEventId(FILES.find((file) => file.id === key.fileId)));
        return key.fileId === "unbound_file" ? null :
          { eventId: key.eventId, contentSha256: "a".repeat(64) };
      },
      loadVerifiedResult: async () => {},
      verifyReleaseEvidence: async () => true,
    }),
    processImpl: async ({ snapshot, assertLease, credentials }) => {
      events.push(`process:${snapshot.files[0].id}`);
      assert.equal(credentials, SECRETS);
      assert.equal(await assertLease(), true);
      assert.equal(snapshot.files.length, 1);
      return { processed: 1, alreadyProcessed: 0, blocked: 0 };
    },
  });
  assert.deepEqual(result, {
    scanned: 3, unbound: 1, processed: 1, alreadyProcessed: 0,
    blocked: 0, deferred: 1,
  });
  assert.ok(events.includes("inspect:unbound_file"));
  assert.ok(events.includes("process:bound_file"));
  assert.ok(!events.includes("inspect:later_file"));
  assert.ok(!events.includes("process:unbound_file"));
});

test("processed revisions can be skipped to reach a later verified revision", async () => {
  const touched = [];
  const result = await processScheduledDriveIntake({
    secrets: SECRETS, assertLease: async () => true,
    snapshotImpl: async () => ({ ...SNAPSHOT, files: FILES.slice(1) }),
    adapterImpl: () => ({
      inspectVerifiedBinding: async (key) => ({
        eventId: key.eventId, contentSha256: "a".repeat(64),
      }),
      loadVerifiedResult: async () => {}, verifyReleaseEvidence: async () => true,
    }),
    processImpl: async ({ snapshot }) => {
      touched.push(snapshot.files[0].id);
      return snapshot.files[0].id === "bound_file"
        ? { processed: 0, alreadyProcessed: 1, blocked: 0 }
        : { processed: 1, alreadyProcessed: 0, blocked: 0 };
    },
  });
  assert.deepEqual(touched, ["bound_file", "later_file"]);
  assert.equal(result.processed, 1);
  assert.equal(result.alreadyProcessed, 1);
});

test("missing Drive version and lost monitor lease stop before claim or content", async () => {
  let processing = 0;
  const adapterImpl = () => ({
    inspectVerifiedBinding: async (key) => ({
      eventId: key.eventId, contentSha256: "a".repeat(64),
    }),
    loadVerifiedResult: async () => {}, verifyReleaseEvidence: async () => true,
  });
  await assert.rejects(processScheduledDriveIntake({
    secrets: SECRETS, assertLease: async () => true, adapterImpl,
    snapshotImpl: async () => ({ ...SNAPSHOT, files: [{ ...FILES[0], version: undefined }] }),
    processImpl: async () => { processing += 1; },
  }), (error) => error instanceof DriveIntakeError &&
    error.code === "drive_schedule_version_missing");
  let checks = 0;
  await assert.rejects(processScheduledDriveIntake({
    secrets: SECRETS,
    assertLease: async () => { checks += 1; return checks < 2; },
    adapterImpl, snapshotImpl: async () => ({ ...SNAPSHOT, files: [FILES[1]] }),
    processImpl: async () => { processing += 1; },
  }), (error) => error instanceof DriveIntakeError &&
    error.code === "drive_schedule_monitor_lease_lost");
  assert.equal(processing, 0);
});
