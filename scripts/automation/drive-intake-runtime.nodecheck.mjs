import assert from "node:assert/strict";
import test from "node:test";

import { DRIVE_INTAKE_FOLDER_ID, DriveIntakeError } from "./drive-intake.mjs";
import { driveResultEventId, processVerifiedDriveIntake } from "./drive-intake-runtime.mjs";

const FILE = {
  id: "opaque_file_123",
  name: "private-customer-name.pdf",
  mimeType: "application/pdf",
  modifiedTime: "2026-09-17T02:00:00.000Z",
  version: "42",
};
const SNAPSHOT = {
  schemaVersion: 1,
  trust: "untrusted_drive_metadata",
  folderId: DRIVE_INTAKE_FOLDER_ID,
  observedAt: "2026-09-17T02:05:00.000Z",
  files: [FILE],
};
const CREDENTIALS = {
  YUTAKASA_DRIVE_PROCESSING_ENABLED: "true",
  YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED: "true",
};
const HASH = "a".repeat(64);
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = driveResultEventId(FILE);
const REPORT = { eventId: EVENT_ID };

test("a changed Drive version gets a distinct immutable result event", () => {
  assert.notEqual(
    driveResultEventId({ ...FILE, version: "42" }),
    driveResultEventId({ ...FILE, version: "43" }),
  );
  const withoutVersion = { ...FILE };
  delete withoutVersion.version;
  assert.notEqual(driveResultEventId(withoutVersion), driveResultEventId(FILE));
});

function fakeLedger(state = "acquired") {
  const calls = [];
  return {
    calls,
    async claim(file) {
      calls.push(["claim", file.id]);
      return state === "acquired" ? { state, claimId: CLAIM_ID } : { state };
    },
    async renew(file, claimId) {
      calls.push(["renew", file.id, claimId]);
      return true;
    },
    async finish(file, claimId, result) {
      calls.push(["finish", file.id, claimId, result]);
      return true;
    },
  };
}

function harness(overrides = {}) {
  const ledger = fakeLedger();
  const calls = [];
  return {
    ledger,
    calls,
    args: {
      snapshot: SNAPSHOT,
      credentials: CREDENTIALS,
      ledger,
      assertLease: async () => true,
      readContent: async ({ file }) => {
        calls.push(["read", file.id]);
        return { fileId: file.id, sha256: HASH, bytes: Buffer.from("private body") };
      },
      loadVerifiedResult: async (key) => {
        calls.push(["load", key]);
        return { ...key, report: REPORT };
      },
      verifyReleaseEvidence: async (key) => {
        calls.push(["verify", key]);
        return true;
      },
      publishResult: async ({ report, assertLease, assertEvidence }) => {
        calls.push(["publish", report.eventId]);
        assert.equal(await assertEvidence(report), true);
        assert.equal(await assertLease(), true);
        return { ok: true, fileId: "opaque_result_1" };
      },
      heartbeatMs: 10,
      ...overrides,
    },
  };
}

async function expectCode(fn, code) {
  await assert.rejects(fn, (error) =>
    error instanceof DriveIntakeError &&
    error.code === code &&
    !error.message.includes(FILE.name));
}

test("disabled and incomplete caller cannot claim or read customer files", async () => {
  const { args, ledger } = harness();
  await expectCode(() => processVerifiedDriveIntake({
    ...args, credentials: { ...CREDENTIALS, YUTAKASA_DRIVE_PROCESSING_ENABLED: "false" },
  }), "drive_runtime_disabled");
  await expectCode(() => processVerifiedDriveIntake({
    ...args, loadVerifiedResult: undefined,
  }), "drive_runtime_contract_missing");
  assert.deepEqual(ledger.calls, []);
});

test("verified binding and evidence are required before one publication", async () => {
  const { args, ledger, calls } = harness();
  assert.deepEqual(await processVerifiedDriveIntake(args), {
    processed: 1, alreadyProcessed: 0, blocked: 0,
  });
  assert.deepEqual(calls.map(([name]) => name), ["read", "load", "publish", "verify"]);
  assert.equal(calls[1][1].contentSha256, HASH);
  assert.equal(calls[1][1].eventId, EVENT_ID);
  assert.ok(!JSON.stringify(calls[1]).includes(FILE.name));
  assert.ok(!JSON.stringify(calls[1]).includes("private body"));
  assert.deepEqual(ledger.calls.at(-1), [
    "finish", FILE.id, CLAIM_ID, { status: "processed" },
  ]);
});

