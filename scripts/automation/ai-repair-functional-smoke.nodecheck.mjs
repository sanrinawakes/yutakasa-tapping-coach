import assert from "node:assert/strict";
import test from "node:test";

import { FunctionalSmokeError, checkSyntheticSupportTicket, reapStaleSyntheticIdentities, runProductionFunctionalSmoke } from "./ai-repair-functional-smoke.mjs";

const env = {
  JWT_SECRET: "j".repeat(40),
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "s".repeat(40),
};
const sha = "a".repeat(40);
const release = { merge_sha: sha };
const deployment = { mainSha: sha, deploymentId: "dpl_Abcdefghijklmnop", ready: true };
const id = "11111111-1111-4111-8111-111111111111";

function fakeDatabase({ preexisting = false, deleteFails = false } = {}) {
  let account = null;
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ method: init.method, pathname: url.pathname, query: url.searchParams, body: init.body });
    if (["chat_threads", "otp_codes", "support_tickets"].some((table) => url.pathname === `/rest/v1/${table}`)) {
      return Response.json([]);
    }
    assert.equal(url.pathname, "/rest/v1/subscribers");
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      account = { id, ...body };
      return Response.json([account], { status: 201 });
    }
    if (init.method === "DELETE") {
      assert.equal(url.searchParams.get("id"), `eq.${id}`);
      assert.equal(url.searchParams.get("myasp_data->>smoke_run_id"), `eq.${account.myasp_data.smoke_run_id}`);
      if (deleteFails) return Response.json([]);
      const removed = account;
      account = null;
      return Response.json([{ id: removed.id }]);
    }
    if (preexisting) return Response.json([{ id }]);
    if (url.searchParams.get("email")?.startsWith("like.")) return Response.json([]);
    return Response.json(account ? [account] : []);
  };
  return { fetchImpl, calls, getAccount: () => account };
}

test("missing trusted credentials stop before any production access", async () => {
  let calls = 0;
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env: { ...env, JWT_SECRET: "short" },
    fetchImpl: async () => { calls += 1; throw new Error("unexpected"); },
  }), (error) => error instanceof FunctionalSmokeError && error.code === "smoke_jwt_secret_not_configured");
  assert.equal(calls, 0);
});

test("a pre-existing synthetic identity is never overwritten or deleted", async () => {
  const db = fakeDatabase({ preexisting: true });
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env, fetchImpl: db.fetchImpl,
  }), (error) => error instanceof FunctionalSmokeError && error.code === "smoke_stale_identity_ambiguous");
  assert.deepEqual(db.calls.map((call) => call.method), ["GET"]);
});

function staleDatabase({ ageMinutes = 40, ambiguous = false, otp = false } = {}) {
  const runId = "22222222-2222-4222-8222-222222222222";
  const email = ambiguous
    ? "yutakasa-auto-smoke+customer@example.com"
    : `yutakasa-auto-smoke+${runId}@example.invalid`;
  const account = {
    id, email, status: "active", subscription_status: "active", first_payment_date: null,
    myasp_data: { automation_test_identity: "yutakasa-ai-repair-smoke-v1",
      source: "system_monitor_no_payment", smoke_run_id: runId },
    created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
  };
  const customer = { id: "33333333-3333-4333-8333-333333333333", email: "customer@example.com" };
  let rows = [account, customer];
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ method: init.method, table: url.pathname.split("/").at(-1), filters: [...url.searchParams] });
    const table = url.pathname.split("/").at(-1);
    if (["chat_threads", "chat_messages", "support_tickets"].includes(table)) return Response.json([]);
    if (table === "otp_codes") return Response.json(otp ? [{ id, email }] : []);
    assert.equal(table, "subscribers");
    if (init.method === "DELETE") {
      assert.equal(url.searchParams.get("email"), `eq.${email}`);
      assert.equal(url.searchParams.get("myasp_data->>smoke_run_id"), `eq.${runId}`);
      rows = rows.filter((row) => row.email !== email);
      return Response.json([{ id }]);
    }
    const emailFilter = url.searchParams.get("email");
    const matching = emailFilter?.startsWith("like.")
      ? rows.filter((row) => row.email.startsWith("yutakasa-auto-smoke"))
      : rows.filter((row) => row.email === emailFilter?.slice(3));
    return Response.json(matching);
  };
  return { fetchImpl, calls, getRows: () => rows };
}

test("an old exact test identity is reaped, with a customer row untouched", async () => {
  const db = staleDatabase();
  assert.deepEqual(await reapStaleSyntheticIdentities(env, db.fetchImpl), { reaped: 1 });
  assert.deepEqual(db.getRows().map((row) => row.email), ["customer@example.com"]);
  assert.equal(db.calls.filter((call) => call.method === "DELETE").length, 1);
});

test("a recent synthetic identity is never reaped", async () => {
  const db = staleDatabase({ ageMinutes: 5 });
  await assert.rejects(() => reapStaleSyntheticIdentities(env, db.fetchImpl),
    (error) => error instanceof FunctionalSmokeError && error.code === "smoke_synthetic_identity_still_recent");
  assert.equal(db.calls.some((call) => call.method === "DELETE"), false);
});

