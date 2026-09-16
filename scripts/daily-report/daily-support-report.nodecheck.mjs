import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDailyReport,
  collectMonitorSummary,
  DailyReportError,
  reportWindow,
  reportingDate,
  runDailySupportReport,
} from "./daily-support-report.mjs";

const NOW = new Date("2026-09-16T00:05:00.000Z");
const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const LOG_ID = "33333333-3333-4333-8333-333333333333";
const RESEND_ID = "44444444-4444-4444-8444-444444444444";
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "a-service-role-test-key-with-length",
  RESEND_API_KEY: "re_test-key",
  REPORT_RECIPIENT_1: "owner-one@example.com",
  REPORT_RECIPIENT_2: "owner-two@example.com",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function source() {
  const ticket = {
    id: TICKET_ID,
    category: "technical",
    status: "in_progress",
    automation_status: "investigating",
    decision_required: false,
    created_at: "2026-09-15T01:00:00.000Z",
    updated_at: "2026-09-15T03:00:00.000Z",
    subject: "PRIVATE SUBJECT",
    user_email: "customer@example.com",
  };
  return {
    createdTickets: [{ id: ticket.id, created_at: ticket.created_at, updated_at: ticket.updated_at }],
    updatedTickets: [{ id: ticket.id, created_at: ticket.created_at, updated_at: ticket.updated_at }],
    tickets: [ticket],
    openTickets: [{ id: TICKET_ID, status: ticket.status, automation_status: ticket.automation_status, decision_required: false, updated_at: ticket.updated_at }],
    messages: [{ id: MESSAGE_ID, ticket_id: TICKET_ID, sender_type: "user", created_at: "2026-09-15T02:00:00.000Z", body: "PRIVATE MESSAGE" }],
    workLogs: [{ id: LOG_ID, ticket_id: TICKET_ID, created_at: "2026-09-15T03:00:00.000Z", event_type: "PRIVATE EVENT TYPE", summary: "PRIVATE LOG", metadata: { secret: "PRIVATE METADATA" } }],
  };
}

function testFetch({ records = source(), monitorRuns = [], monitorStatus = 200, resendBehavior = async () => json({ id: RESEND_ID }) } = {}) {
  const requests = [];
  const ledger = new Map();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.host === "api.resend.com") return resendBehavior(url, init);
    if (url.pathname === "/rest/v1/yutakasa_daily_report_deliveries") {
      return json([...ledger.entries()].map(([key, value]) => ({ recipient: key.split(":")[1], status: value.status })));
    }
    if (url.pathname === "/rest/v1/yutakasa_monitor_runs") {
      if (monitorStatus !== 200) return json({ code: "not_available" }, monitorStatus);
      assert.equal(url.searchParams.get("run_kind"), "eq.scheduled");
      const bounds = url.searchParams.getAll("finished_at");
      const start = bounds.find((value) => value.startsWith("gte.")).slice(4);
      const end = bounds.find((value) => value.startsWith("lt.")).slice(3);
      const filtered = monitorRuns.filter((row) => row.run_kind !== "recheck" && row.finished_at >= start && row.finished_at < end);
      return json(filtered.slice(Number(url.searchParams.get("offset")), Number(url.searchParams.get("offset")) + Number(url.searchParams.get("limit"))));
    }
    if (url.pathname === "/rest/v1/support_tickets") {
      if (url.searchParams.has("status")) {
        const afterId = url.searchParams.get("id")?.replace(/^gt\./u, "");
        const limit = Number(url.searchParams.get("limit"));
        return json(records.openTickets.filter((row) => !afterId || row.id > afterId).slice(0, limit));
      }
      if (url.searchParams.has("id")) return json(records.tickets);
      if (url.searchParams.has("created_at")) return json(records.createdTickets);
      if (url.searchParams.has("updated_at")) return json(records.updatedTickets);
    }
    if (url.pathname === "/rest/v1/support_messages" || url.pathname === "/rest/v1/support_work_logs") {
      const rows = url.pathname.endsWith("support_messages") ? records.messages : records.workLogs;
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return json(rows.slice(offset, offset + limit));
    }
    if (url.pathname === "/rest/v1/rpc/reserve_yutakasa_daily_report_delivery") {
      const params = JSON.parse(init.body);
      const key = `${params.p_report_date_jst}:${params.p_recipient}`;
      const previous = ledger.get(key);
      if (previous) {
        if (previous.status === "accepted" || previous.status === "uncertain") return json([{ ...previous, can_send: false }]);
      }
      const next = {
        can_send: true,
        status: "sending",
        subject: previous?.subject || params.p_subject,
        body: previous?.body || params.p_body,
        idempotency_key: previous?.idempotency_key || params.p_idempotency_key,
        attempt_count: (previous?.attempt_count || 0) + 1,
      };
      ledger.set(key, next);
      return json([next]);
    }
    if (url.pathname === "/rest/v1/rpc/finish_yutakasa_daily_report_delivery") {
      const params = JSON.parse(init.body);
      const key = `${params.p_report_date_jst}:${params.p_recipient}`;
      const previous = ledger.get(key);
      assert.equal(params.p_attempt_count, previous.attempt_count);
      const next = { ...previous, status: params.p_status, provider_email_id: params.p_provider_email_id };
      ledger.set(key, next);
      return json([{ status: next.status, provider_email_id: next.provider_email_id, attempt_count: next.attempt_count }]);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, requests, ledger };
}

