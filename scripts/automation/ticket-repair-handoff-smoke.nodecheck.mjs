import assert from "node:assert/strict";
import { test } from "node:test";

import { TEST_SUPPORT_ACK, TEST_SUPPORT_BODY, TEST_SUPPORT_SUBJECT } from
  "./ai-repair-functional-smoke.mjs";
import { HandoffSmokeError, runTicketRepairHandoffSmoke } from
  "./ticket-repair-handoff-smoke.mjs";

const SHA = "a".repeat(40);
const DEPLOYMENT = "dpl_testbridge12345678";
const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const ACK_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_ID = "55555555-5555-4555-8555-555555555555";
const ACK_CLIENT_ID = "66666666-6666-4666-8666-666666666666";
const BASE_TIME = "2026-09-17T08:30:00.000Z";
const CLAIM_TIME = "2026-09-17T08:30:01.000Z";
const HANDOFF_TIME = "2026-09-17T08:30:02.000Z";

function env(overrides = {}) {
  return {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach",
    GITHUB_REF: "refs/heads/main", GITHUB_SHA: SHA,
    TICKET_REPAIR_ENABLED: "false", AUTO_MERGE_ENABLED: "false",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key-at-least-20-chars",
    JWT_SECRET: "jwt-secret-test-value-at-least-32-characters",
    VERCEL_TOKEN: "vercel-test-token-at-least-20-chars",
    ...overrides,
  };
}

