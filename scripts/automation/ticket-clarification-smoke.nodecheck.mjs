import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runClarificationSmoke, runCleanupOnly } from "./ticket-clarification-smoke.mjs";

const SHA = "a".repeat(40);
const DEPLOYMENT = "dpl_TestClarification123456789";
const RUN = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const LOCK = "33333333-3333-4333-8333-333333333333";
const TICKET = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const SYSTEM = "66666666-6666-4666-8666-666666666666";
const REPLY_ID = "77777777-7777-4777-8777-777777777777";
const VERSION = "2026-09-17T09:00:00.000Z";
const EMAIL = `yutakasa-auto-smoke+${RUN}@example.invalid`;
const ACK = "お問い合わせを受け付けました。内容を確認して対応します。調査内容によっては2〜3日かかる場合があります。対応後、この画面でご連絡します。";
const REPLY = "お問い合わせありがとうございます。状況を確認するため、問題が起きた画面、直前に行った操作、表示されたエラー文（あれば）、発生した日時を教えてください。パスワードや認証コードは送らないでください。";
const ENV = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach",
  GITHUB_REF: "refs/heads/main", GITHUB_SHA: SHA,
  SUPABASE_URL: "https://fixture.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "s".repeat(40), JWT_SECRET: "j".repeat(40),
  VERCEL_TOKEN: "v".repeat(40),
};
const deployment = async () => ({ ready: true, mainSha: SHA, deploymentId: DEPLOYMENT });

function response(status, data) {
  return { status, text: async () => JSON.stringify(data) };
}

function fixture({ flagEnabled = true, replyCreated = true, cleanupFails = false } = {}) {
  const state = { account: false, ticket: false, claimed: false, clarified: false,
    cleanupCalls: 0, appCalls: [], dbWrites: [], cleanupFails, saved: null };
  const stateStore = {
    save(runId, requestId) { state.saved = { runId, requestId }; },
    read() { return state.saved; },
    remove() { state.saved = null; },
  };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.hostname === "fixture.supabase.co") {
      const table = url.pathname.replace(/^\/rest\/v1\//u, "");
      if (init.method === "POST") state.dbWrites.push(table);
      if (table === "rpc/cleanup_yutakasa_ticket_clarification_smoke") {
        state.cleanupCalls += 1;
        assert.deepEqual(body, { p_run_id: RUN, p_client_request_id: REQUEST });
        if (state.cleanupFails && state.account) return response(409, { code: "P0001" });
        const cleaned = state.account;
        state.account = false;
        state.ticket = false;
        state.claimed = false;
        state.clarified = false;
        return response(200, [{ cleaned, ticket_id: cleaned ? TICKET : null }]);
      }
      if (table === "subscribers") {
        if (init.method === "POST") {
          assert.equal(body.email, EMAIL);
          assert.equal(body.myasp_data.automation_test_identity,
            "yutakasa-clarification-smoke-v1");
          state.account = true;
          return response(201, [{ id: RUN, ...body }]);
        }
        return response(200, state.account ? [{ id: RUN }] : []);
      }
      if (table === "rpc/append_yutakasa_ticket_clarification") {
        assert.equal(body.p_ticket_id, TICKET);
        assert.equal(body.p_latest_user_message_id, USER);
        assert.equal(body.p_ticket_version, VERSION);
        return response(200, [{ created: false, message_id: REPLY_ID }]);
      }
      if (!state.ticket) return response(200, []);
      switch (table) {
        case "support_tickets": return response(200, [{
          id: TICKET, user_email: EMAIL, status: "waiting_user",
          automation_status: "completed", automation_lock_token: null,
          decision_required: false,
        }]);
        case "support_messages": return response(200, [
          { id: USER, sender_type: "user", sender_email: EMAIL, body: "使えない" },
          { id: SYSTEM, sender_type: "system", sender_email: null, body: ACK },
          { id: REPLY_ID, sender_type: "admin", sender_email: null, body: REPLY },
        ]);
        case "support_work_logs": return response(200, [
          { event_type: "automation_claimed", metadata: {} },
          { event_type: "automation_clarification_sent",
            metadata: { message_id: REPLY_ID, latest_user_message_id: USER } },
        ]);
        case "yutakasa_ticket_clarifications": return response(200, [{
          ticket_id: TICKET, latest_user_message_id: USER, reply_message_id: REPLY_ID,
        }]);
        default: return response(200, []);
      }
    }
    assert.equal(url.origin, "https://yutakasa-tapping-coach.vercel.app");
    state.appCalls.push(`${init.method} ${url.pathname}`);
    if (url.pathname === "/api/support/tickets") {
      assert.equal(body.category, "technical");
      assert.equal(body.subject, "使えない");
      assert.equal(body.body, "使えない");
      assert.equal(body.clientRequestId, REQUEST);
      assert.ok(init.headers.Cookie.startsWith("session="));
      state.ticket = true;
      return response(201, { created: true, ticket_id: TICKET, message_id: USER });
    }
    if (init.method === "GET") {
      assert.equal(url.searchParams.get("ticketId"), TICKET);
      assert.equal(init.headers["x-automation-lock-token"], LOCK);
      return response(200, {
        ticket: { id: TICKET, automation_lock_token: LOCK,
          subject: "使えない", updated_at: VERSION },
        messages: [
          { id: USER, sender_type: "user", body: "使えない" },
          { id: SYSTEM, sender_type: "system", body: ACK },
        ],
      });
    }
    if (body.action === "clarify" && !state.ticket) {
      return response(409, { error: flagEnabled
        ? "This ticket is not locked by the current automation run."
        : "Automated clarifications are unavailable." });
    }
    if (body.action === "claim") {
      assert.equal(body.ticketId, TICKET);
      assert.equal(body.lockToken, LOCK);
      state.claimed = true;
      return response(200, { ticket: { id: TICKET, status: "in_progress",
        automation_status: "investigating" } });
    }
    if (body.action === "clarify" && state.claimed && !state.clarified) {
      assert.equal(body.ticketVersion, VERSION);
      state.clarified = true;
      return response(200, { created: replyCreated, messageId: REPLY_ID });
    }
    return response(409, { error: "This ticket is not locked by the current automation run." });
  };
  const ids = [RUN, REQUEST, LOCK];
  return { state, stateStore, fetchImpl, uuidImpl: () => ids.shift() };
}