test("09:00 JST is the boundary; the report covers the previous full JST day", () => {
  assert.equal(reportingDate(new Date("2026-09-15T23:59:59Z")), null);
  assert.equal(reportingDate(new Date("2026-09-16T00:00:00Z")), "2026-09-15");
  assert.deepEqual(reportWindow("2026-09-15"), {
    start: "2026-09-14T15:00:00.000Z",
    end: "2026-09-15T15:00:00.000Z",
  });
});

test("before 09:00 JST is a no-op even when credentials are absent", async () => {
  const result = await runDailySupportReport({ env: {}, now: new Date("2026-09-15T23:59:00Z"), fetchImpl: () => { throw new Error("must not fetch"); } });
  assert.deepEqual(result, { ok: true, skipped: "before_09_jst" });
});

test("recipient configuration rejects duplicates and header injection before any fetch", async () => {
  for (const invalid of [
    { ...env, REPORT_RECIPIENT_2: "OWNER-ONE@example.com" },
    { ...env, REPORT_RECIPIENT_1: "owner@example.com\nBcc: outsider@example.com" },
  ]) {
    await assert.rejects(
      () => runDailySupportReport({ env: invalid, now: NOW, fetchImpl: () => { throw new Error("must not fetch"); } }),
      (error) => error instanceof DailyReportError && error.code === "report_recipients_invalid",
    );
  }
});

test("daily text contains only metadata and separates acceptance by recipient", async () => {
  const client = testFetch();
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.reportDateJst, "2026-09-15");
  assert.equal(result.ticketCount, 1);
  assert.equal(result.messageCount, 1);
  assert.equal(result.workLogCount, 1);
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries.filter((item) => item.sentNow).length, 2);
  const sends = client.requests.filter(({ url }) => url.host === "api.resend.com");
  assert.deepEqual(sends.map(({ init }) => JSON.parse(init.body).to[0]), ["owner-one@example.com", "owner-two@example.com"]);
  assert.notEqual(sends[0].init.headers["Idempotency-Key"], sends[1].init.headers["Idempotency-Key"]);
  for (const { init } of sends) {
    const payload = JSON.parse(init.body);
    assert.match(payload.text, /前日に動きがあったチケット: 1件/);
    assert.match(payload.text, /前日のやりとり・作業時系列: 2件/);
    assert.match(payload.text, /利用者投稿/);
    assert.match(payload.text, /作業記録/);
    assert.match(payload.text, new RegExp(TICKET_ID));
    for (const privateText of ["PRIVATE SUBJECT", "PRIVATE MESSAGE", "PRIVATE EVENT TYPE", "PRIVATE LOG", "PRIVATE METADATA", "customer@example.com"]) {
      assert.equal(payload.text.includes(privateText), false);
    }
  }
  const again = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(again.ok, true);
  assert.equal(again.deliveries.every((item) => !item.sentNow), true);
  assert.equal(JSON.stringify(again).includes("owner-one@example.com"), false);
  assert.equal(JSON.stringify(again).includes("owner-two@example.com"), false);
  assert.equal(client.requests.filter(({ url }) => url.host === "api.resend.com").length, 2);
});