function fixture({ changeAfterHandoff = false, claimJobBeforeCleanup = false,
  changeAccountBeforeCleanup = false, failCleanup = false,
  cleanupRpcMissing = false, supportCreateFails = false,
  detailFails = false } = {}) {
  const state = { account: null, ticket: null, messages: [], logs: [], job: null,
    calls: [], deletes: [], providerCalls: [] };
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const supportTicketImpl = async (_env, _fetch, email, token) => {
    if (supportCreateFails) throw new Error("synthetic support request failed");
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    state.ticket = { id: TICKET_ID, user_email: email, category: "technical",
      subject: TEST_SUPPORT_SUBJECT, client_request_id: CLIENT_ID, status: "open",
      automation_status: "queued", decision_required: false,
      automation_lock_token: null, updated_at: BASE_TIME };
    state.messages = [
      { id: MESSAGE_ID, ticket_id: TICKET_ID, sender_type: "user", sender_email: email,
        body: TEST_SUPPORT_BODY, client_request_id: CLIENT_ID, created_at: BASE_TIME },
      { id: ACK_ID, ticket_id: TICKET_ID, sender_type: "system", sender_email: null,
        body: TEST_SUPPORT_ACK, client_request_id: ACK_CLIENT_ID, created_at: BASE_TIME },
    ];
    return { ticketCreated: true, idempotent: true, messagesSaved: true, queueIsolated: true };
  };
  const fetchImpl = async (urlValue, init) => {
    const url = new URL(String(urlValue));
    state.calls.push({ host: url.host, path: url.pathname, method: init.method });
    if (["api.openai.com", "api.resend.com", "api.stripe.com"].includes(url.host)) {
      state.providerCalls.push(url.host);
      throw new Error("provider called");
    }
    if (url.host === "yutakasa-tapping-coach.vercel.app") {
      assert.equal(url.pathname, "/api/internal/support-automation");
      if (init.method === "GET") {
        if (detailFails) return response({ error: "detail unavailable" }, 500);
        assert.equal(url.searchParams.get("ticketId"), TICKET_ID);
        assert.equal(init.headers["x-automation-lock-token"], state.ticket.automation_lock_token);
        return response({ ticket: { id: TICKET_ID,
          automation_status: state.ticket.automation_status,
          has_attachments: false, updated_at: state.ticket.updated_at },
        messages: state.messages.map(({ id, sender_type, body, created_at }) =>
          ({ id, sender_type, body, created_at })) });
      }
      const body = JSON.parse(init.body);
      if (body.action === "claim") {
        state.ticket.status = "in_progress";
        state.ticket.automation_status = "investigating";
        state.ticket.automation_lock_token = body.lockToken;
        state.ticket.updated_at = CLAIM_TIME;
        state.logs.push({ event_type: "automation_claimed", metadata: {} });
        return response({ ticket: { ...state.ticket } });
      }
      if (body.action === "handoff") {
        if (state.ticket.automation_status !== "investigating") {
          if (changeAfterHandoff) {
            state.messages.push({ id: "77777777-7777-4777-8777-777777777777",
              ticket_id: TICKET_ID, sender_type: "admin", sender_email: "operator@example.invalid",
              body: "Human reply", client_request_id: "88888888-8888-4888-8888-888888888888" });
            state.ticket.updated_at = "2026-09-17T08:30:03.000Z";
          }
          return response({ error: "lock lost" }, 409);
        }
        assert.equal(body.latestUserMessageId, MESSAGE_ID);
        assert.equal(body.ticketVersion, CLAIM_TIME);
        state.ticket.automation_status = "awaiting_repair";
        state.ticket.automation_lock_token = null;
        state.ticket.updated_at = HANDOFF_TIME;
        state.logs.push({ event_type: "repair_work_queued", metadata: { work_id: body.workId } });
        state.job = { work_id: body.workId, ticket_id: TICKET_ID,
          latest_user_message_id: MESSAGE_ID, status: "queued", attempt_count: 0,
          claimed_run_id: null, pr_number: null, head_sha: null };
        return response({ workId: body.workId });
      }
      throw new Error(`unexpected support action: ${body.action}`);
    }
    assert.equal(url.host, "test.supabase.co");
    const table = url.pathname.slice("/rest/v1/".length);
    const search = url.searchParams;
    if (init.method === "POST" && table === "subscribers") {
      const body = JSON.parse(init.body);
      state.account = { id: ACCOUNT_ID, subscription_started_at: null,
        subscription_last_event_at: null, updated_at: BASE_TIME, ...body };
      return response([state.account], 201);
    }
    if (init.method === "POST" && table === "rpc/list_due_yutakasa_ticket_repair_jobs") {
      return response(state.job ? [{ work_id: state.job.work_id }] : []);
    }
    if (init.method === "POST" && table === "rpc/cleanup_yutakasa_ticket_handoff_smoke") {
      const body = JSON.parse(init.body);
      if (body.p_run_id === null) {
        return cleanupRpcMissing ? response({ code: "PGRST202" }, 404)
          : response({ code: "22023" }, 400);
      }
      assert.equal(body.p_account_id, state.account?.id ?? null);
      assert.equal(body.p_account_updated_at, state.account?.updated_at ?? null);
      assert.equal(body.p_ticket_id, state.ticket?.id ?? null);
      assert.equal(body.p_ticket_updated_at, state.ticket?.updated_at ?? null);
      assert.equal(body.p_work_id, state.job?.work_id ?? body.p_work_id);
      if (claimJobBeforeCleanup && state.job) {
        state.job.status = "investigating";
        state.job.attempt_count = 1;
        state.job.claimed_run_id = 123;
      }
      if (changeAccountBeforeCleanup && state.account) {
        state.account.first_payment_date = "2026-09-17T08:30:03.000Z";
      }
      if (failCleanup || state.job?.status === "investigating" ||
          state.account?.first_payment_date !== null) return response({ code: "P0001" }, 400);
      const ticketDeleted = Boolean(state.ticket);
      if (ticketDeleted) state.deletes.push("ticket");
      state.ticket = null; state.messages = []; state.logs = []; state.job = null;
      state.deletes.push("subscriber");
      state.account = null;
      return response([{ ticket_deleted: ticketDeleted, subscriber_deleted: true }]);
    }
    if (init.method !== "GET") throw new Error(`unexpected DB method: ${init.method}`);
    if (table === "subscribers") {
      if (!state.account) return response([]);
      const email = search.get("email") ?? "";
      return response(email.startsWith("like.") || email === `eq.${state.account.email}`
        ? [state.account] : []);
    }
    if (table === "support_tickets") {
      if (!state.ticket) return response([]);
      const email = search.get("user_email") ?? "";
      return response(email.startsWith("like.") || email === `eq.${state.ticket.user_email}`
        ? [state.ticket] : []);
    }
    if (table === "support_messages") return response(state.messages);
    if (table === "support_work_logs") return response(state.logs);
    if (table === "yutakasa_ticket_repair_jobs") {
      if (!state.job) return response([]);
      const workId = search.get("work_id");
      return response(!workId || workId === `eq.${state.job.work_id}` ? [state.job] : []);
    }
    if (["chat_threads", "otp_codes", "yutakasa_repair_releases",
      "support_attachments", "yutakasa_repair_ticket_links",
      "yutakasa_ticket_reply_drafts", "yutakasa_ticket_clarifications"].includes(table)) {
      return response([]);
    }
    throw new Error(`unexpected DB table: ${table}`);
  };
  const deploymentImpl = async () => ({ mainSha: SHA, deploymentId: DEPLOYMENT, ready: true });
  return { state, supportTicketImpl, fetchImpl, deploymentImpl };
}

