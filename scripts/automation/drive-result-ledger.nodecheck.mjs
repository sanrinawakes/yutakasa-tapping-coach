import assert from "node:assert/strict";
import test from "node:test";

import { DriveIntakeError } from "./drive-intake.mjs";
import { createDriveResultLedger } from "./drive-result-ledger.mjs";

const SECRETS = {
  SUPABASE_URL: "https://example-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-at-least-twenty-chars",
};

function mockRpc(replies, onCall = () => {}) {
  return async (url, init) => {
    onCall(url, init);
    const name = url.split("/").at(-1);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.apikey, SECRETS.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(init.headers.Authorization, `Bearer ${SECRETS.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(init.redirect, "error");
    return new Response(JSON.stringify(replies[name]), { status: 200 });
  };
}

test("reserve, uncertain and confirm use only fixed service-role RPCs", async () => {
  const calls = [];
  const ledger = createDriveResultLedger({
    secrets: SECRETS,
    fetchImpl: mockRpc({
      reserve_yutakasa_drive_result: "reserved",
      mark_yutakasa_drive_result_uncertain: true,
      confirm_yutakasa_drive_result: true,
    }, (url, init) => calls.push([url, JSON.parse(init.body)])),
  });
  const input = {
    eventId: "release_123456",
    sha256: "a".repeat(64),
    name: "豊かさBOT_対応結果_release_123456.pdf",
  };
  assert.equal(await ledger.reserve(input), "reserved");
  assert.equal(await ledger.uncertain(input), true);
  assert.equal(await ledger.confirm({ ...input, fileId: "drive_file_123" }), true);
  assert.deepEqual(calls.map(([url]) => url.split("/").at(-1)), [
    "reserve_yutakasa_drive_result",
    "mark_yutakasa_drive_result_uncertain",
    "confirm_yutakasa_drive_result",
  ]);
  assert.deepEqual(calls[0][1], {
    p_event_id: input.eventId,
    p_pdf_sha256: input.sha256,
    p_file_name: input.name,
  });
  assert.deepEqual(calls[2][1], {
    p_event_id: input.eventId,
    p_pdf_sha256: input.sha256,
    p_file_id: "drive_file_123",
  });
});

test("missing service credentials fail before network", () => {
  assert.throws(
    () => createDriveResultLedger({
      secrets: { SUPABASE_URL: SECRETS.SUPABASE_URL },
      fetchImpl: async () => assert.fail("network should not run"),
    }),
    (error) => error instanceof DriveIntakeError &&
      error.code === "drive_result_ledger_config_invalid",
  );
});

test("unrecognized reservation response cannot authorize a POST", async () => {
  const ledger = createDriveResultLedger({
    secrets: SECRETS,
    fetchImpl: mockRpc({ reserve_yutakasa_drive_result: "retry" }),
  });
  await assert.rejects(
    ledger.reserve({
      eventId: "release_123456",
      sha256: "a".repeat(64),
      name: "豊かさBOT_対応結果_release_123456.pdf",
    }),
    (error) => error instanceof DriveIntakeError &&
      error.code === "drive_result_ledger_response_invalid",
  );
});