test("an uncertain Resend response is recorded and never retried automatically", async () => {
  let sends = 0;
  const client = testFetch({ resendBehavior: async (_url, init) => {
    sends += 1;
    if (JSON.parse(init.body).to[0] === "owner-one@example.com") throw new Error("network broke after request");
    return json({ id: RESEND_ID });
  } });
  const first = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(first.ok, false);
  assert.deepEqual(first.deliveries.map((item) => item.status), ["uncertain", "accepted"]);
  const second = await runDailySupportReport({ env, now: new Date("2026-09-16T01:05:00Z"), fetchImpl: client.fetchImpl });
  assert.equal(second.ok, false);
  assert.equal(sends, 2);
  assert.equal(second.deliveries.every((item) => !item.sentNow), true);
});

test("a definite HTTP 429 rejection retries only the rejected recipient on the next run", async () => {
  let firstRecipientAttempts = 0;
  const client = testFetch({ resendBehavior: async (_url, init) => {
    if (JSON.parse(init.body).to[0] === "owner-one@example.com" && firstRecipientAttempts++ === 0) {
      return json({ name: "rate_limit_exceeded" }, 429);
    }
    return json({ id: RESEND_ID });
  } });
  const first = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.deepEqual(first.deliveries.map((item) => item.status), ["failed", "accepted"]);
  const second = await runDailySupportReport({ env, now: new Date("2026-09-16T01:05:00Z"), fetchImpl: client.fetchImpl });
  assert.equal(second.ok, true);
  assert.deepEqual(second.deliveries.map((item) => item.sentNow), [true, false]);
  const sends = client.requests.filter(({ url }) => url.host === "api.resend.com");
  assert.equal(sends.length, 3);
  assert.equal(sends[0].init.headers["Idempotency-Key"], sends[2].init.headers["Idempotency-Key"]);
  assert.equal(sends[0].init.body, sends[2].init.body);
});

test("incomplete source data fails before any email reservation or send", async () => {
  const bad = source();
  bad.tickets = [];
  const client = testFetch({ records: bad });
  await assert.rejects(() => runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl }), (error) => error instanceof DailyReportError && error.code === "source_ticket_detail_mismatch");
  assert.equal(client.requests.some(({ url }) => url.pathname.includes("/rpc/")), false);
  assert.equal(client.requests.some(({ url }) => url.host === "api.resend.com"), false);
});

test("zero activity still creates a truthful daily report", () => {
  const report = buildDailyReport("2026-09-15", { createdTickets: [], updatedTickets: [], messages: [], workLogs: [], tickets: [], openTickets: [] }, NOW);
  assert.match(report.text, /対象期間中の新規・更新・投稿・作業記録は0件/);
  assert.match(report.text, /前日の投稿・作業記録は0件/);
  assert.match(report.text, /現在の未解決: 0件/);
  assert.match(report.text, /障害0件とは判定していません/);
  assert.equal(report.subject.includes("2026-09-15"), true);
});

test("an old unresolved ticket is counted even on a day with no new activity", () => {
  const empty = { createdTickets: [], updatedTickets: [], messages: [], workLogs: [], tickets: [],
    openTickets: [{ id: TICKET_ID, status: "waiting_user", decision_required: true,
      automation_status: "blocked_decision", updated_at: "2026-09-10T00:00:00.000Z" }] };
  const report = buildDailyReport("2026-09-15", empty, NOW);
  assert.match(report.text, /前日に動きがあったチケット: 0件/);
  assert.match(report.text, /現在の未解決: 1件/);
  assert.match(report.text, /運営判断要1件/);
  assert.match(report.text, /運営判断待ち1件/);
});

test("current unresolved pagination retrieves the 501st row", async () => {
  const openTickets = Array.from({ length: 501 }, (_, index) => ({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    status: "open", decision_required: false, automation_status: "queued",
    updated_at: "2026-09-10T00:00:00.000Z",
  }));
  const client = testFetch({ records: { createdTickets: [], updatedTickets: [], messages: [], workLogs: [], tickets: [], openTickets } });
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.currentOpenCount, 501);
  assert.equal(client.requests.filter(({ url }) => url.pathname === "/rest/v1/support_tickets" && url.searchParams.has("status")).length, 2);
  const firstSend = client.requests.find(({ url }) => url.host === "api.resend.com");
  assert.match(JSON.parse(firstSend.init.body).text, /現在の未解決: 501件/);
});