test("ambiguous prefix residue refuses all deletion", async () => {
  const db = staleDatabase({ ambiguous: true });
  await assert.rejects(() => reapStaleSyntheticIdentities(env, db.fetchImpl),
    (error) => error instanceof FunctionalSmokeError && error.code === "smoke_stale_identity_ambiguous");
  assert.equal(db.calls.some((call) => call.method === "DELETE"), false);
});

test("OTP residue refuses deletion even for an old marked account", async () => {
  const db = staleDatabase({ otp: true });
  await assert.rejects(() => reapStaleSyntheticIdentities(env, db.fetchImpl),
    (error) => error instanceof FunctionalSmokeError && error.code === "smoke_stale_otp_ambiguous");
  assert.equal(db.calls.some((call) => call.method === "DELETE"), false);
});

test("browser failure still deletes and reads back the exact isolated test subscriber", async () => {
  const db = fakeDatabase();
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env, fetchImpl: db.fetchImpl,
    chromiumImpl: { launch: async () => { throw new Error("browser unavailable"); } },
  }), /browser unavailable/u);
  assert.equal(db.getAccount(), null);
  assert.equal(db.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(db.calls.filter((call) => call.method === "DELETE").length, 1);
  const inserted = JSON.parse(db.calls.find((call) => call.method === "POST").body);
  assert.match(inserted.email, /^yutakasa-auto-smoke\+[0-9a-f-]+@example\.invalid$/u);
  assert.equal(inserted.first_payment_date, null);
  assert.equal(inserted.subscription_status, "active");
  assert.equal(inserted.myasp_data.source, "system_monitor_no_payment");
});

test("a whole-browser timeout leaves time for subscriber cleanup", async () => {
  const db = fakeDatabase();
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env, fetchImpl: db.fetchImpl,
    browserPhaseLimitMs: 10,
    chromiumImpl: {
      launch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { close: async () => undefined };
      },
    },
  }), (error) => error instanceof FunctionalSmokeError && error.code === "smoke_browser_phase_timeout");
  assert.equal(db.getAccount(), null);
});

test("an unconfirmed cleanup prevents healthy evidence", async () => {
  const db = fakeDatabase({ deleteFails: true });
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env, fetchImpl: db.fetchImpl,
    chromiumImpl: { launch: async () => { throw new Error("browser unavailable"); } },
  }), (error) => error instanceof FunctionalSmokeError && error.code === "smoke_cleanup_incomplete");
  assert.notEqual(db.getAccount(), null);
});

function syntheticSupportDatabase({ unexpectedWorkLog = false, ticketDeleteFails = false } = {}) {
  const runId = "22222222-2222-4222-8222-222222222222";
  const email = `yutakasa-auto-smoke+${runId}@example.invalid`;
  const ticketId = "44444444-4444-4444-8444-444444444444";
  const threadId = "55555555-5555-4555-8555-555555555555";
  const requestId = "66666666-6666-4666-8666-666666666666";
  const account = { id, email, status: "active", subscription_status: "active", first_payment_date: null,
    myasp_data: { automation_test_identity: "yutakasa-ai-repair-smoke-v1",
      source: "system_monitor_no_payment", smoke_run_id: runId },
    created_at: new Date(Date.now() - 40 * 60_000).toISOString() };
  const ticket = { id: ticketId, user_email: email,
    subject: "__YUTAKASA_AI_REPAIR_SMOKE_V1__ support", client_request_id: requestId,
    status: "open", automation_status: "queued", decision_required: false };
  let accounts = [account, { id: "33333333-3333-4333-8333-333333333333", email: "customer@example.com" }];
  let tickets = [ticket];
  let threads = [{ id: threadId, user_email: email, title: "新しいチャット", created_at: new Date().toISOString() }];
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const table = url.pathname.split("/").at(-1);
    calls.push({ table, method: init.method, filters: [...url.searchParams] });
    if (table === "subscribers") {
      if (init.method === "DELETE") {
        assert.equal(tickets.length, 0, "ticket must be deleted before subscriber");
        assert.equal(threads.length, 0, "thread must be deleted before subscriber");
        accounts = accounts.filter((row) => row.email !== email);
        return Response.json([{ id }]);
      }
      return Response.json(accounts.filter((row) =>
        url.searchParams.get("email")?.startsWith("like.")
          ? row.email.startsWith("yutakasa-auto-smoke")
          : row.email === email));
    }
    if (table === "support_tickets") {
      if (init.method === "DELETE") {
        assert.equal(url.searchParams.get("id"), `eq.${ticketId}`);
        assert.equal(url.searchParams.get("user_email"), `eq.${email}`);
        assert.equal(url.searchParams.get("client_request_id"), `eq.${requestId}`);
        if (ticketDeleteFails) return Response.json([]);
        tickets = [];
        return Response.json([{ id: ticketId }]);
      }
      return Response.json(tickets);
    }
    if (table === "chat_threads") {
      if (init.method === "DELETE") {
        assert.equal(tickets.length, 0, "ticket must be deleted before thread");
        threads = [];
        return Response.json([{ id: threadId }]);
      }
      return Response.json(url.searchParams.get("user_email")?.startsWith("like.")
        ? threads : threads.filter((row) => row.user_email === email));
    }
    if (table === "support_work_logs") {
      assert.equal(url.searchParams.get("select"), "ticket_id");
      return Response.json(unexpectedWorkLog ? [{ ticket_id: ticketId }] : []);
    }
    if (["support_messages", "support_attachments", "yutakasa_repair_ticket_links",
      "yutakasa_ticket_repair_jobs", "yutakasa_ticket_reply_drafts",
      "yutakasa_ticket_clarifications", "chat_messages", "otp_codes"].includes(table)) {
      if (!["chat_messages", "otp_codes"].includes(table)) {
        assert.equal(url.searchParams.get("select"), "ticket_id");
      }
      return Response.json([]);
    }
    throw new Error(`unexpected mocked table ${table}`);
  };
  return { fetchImpl, calls, getState: () => ({ accounts, tickets, threads }) };
}