test("main-only synthetic clarification verifies one reply, retry, and zero residue", async () => {
  const f = fixture();
  const result = await runClarificationSmoke({ env: ENV, ...f, deploymentImpl: deployment });
  assert.equal(result.ok, true);
  assert.equal(result.clarificationCreated, 1);
  assert.equal(result.syntheticRowsRemaining, 0);
  assert.equal(f.state.cleanupCalls, 2);
  assert.equal(f.state.account, false);
  assert.equal(f.state.ticket, false);
  assert.deepEqual(f.state.appCalls.filter((call) => call ===
    "PATCH /api/internal/support-automation").length, 4);
});

test("disabled Vercel flag stops before any database write", async () => {
  const f = fixture({ flagEnabled: false });
  await assert.rejects(runClarificationSmoke({ env: ENV, ...f,
    deploymentImpl: deployment }), { code: "clarification_smoke_vercel_flag_not_ready" });
  assert.equal(f.state.dbWrites.length, 0);
  assert.equal(f.state.cleanupCalls, 0);
});

test("failed reply confirmation still invokes guarded cleanup", async () => {
  const f = fixture({ replyCreated: false });
  await assert.rejects(runClarificationSmoke({ env: ENV, ...f,
    deploymentImpl: deployment }), { code: "clarification_smoke_reply_unconfirmed" });
  assert.equal(f.state.cleanupCalls, 2);
  assert.equal(f.state.account, false);
  assert.equal(f.state.ticket, false);
});

test("cleanup guard failure never reports a passing smoke", async () => {
  const f = fixture({ cleanupFails: true });
  await assert.rejects(runClarificationSmoke({ env: ENV, ...f,
    deploymentImpl: deployment }), { code: "clarification_smoke_cleanup_incomplete" });
  assert.equal(f.state.account, true);
  assert.deepEqual(f.state.saved, { runId: RUN, requestId: REQUEST });
  f.state.cleanupFails = false;
  const rescued = await runCleanupOnly({ env: ENV, ...f });
  assert.equal(rescued.syntheticRowsRemaining, 0);
  assert.equal(f.state.account, false);
  assert.equal(f.state.saved, null);
});

test("interrupted workflow rescues from a mode-0600 synthetic-only state file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yutakasa-clarification-"));
  const file = path.join(directory, "yutakasa-clarification-smoke-state.json");
  const env = { ...ENV, RUNNER_TEMP: directory,
    YUTAKASA_CLARIFICATION_SMOKE_STATE_PATH: file };
  const f = fixture({ cleanupFails: true });
  try {
    await assert.rejects(runClarificationSmoke({ env, fetchImpl: f.fetchImpl,
      uuidImpl: f.uuidImpl, deploymentImpl: deployment }),
    { code: "clarification_smoke_cleanup_incomplete" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")),
      { runId: RUN, requestId: REQUEST });
    f.state.cleanupFails = false;
    const rescued = await runCleanupOnly({ env, fetchImpl: f.fetchImpl });
    assert.equal(rescued.syntheticRowsRemaining, 0);
    assert.equal(fs.existsSync(file), false);
    assert.equal(f.state.account, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unsafe rescue state path stops before database access", async () => {
  const f = fixture();
  await assert.rejects(runClarificationSmoke({ env: { ...ENV, RUNNER_TEMP: "/tmp",
    YUTAKASA_CLARIFICATION_SMOKE_STATE_PATH: "/tmp/other-file.json" },
  fetchImpl: f.fetchImpl, uuidImpl: f.uuidImpl, deploymentImpl: deployment }),
  { code: "clarification_smoke_state_path_invalid" });
  assert.equal(f.state.dbWrites.length, 0);
  assert.equal(f.state.appCalls.length, 0);
});

test("untrusted branch and deployment fail before production writes", async () => {
  const f = fixture();
  await assert.rejects(runClarificationSmoke({ env: { ...ENV, GITHUB_REF: "refs/heads/feature" },
    ...f, deploymentImpl: deployment }), { code: "clarification_smoke_trusted_main_required" });
  assert.equal(f.state.dbWrites.length, 0);
  await assert.rejects(runClarificationSmoke({ env: ENV, ...f,
    deploymentImpl: async () => ({ ready: true, mainSha: "b".repeat(40) }) }),
  { code: "clarification_smoke_deployment_not_main" });
  assert.equal(f.state.dbWrites.length, 0);
});