test("message pagination counts the 501st event without exposing any body", async () => {
  const records = source();
  records.messages = Array.from({ length: 501 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    ticket_id: TICKET_ID,
    sender_type: "user",
    created_at: "2026-09-15T02:00:00.000Z",
    body: `PRIVATE MESSAGE ${index}`,
  }));
  const client = testFetch({ records });
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.messageCount, 501);
  assert.equal(client.requests.filter(({ url }) => url.pathname === "/rest/v1/support_messages").length, 2);
  const firstSend = client.requests.find(({ url }) => url.host === "api.resend.com");
  const text = JSON.parse(firstSend.init.body).text;
  assert.match(text, /利用者501件/);
  assert.match(text, /ほか402件。時系列の表示は最大100件/);
  assert.equal(text.includes("PRIVATE MESSAGE"), false);
});

test("a row outside the requested JST window fails closed before sending", async () => {
  const records = source();
  records.messages[0].created_at = "2026-09-15T15:00:00.000Z";
  const client = testFetch({ records });
  await assert.rejects(
    () => runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl }),
    (error) => error instanceof DailyReportError && error.code === "source_window_mismatch",
  );
  assert.equal(client.requests.some(({ url }) => url.host === "api.resend.com"), false);
});

test("monitor results use the previous JST window and distinguish missing hours from healthy runs", async () => {
  const monitorRuns = [
    { run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", started_at: "2026-09-14T14:59:00.000Z", finished_at: "2026-09-14T15:00:00.000Z", status: "healthy", reason_codes: [], alert_dispatched: false, repair_dispatched: false },
    { run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", started_at: "2026-09-15T03:17:00.000Z", finished_at: "2026-09-15T03:18:00.000Z", status: "action_required", reason_codes: ["pending_tickets", "production_log_fiveXx"], alert_dispatched: true, repair_dispatched: true },
    { run_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", started_at: "2026-09-15T14:17:00.000Z", finished_at: "2026-09-15T14:59:59.999Z", status: "failed", reason_codes: ["monitor_lease_lost"], alert_dispatched: false, repair_dispatched: false },
    { run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", started_at: "2026-09-15T15:00:00.000Z", finished_at: "2026-09-15T15:00:00.000Z", status: "healthy", reason_codes: [], alert_dispatched: false, repair_dispatched: false },
    { run_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", run_kind: "recheck", started_at: "2026-09-15T08:17:00.000Z", finished_at: "2026-09-15T08:18:00.000Z", status: "healthy", reason_codes: [], alert_dispatched: false, repair_dispatched: false },
  ];
  const client = testFetch({ monitorRuns });
  const summary = await collectMonitorSummary({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }, reportWindow("2026-09-15"), client.fetchImpl);
  assert.equal(summary.state, "observed");
  assert.equal(summary.completedCount, 3);
  assert.equal(summary.observedHourCount, 2);
  assert.equal(summary.statusCounts.action_required, 1);
  assert.deepEqual(summary.reasonCounts, [["monitor_lease_lost", 1], ["pending_tickets", 1], ["production_log_fiveXx", 1]]);
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.monitorCompletedCount, 3);
  const email = JSON.parse(client.requests.find(({ url }) => url.host === "api.resend.com").init.body).text;
  assert.match(email, /障害監視の完了記録（確認できた実行のみ）: 3件/);
  assert.match(email, /記録のある時間帯2\/24/);
  assert.match(email, /正常1件、要対応1件、失敗1件/);
  assert.match(email, /pending_tickets 1件/);
  assert.match(email, /前日全体が正常とは判定していません/);
});

test("missing monitor table or zero completed rows stays explicitly unverified", async () => {
  for (const options of [{ monitorStatus: 404 }, { monitorRuns: [] }]) {
    const client = testFetch(options);
    const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.monitorState, options.monitorStatus ? "unavailable" : "missing");
    const email = JSON.parse(client.requests.find(({ url }) => url.host === "api.resend.com").init.body).text;
    assert.match(email, /障害0件とは判定していません/);
    assert.doesNotMatch(email, /障害監視の完了記録: 0件（.*正常/u);
  }
});