test("disabled repair/merge or a non-main context stops before production access", async () => {
  for (const overrides of [
    { TICKET_REPAIR_ENABLED: "true" }, { AUTO_MERGE_ENABLED: "true" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_EVENT_NAME: "pull_request" },
  ]) {
    const f = fixture();
    await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(overrides), ...f }),
      (error) => error instanceof HandoffSmokeError &&
        error.code === "handoff_smoke_configuration_invalid");
    assert.equal(f.state.calls.length, 0);
  }
});

test("production SHA mismatch stops before synthetic writes", async () => {
  const f = fixture();
  await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(), ...f,
    deploymentImpl: async () => ({ mainSha: "b".repeat(40),
      deploymentId: DEPLOYMENT, ready: true }) }),
  { code: "handoff_smoke_production_not_at_main" });
  assert.equal(f.state.calls.length, 0);
});

test("missing cleanup RPC stops before synthetic account creation", async () => {
  const f = fixture({ cleanupRpcMissing: true });
  await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(), ...f }),
    { code: "handoff_smoke_cleanup_preflight_failed" });
  assert.equal(f.state.account, null);
  assert.equal(f.state.ticket, null);
  assert.deepEqual(f.state.calls.map((call) => call.method), ["POST"]);
});

test("claim and handoff create one queued job, then remove only the synthetic rows", async () => {
  const f = fixture();
  const result = await runTicketRepairHandoffSmoke({ env: env(), ...f });
  assert.equal(result.ok, true);
  assert.equal(result.repairJobQueued, true);
  assert.deepEqual(f.state.deletes, ["ticket", "subscriber"]);
  assert.equal(f.state.account, null);
  assert.equal(f.state.ticket, null);
  assert.equal(f.state.job, null);
  assert.deepEqual(f.state.providerCalls, []);
  assert.equal(f.state.calls.some((call) => call.path.includes("ticket-repair.yml")), false);
});

test("an operator message blocks cleanup before any deletion", async () => {
  const f = fixture({ changeAfterHandoff: true });
  await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(), ...f }),
    { code: "handoff_smoke_cleanup_incomplete" });
  assert.deepEqual(f.state.deletes, []);
  assert.ok(f.state.ticket);
  assert.ok(f.state.account);
});

test("an unconfirmed atomic cleanup preserves ticket and subscriber", async () => {
  const f = fixture({ failCleanup: true });
  await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(), ...f }),
    { code: "handoff_smoke_cleanup_incomplete" });
  assert.deepEqual(f.state.deletes, []);
  assert.ok(f.state.ticket);
  assert.ok(f.state.account);
});

test("a repair job claimed between read and cleanup is never cascaded", async () => {
  const f = fixture({ claimJobBeforeCleanup: true });
  await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(), ...f }),
    { code: "handoff_smoke_cleanup_incomplete" });
  assert.deepEqual(f.state.deletes, []);
  assert.equal(f.state.job.status, "investigating");
});

test("a payment marker changed between read and cleanup protects the subscriber", async () => {
  const f = fixture({ changeAccountBeforeCleanup: true });
  await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(), ...f }),
    { code: "handoff_smoke_cleanup_incomplete" });
  assert.deepEqual(f.state.deletes, []);
  assert.ok(f.state.account.first_payment_date);
});

test("a failed support creation cleans up its account-only partial state", async () => {
  const f = fixture({ supportCreateFails: true });
  await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(), ...f }),
    /synthetic support request failed/u);
  assert.deepEqual(f.state.deletes, ["subscriber"]);
  assert.equal(f.state.account, null);
});

test("a failed claimed-detail read cleans up an investigating ticket", async () => {
  const f = fixture({ detailFails: true });
  await assert.rejects(() => runTicketRepairHandoffSmoke({ env: env(), ...f }),
    { code: "handoff_smoke_support_http_500" });
  assert.deepEqual(f.state.deletes, ["ticket", "subscriber"]);
  assert.equal(f.state.ticket, null);
  assert.equal(f.state.account, null);
});