test("stale cleanup deletes synthetic ticket, then thread, then subscriber and reads dependents back", async () => {
  const db = syntheticSupportDatabase();
  assert.deepEqual(await reapStaleSyntheticIdentities(env, db.fetchImpl), { reaped: 1 });
  const deletes = db.calls.filter((call) => call.method === "DELETE").map((call) => call.table);
  assert.deepEqual(deletes, ["support_tickets", "chat_threads", "subscribers"]);
  assert.deepEqual(db.getState().accounts.map((row) => row.email), ["customer@example.com"]);
  assert.deepEqual(db.getState().tickets, []);
  assert.deepEqual(db.getState().threads, []);
  assert.ok(db.calls.filter((call) => call.table === "support_messages" && call.method === "GET").length >= 2);
});

test("unexpected synthetic work log stops cleanup before deleting any row", async () => {
  const db = syntheticSupportDatabase({ unexpectedWorkLog: true });
  await assert.rejects(() => reapStaleSyntheticIdentities(env, db.fetchImpl),
    (error) => error instanceof FunctionalSmokeError && error.code === "smoke_support_unexpected_side_effect");
  assert.equal(db.calls.some((call) => call.method === "DELETE"), false);
});

test("unconfirmed synthetic ticket deletion never reaches subscriber deletion", async () => {
  const db = syntheticSupportDatabase({ ticketDeleteFails: true });
  await assert.rejects(() => reapStaleSyntheticIdentities(env, db.fetchImpl),
    (error) => error instanceof FunctionalSmokeError && error.code === "smoke_cleanup_ticket_unconfirmed");
  assert.deepEqual(db.calls.filter((call) => call.method === "DELETE").map((call) => call.table), ["support_tickets"]);
});

test("support smoke confirms idempotent authenticated API storage and read-only queue isolation", async () => {
  const runId = "22222222-2222-4222-8222-222222222222";
  const email = `yutakasa-auto-smoke+${runId}@example.invalid`;
  const ticketId = "44444444-4444-4444-8444-444444444444";
  const messageId = "55555555-5555-4555-8555-555555555555";
  let ticket = null;
  let messages = [];
  let queueFilterSeen = false;
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ path: url.pathname, method: init.method });
    if (url.pathname === "/api/support/tickets") {
      assert.equal(init.headers.Cookie, "session=synthetic-token");
      const input = JSON.parse(init.body);
      assert.equal(input.category, "technical");
      if (!ticket) {
        ticket = { id: ticketId, user_email: email, subject: input.subject,
          client_request_id: input.clientRequestId, status: "open",
          automation_status: "queued", decision_required: false };
        messages = [
          { id: messageId, ticket_id: ticketId, sender_type: "user", body: input.body,
            client_request_id: input.clientRequestId },
          { id, ticket_id: ticketId, sender_type: "system", body: "受付", client_request_id: id },
        ];
        return Response.json({ ticket_id: ticketId, message_id: messageId, created: true }, { status: 201 });
      }
      return Response.json({ ticket_id: ticketId, message_id: messageId, created: false });
    }
    if (url.pathname === "/rest/v1/support_tickets") {
      if (url.searchParams.get("user_email") === "not.ilike.yutakasa-auto-smoke+%@example.invalid") {
        queueFilterSeen = true;
        return Response.json([]);
      }
      return Response.json(ticket ? [ticket] : []);
    }
    if (url.pathname === "/rest/v1/support_messages") return Response.json(messages);
    throw new Error("unexpected request");
  };
  const result = await checkSyntheticSupportTicket(env, fetchImpl, email, "synthetic-token");
  assert.deepEqual(result, { ticketCreated: true, idempotent: true, messagesSaved: true, queueIsolated: true });
  assert.equal(calls.filter((call) => call.path === "/api/support/tickets").length, 2);
  assert.equal(calls.some((call) => call.path === "/api/internal/support-automation"), false);
  assert.equal(queueFilterSeen, true);
});