test("non-owner claim states cannot fetch content or publish", async () => {
  for (const state of ["processed", "busy", "needs_review", "stale", "revision_conflict"]) {
    const { args, calls } = harness({ ledger: fakeLedger(state) });
    const result = await processVerifiedDriveIntake(args);
    assert.equal(result.processed, 0);
    assert.equal(result.alreadyProcessed, state === "processed" ? 1 : 0);
    assert.equal(result.blocked, state === "processed" ? 0 : 1);
    assert.deepEqual(calls, []);
  }
});

test("release record for another revision becomes review without upload", async () => {
  const { args, ledger, calls } = harness({
    loadVerifiedResult: async (key) => ({ ...key, contentSha256: "b".repeat(64), report: REPORT }),
  });
  await expectCode(() => processVerifiedDriveIntake(args), "drive_runtime_release_binding_invalid");
  assert.equal(calls.some(([name]) => name === "publish"), false);
  assert.deepEqual(ledger.calls.at(-1), [
    "finish", FILE.id, CLAIM_ID,
    { status: "needs_review", failureCode: "processing_failed" },
  ]);
});

test("release record with a different Drive version cannot publish", async () => {
  const versioned = { ...FILE, version: "42" };
  const { args, ledger, calls } = harness({
    snapshot: { ...SNAPSHOT, files: [versioned] },
    loadVerifiedResult: async (key) => ({
      ...key, driveVersion: "41",
      report: { eventId: driveResultEventId(versioned) },
    }),
  });
  await expectCode(() => processVerifiedDriveIntake(args),
    "drive_runtime_release_binding_invalid");
  assert.equal(calls.some(([name]) => name === "publish"), false);
  assert.deepEqual(ledger.calls.at(-1)[3], {
    status: "needs_review", failureCode: "processing_failed",
  });
});

test("source changed while reading uses fixed review reason", async () => {
  const { args, ledger } = harness({
    readContent: async () => {
      throw new DriveIntakeError("drive_intake_content_checksum_mismatch");
    },
  });
  await expectCode(() => processVerifiedDriveIntake(args),
    "drive_intake_content_checksum_mismatch");
  assert.deepEqual(ledger.calls.at(-1), [
    "finish", FILE.id, CLAIM_ID,
    { status: "needs_review", failureCode: "source_changed" },
  ]);
});

test("ambiguous publication never marks the source processed", async () => {
  const { args, ledger } = harness({
    publishResult: async () => { throw new Error("private body"); },
  });
  await expectCode(() => processVerifiedDriveIntake(args), "drive_runtime_processing_failed");
  assert.deepEqual(ledger.calls.at(-1), [
    "finish", FILE.id, CLAIM_ID,
    { status: "needs_review", failureCode: "external_outcome_unknown" },
  ]);
});

test("lost file lease blocks publication and completion", async () => {
  const { args, ledger } = harness();
  let renews = 0;
  ledger.renew = async () => { renews += 1; return false; };
  await expectCode(() => processVerifiedDriveIntake(args), "drive_runtime_file_lease_lost");
  assert.ok(renews >= 1);
  assert.equal(ledger.calls.some(([name]) => name === "finish"), false);
});

test("monitor lease loss after PDF readback blocks processed completion", async () => {
  let checks = 0;
  const { args, ledger } = harness({
    assertLease: async () => { checks += 1; return checks < 6; },
  });
  await expectCode(() => processVerifiedDriveIntake(args),
    "drive_runtime_monitor_lease_lost");
  assert.equal(ledger.calls.some(([name]) => name === "finish"), false);
});

test("duplicate file IDs and invalid snapshots fail before a claim", async () => {
  const { args, ledger } = harness();
  await expectCode(() => processVerifiedDriveIntake({
    ...args, snapshot: { ...SNAPSHOT, files: [FILE, FILE] },
  }), "drive_runtime_duplicate_file");
  await expectCode(() => processVerifiedDriveIntake({
    ...args, snapshot: { ...SNAPSHOT, folderId: "wrong-folder" },
  }), "drive_runtime_snapshot_invalid");
  const withoutVersion = { ...FILE };
  delete withoutVersion.version;
  await expectCode(() => processVerifiedDriveIntake({
    ...args, snapshot: { ...SNAPSHOT, files: [withoutVersion] },
  }), "drive_runtime_file_version_missing");
  assert.deepEqual(ledger.calls, []);
});

test("heartbeat renews a slow evidence lookup", async () => {
  const { args, ledger } = harness({
    loadVerifiedResult: async (key) => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return { ...key, report: REPORT };
    },
  });
  await processVerifiedDriveIntake(args);
  assert.ok(ledger.calls.filter(([name]) => name === "renew").length >= 3);
});
