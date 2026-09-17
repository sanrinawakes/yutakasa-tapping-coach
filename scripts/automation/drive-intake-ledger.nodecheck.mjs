import assert from "node:assert/strict";
import test from "node:test";

import { DriveIntakeError } from "./drive-intake.mjs";
import { createDriveIntakeLedger } from "./drive-intake-ledger.mjs";

const SECRETS = {
  SUPABASE_URL: "https://example-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-at-least-twenty-chars",
};
const FILE = {
  id: "opaque_file_123",
  modifiedTime: "2025-09-16T12:34:56.000Z",
  version: "17",
  name: "private-customer-filename.pdf",
  body: "private-customer-body",
};
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

function mockRpc(replies, calls = []) {
  return async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.apikey, SECRETS.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(init.headers.Authorization, `Bearer ${SECRETS.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(init.redirect, "error");
    return new Response(JSON.stringify(replies[url.split("/").at(-1)]), { status: 200 });
  };
}

test("claim, renew and finish use only fixed RPCs and metadata", async () => {
  const calls = [];
  const ledger = createDriveIntakeLedger({
    secrets: SECRETS,
    fetchImpl: mockRpc({
      claim_yutakasa_drive_intake: "acquired",
      renew_yutakasa_drive_intake: true,
      finish_yutakasa_drive_intake: true,
    }, calls),
  });
  const claimed = await ledger.claim(FILE);
  assert.equal(claimed.state, "acquired");
  assert.match(claimed.claimId, /^[0-9a-f-]{36}$/u);
  assert.equal(await ledger.renew(FILE, claimed.claimId), true);
  assert.equal(await ledger.finish(FILE, claimed.claimId, { status: "processed" }), true);
  assert.deepEqual(calls.map(([url]) => url.split("/").at(-1)), [
    "claim_yutakasa_drive_intake",
    "renew_yutakasa_drive_intake",
    "finish_yutakasa_drive_intake",
  ]);
  assert.deepEqual(Object.keys(calls[0][1]).sort(), [
    "p_claim_id", "p_drive_version", "p_file_id", "p_modified_time",
  ]);
  assert.ok(!JSON.stringify(calls).includes(FILE.name));
  assert.ok(!JSON.stringify(calls).includes(FILE.body));
  assert.equal(calls[0][1].p_drive_version, "17");
  assert.equal(calls[2][1].p_failure_code, null);
});

test("non-acquired states do not return a claim token", async () => {
  for (const state of ["busy", "processed", "needs_review", "stale", "revision_conflict"]) {
    const ledger = createDriveIntakeLedger({
      secrets: SECRETS,
      fetchImpl: mockRpc({ claim_yutakasa_drive_intake: state }),
    });
    assert.deepEqual(await ledger.claim(FILE), { state });
  }
});

test("unknown claim response cannot authorize file processing", async () => {
  const ledger = createDriveIntakeLedger({
    secrets: SECRETS,
    fetchImpl: mockRpc({ claim_yutakasa_drive_intake: "retry" }),
  });
  await assert.rejects(ledger.claim(FILE), (error) =>
    error instanceof DriveIntakeError && error.code === "drive_intake_ledger_response_invalid");
});

test("claim rejects malformed identity and revision before network", async () => {
  let calls = 0;
  const ledger = createDriveIntakeLedger({
    secrets: SECRETS,
    fetchImpl: async () => { calls += 1; },
  });
  for (const file of [
    { ...FILE, id: "wrong/id" },
    { ...FILE, modifiedTime: "2025-09-16T12:34:56.123456Z" },
    { ...FILE, modifiedTime: "2025-02-30T12:34:56.000Z" },
    { ...FILE, version: "17-private" },
  ]) {
    await assert.rejects(ledger.claim(file), (error) =>
      error instanceof DriveIntakeError && error.code === "drive_intake_ledger_file_invalid");
  }
  assert.equal(calls, 0);
});

test("equivalent valid RFC3339 timestamps become one revision key", async () => {
  const calls = [];
  const ledger = createDriveIntakeLedger({
    secrets: SECRETS,
    fetchImpl: mockRpc({ claim_yutakasa_drive_intake: "processed" }, calls),
  });
  await ledger.claim({ ...FILE, modifiedTime: "2025-09-16T12:34:56Z" });
  await ledger.claim({ ...FILE, modifiedTime: "2025-09-16T12:34:56.000Z" });
  assert.equal(calls[0][1].p_modified_time, "2025-09-16T12:34:56.000Z");
  assert.equal(calls[1][1].p_modified_time, calls[0][1].p_modified_time);
});

test("finish requires fixed review reason and valid claim token", async () => {
  let calls = 0;
  const ledger = createDriveIntakeLedger({
    secrets: SECRETS,
    fetchImpl: async () => { calls += 1; },
  });
  await assert.rejects(ledger.finish(FILE, CLAIM_ID, {
    status: "needs_review", failureCode: FILE.body,
  }), (error) => error instanceof DriveIntakeError &&
    error.code === "drive_intake_ledger_finish_invalid" &&
    !error.message.includes(FILE.body));
  await assert.rejects(ledger.renew(FILE, "not-a-uuid"), (error) =>
    error instanceof DriveIntakeError && error.code === "drive_intake_ledger_claim_invalid");
  assert.equal(calls, 0);
});

test("missing service credentials fail before network", () => {
  assert.throws(() => createDriveIntakeLedger({
    secrets: { SUPABASE_URL: SECRETS.SUPABASE_URL },
    fetchImpl: async () => assert.fail("network should not run"),
  }), (error) => error instanceof DriveIntakeError &&
    error.code === "drive_intake_ledger_config_invalid");
});

test("ambiguous RPC failure has a fixed error without customer data", async () => {
  const ledger = createDriveIntakeLedger({
    secrets: SECRETS,
    fetchImpl: async () => { throw new Error(FILE.body); },
  });
  await assert.rejects(ledger.claim(FILE), (error) =>
    error instanceof DriveIntakeError &&
    error.code === "drive_intake_ledger_rpc_failed" &&
    !error.message.includes(FILE.body));
});
