import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildDailyReport,
  DailyReportError,
  reportWindow,
  reportingDate,
  runDailySupportReport,
} from "./daily-support-report.mjs";
import { workEventLabel } from "./daily-report-reliability.mjs";

const NOW = new Date("2026-09-17T00:05:00.000Z");
const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const LOG_ID = "33333333-3333-4333-8333-333333333333";
const RESEND_ID = "44444444-4444-4444-8444-444444444444";
const RESEND_ID_2 = "55555555-5555-4555-8555-555555555555";
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

function resendIdFor(recipient) {
  return recipient === env.REPORT_RECIPIENT_1 ? RESEND_ID : RESEND_ID_2;
}

function source() {
  const ticket = {
    id: TICKET_ID,
    category: "technical",
    status: "in_progress",
    automation_status: "investigating",
    decision_required: false,
    created_at: "2026-09-16T01:00:00.000Z",
    updated_at: "2026-09-16T03:00:00.000Z",
    subject: "PRIVATE SUBJECT",
    user_email: "customer@example.com",
  };
  return {
    createdTickets: [{ id: ticket.id, created_at: ticket.created_at, updated_at: ticket.updated_at }],
    updatedTickets: [{ id: ticket.id, created_at: ticket.created_at, updated_at: ticket.updated_at }],
    tickets: [ticket],
    openTickets: [{ id: TICKET_ID, status: ticket.status, automation_status: ticket.automation_status, decision_required: false, updated_at: ticket.updated_at }],
    messages: [{ id: MESSAGE_ID, ticket_id: TICKET_ID, sender_type: "user", created_at: "2026-09-16T02:00:00.000Z", body: "PRIVATE MESSAGE" }],
    workLogs: [{ id: LOG_ID, ticket_id: TICKET_ID, created_at: "2026-09-16T03:00:00.000Z", event_type: "PRIVATE EVENT TYPE", summary: "PRIVATE LOG", metadata: { secret: "PRIVATE METADATA" } }],
  };
}

function testFetch({ records = source(), resendBehavior = async (_url, init) =>
  json({ id: resendIdFor(JSON.parse(init.body).to[0]) }),
  resendRetrieveBehavior,
  cursorDate = "2026-09-16", initialLedger = {}, ignoreWindowFilter = false } = {}) {
  const requests = [];
  const ledger = new Map(Object.entries(initialLedger));
  const state = { cursorDate };
  const inWindow = (url, row, field) => {
    if (ignoreWindowFilter) return true;
    const filters = url.searchParams.getAll(field);
    const lower = filters.find((filter) => filter.startsWith("gte."))?.slice(4);
    const upper = filters.find((filter) => filter.startsWith("lt."))?.slice(3);
    assert.ok(lower && upper, `missing time bounds for ${field}`);
    return row[field] >= lower && row[field] < upper;
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.host === "api.resend.com") {
      if (url.pathname === "/emails") return resendBehavior(url, init);
      if (resendRetrieveBehavior) return resendRetrieveBehavior(url, init);
      const receipt = [...ledger.entries()].find(([, value]) => value.provider_email_id === url.pathname.split("/").at(-1));
      assert.ok(receipt, "missing mocked provider receipt");
      return json({ object: "email", id: receipt[1].provider_email_id,
        to: [receipt[0].split(":")[1]], last_event: "delivered" });
    }
    if (url.pathname === "/rest/v1/rpc/expire_yutakasa_daily_report_leases") {
      let count = 0;
      for (const [key, value] of ledger) {
        if (value.status === "sending" && value.leaseExpired === true) {
          ledger.set(key, { ...value, status: "uncertain" });
          count += 1;
        }
      }
      return json(count);
    }
    if (url.pathname === "/rest/v1/yutakasa_daily_report_state") {
      return json([{ next_report_date_jst: state.cursorDate }]);
    }
    if (url.pathname === "/rest/v1/yutakasa_daily_report_deliveries") {
      const dateFilter = url.searchParams.get("report_date_jst");
      const rows = [...ledger.entries()].map(([key, value]) => ({
        report_date_jst: key.split(":")[0], recipient: key.split(":")[1], status: value.status,
        provider_email_id: value.provider_email_id ?? null,
        provider_last_event: value.provider_last_event ?? null,
        provider_checked_at: value.provider_checked_at ?? null,
      })).filter((row) => {
        if (dateFilter?.startsWith("eq.")) return row.report_date_jst === dateFilter.slice(3);
        if (dateFilter?.startsWith("lt.")) return row.report_date_jst < dateFilter.slice(3);
        if (dateFilter?.startsWith("gte.")) return row.report_date_jst >= dateFilter.slice(4);
        return true;
      });
      const status = url.searchParams.get("status")?.replace(/^eq\./u, "");
      const filtered = rows.filter((row) =>
        (!status || row.status === status) &&
        (!url.searchParams.has("provider_checked_at") || row.provider_checked_at === null) &&
        (!url.searchParams.has("recipient") || env.REPORT_RECIPIENT_1 === row.recipient || env.REPORT_RECIPIENT_2 === row.recipient));
      return json(filtered.sort((a, b) => a.report_date_jst.localeCompare(b.report_date_jst))
        .slice(0, Number(url.searchParams.get("limit")) || filtered.length));
    }
    if (url.pathname === "/rest/v1/support_tickets") {
      if (url.searchParams.has("status")) {
        const afterId = url.searchParams.get("id")?.replace(/^gt\./u, "");
        const limit = Number(url.searchParams.get("limit"));
        return json(records.openTickets.filter((row) => !afterId || row.id > afterId).slice(0, limit));
      }
      if (url.searchParams.has("id")) return json(records.tickets);
      if (url.searchParams.has("created_at")) return json(records.createdTickets.filter((row) => inWindow(url, row, "created_at")));
      if (url.searchParams.has("updated_at")) return json(records.updatedTickets.filter((row) => inWindow(url, row, "updated_at")));
    }
    if (url.pathname === "/rest/v1/support_messages" || url.pathname === "/rest/v1/support_work_logs") {
      const rows = url.pathname.endsWith("support_messages") ? records.messages : records.workLogs;
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return json(rows.filter((row) => inWindow(url, row, "created_at")).slice(offset, offset + limit));
    }
    if (url.pathname === "/rest/v1/rpc/reserve_yutakasa_daily_report_delivery") {
      const params = JSON.parse(init.body);
      const key = `${params.p_report_date_jst}:${params.p_recipient}`;
      const previous = ledger.get(key);
      if (previous) {
        if (["accepted", "uncertain", "sending"].includes(previous.status)) return json([{ ...previous, can_send: false }]);
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
    if (url.pathname === "/rest/v1/rpc/record_yutakasa_daily_report_provider_event") {
      const params = JSON.parse(init.body);
      const key = `${params.p_report_date_jst}:${params.p_recipient}`;
      const previous = ledger.get(key);
      assert.equal(previous.provider_email_id, params.p_provider_email_id);
      const next = { ...previous, provider_last_event: params.p_last_event,
        provider_checked_at: NOW.toISOString() };
      ledger.set(key, next);
      return json([{ provider_last_event: next.provider_last_event,
        provider_checked_at: next.provider_checked_at }]);
    }
    if (url.pathname === "/rest/v1/rpc/get_yutakasa_daily_report_health") {
      const params = JSON.parse(init.body);
      const rows = [...ledger.entries()].filter(([key]) =>
        [params.p_recipient_1, params.p_recipient_2].includes(key.split(":")[1]))
        .map(([, value]) => value);
      return json([{
        uncertain_count: rows.filter((row) => row.status === "uncertain").length,
        failed_count: rows.filter((row) => row.status === "failed").length,
        provider_adverse_count: rows.filter((row) =>
          ["bounced", "canceled", "complained", "failed", "suppressed"].includes(row.provider_last_event)).length,
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/advance_yutakasa_daily_report_cursor") {
      const params = JSON.parse(init.body);
      const date = params.p_report_date_jst;
      const statuses = [params.p_recipient_1, params.p_recipient_2].map((recipient) => ledger.get(`${date}:${recipient}`)?.status);
      const advanced = date === state.cursorDate && statuses.every((status) => ["accepted", "failed", "uncertain"].includes(status));
      if (advanced) state.cursorDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      return json([{ next_report_date_jst: state.cursorDate, advanced }]);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, requests, ledger, state };
}

test("09:00 JST is the boundary; the report covers the previous full JST day", () => {
  assert.equal(reportingDate(new Date("2026-09-16T23:59:59Z")), null);
  assert.equal(reportingDate(new Date("2026-09-17T00:00:00Z")), "2026-09-16");
  assert.deepEqual(reportWindow("2026-09-16"), {
    start: "2026-09-15T15:00:00.000Z",
    end: "2026-09-16T15:00:00.000Z",
  });
});

test("before 09:00 JST is a no-op even when credentials are absent", async () => {
  const result = await runDailySupportReport({ env: {}, now: new Date("2026-09-16T23:59:00Z"), fetchImpl: () => { throw new Error("must not fetch"); } });
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
  assert.equal(result.reportDateJst, "2026-09-16");
  assert.equal(result.ticketCount, 1);
  assert.equal(result.messageCount, 1);
  assert.equal(result.workLogCount, 1);
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries.filter((item) => item.sentNow).length, 2);
  assert.deepEqual(result.providerChecks.map((item) => item.event), ["delivered", "delivered"]);
  assert.equal(result.providerAdverseCount, 0);
  const sends = client.requests.filter(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails");
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
  assert.equal(client.requests.filter(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails").length, 2);
});

test("provider bounce is stored as an adverse delivery and is never automatically resent", async () => {
  const client = testFetch({ resendRetrieveBehavior: async (url) => {
    const first = url.pathname.endsWith(RESEND_ID);
    return json({ object: "email", id: first ? RESEND_ID : RESEND_ID_2,
      to: [first ? env.REPORT_RECIPIENT_1 : env.REPORT_RECIPIENT_2],
      last_event: first ? "bounced" : "delivered" });
  } });
  const first = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(first.ok, false);
  assert.equal(first.providerAdverseCount, 1);
  assert.equal(client.ledger.get(`2026-09-16:${env.REPORT_RECIPIENT_1}`).provider_last_event, "bounced");
  const second = await runDailySupportReport({ env, now: new Date("2026-09-17T01:05:00Z"), fetchImpl: client.fetchImpl });
  assert.equal(second.ok, false);
  assert.equal(second.providerAdverseCount, 1);
  assert.equal(client.requests.filter(({ url }) => url.pathname === "/emails").length, 2);
});

test("provider receipt addressed to someone else fails verification without recording delivery", async () => {
  const client = testFetch({ resendRetrieveBehavior: async (url) =>
    json({ object: "email", id: url.pathname.split("/").at(-1),
      to: ["outsider@example.com"], last_event: "delivered" }) });
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.providerChecks.map((item) => item.errorCode),
    ["provider_receipt_invalid", "provider_receipt_invalid"]);
  assert.equal(client.ledger.get(`2026-09-16:${env.REPORT_RECIPIENT_1}`).provider_last_event, undefined);
  assert.equal(client.requests.filter(({ url }) => url.pathname === "/emails").length, 2);
});

test("old uncertain sends and old bounces remain visible after the day cursor advances", async () => {
  const initialLedger = {
    [`2026-09-16:${env.REPORT_RECIPIENT_1}`]: { status: "uncertain" },
    [`2026-09-16:${env.REPORT_RECIPIENT_2}`]: { status: "accepted",
      provider_email_id: RESEND_ID_2, provider_last_event: "bounced",
      provider_checked_at: "2026-09-17T00:00:00Z" },
  };
  const client = testFetch({ cursorDate: "2026-09-26", initialLedger });
  const result = await runDailySupportReport({
    env, now: new Date("2026-09-26T00:05:00Z"), fetchImpl: client.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.unresolvedDeliveryCode, "daily_report_delivery_unresolved");
  assert.equal(result.unresolvedUncertainCount, 1);
  assert.equal(result.providerAdverseCount, 1);
  assert.equal(result.pendingFailedCount, 0);
});

test("an uncertain Resend response is recorded and never retried automatically", async () => {
  let sends = 0;
  const client = testFetch({ resendBehavior: async (_url, init) => {
    sends += 1;
    if (JSON.parse(init.body).to[0] === "owner-one@example.com") throw new Error("network broke after request");
    return json({ id: resendIdFor(JSON.parse(init.body).to[0]) });
  } });
  const first = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(first.ok, false);
  assert.deepEqual(first.deliveries.map((item) => item.status), ["uncertain", "accepted"]);
  const second = await runDailySupportReport({ env, now: new Date("2026-09-17T01:05:00Z"), fetchImpl: client.fetchImpl });
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
    return json({ id: resendIdFor(JSON.parse(init.body).to[0]) });
  } });
  const first = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.deepEqual(first.deliveries.map((item) => item.status), ["failed", "accepted"]);
  const second = await runDailySupportReport({ env, now: new Date("2026-09-17T01:05:00Z"), fetchImpl: client.fetchImpl });
  assert.equal(second.ok, true);
  assert.deepEqual(second.deliveries.map((item) => item.sentNow), [true, false]);
  const sends = client.requests.filter(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails");
  assert.equal(sends.length, 3);
  assert.equal(sends[0].init.headers["Idempotency-Key"], sends[2].init.headers["Idempotency-Key"]);
  assert.equal(sends[0].init.body, sends[2].init.body);
});

test("incomplete source data fails before any email reservation or send", async () => {
  const bad = source();
  bad.tickets = [];
  const client = testFetch({ records: bad });
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "source_ticket_detail_mismatch");
  assert.equal(client.requests.some(({ url }) => url.pathname.includes("/rpc/reserve_yutakasa_daily_report_delivery")), false);
  assert.equal(client.requests.some(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails"), false);
});

test("zero activity still creates a truthful daily report", () => {
  const report = buildDailyReport("2026-09-16", { createdTickets: [], updatedTickets: [], messages: [], workLogs: [], tickets: [], openTickets: [] }, NOW);
  assert.match(report.text, /対象期間中の新規・更新・投稿・作業記録は0件/);
  assert.match(report.text, /前日の投稿・作業記録は0件/);
  assert.match(report.text, /現在の未解決: 0件/);
  assert.match(report.text, /障害0件とは判定していません/);
  assert.equal(report.subject.includes("2026-09-16"), true);
});

test("an old unresolved ticket is counted even on a day with no new activity", () => {
  const empty = { createdTickets: [], updatedTickets: [], messages: [], workLogs: [], tickets: [],
    openTickets: [{ id: TICKET_ID, status: "waiting_user", decision_required: true,
      automation_status: "blocked_decision", updated_at: "2026-09-11T00:00:00.000Z" }] };
  const report = buildDailyReport("2026-09-16", empty, NOW);
  assert.match(report.text, /前日に動きがあったチケット: 0件/);
  assert.match(report.text, /現在の未解決: 1件/);
  assert.match(report.text, /運営判断要1件/);
  assert.match(report.text, /運営判断待ち1件/);
});

test("current unresolved pagination retrieves the 501st row", async () => {
  const openTickets = Array.from({ length: 501 }, (_, index) => ({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    status: "open", decision_required: false, automation_status: "queued",
    updated_at: "2026-09-11T00:00:00.000Z",
  }));
  const client = testFetch({ records: { createdTickets: [], updatedTickets: [], messages: [], workLogs: [], tickets: [], openTickets } });
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.currentOpenCount, 501);
  assert.equal(client.requests.filter(({ url }) => url.pathname === "/rest/v1/support_tickets" && url.searchParams.has("status")).length, 2);
  const firstSend = client.requests.find(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails");
  assert.match(JSON.parse(firstSend.init.body).text, /現在の未解決: 501件/);
});

test("message pagination counts the 501st event without exposing any body", async () => {
  const records = source();
  records.messages = Array.from({ length: 501 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    ticket_id: TICKET_ID,
    sender_type: "user",
    created_at: "2026-09-16T02:00:00.000Z",
    body: `PRIVATE MESSAGE ${index}`,
  }));
  const client = testFetch({ records });
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.messageCount, 501);
  assert.equal(client.requests.filter(({ url }) => url.pathname === "/rest/v1/support_messages").length, 2);
  const firstSend = client.requests.find(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails");
  const text = JSON.parse(firstSend.init.body).text;
  assert.match(text, /利用者501件/);
  assert.match(text, /ほか402件。時系列の表示は最大100件/);
  assert.equal(text.includes("PRIVATE MESSAGE"), false);
});

test("a row outside the requested JST window fails closed before sending", async () => {
  const records = source();
  records.messages[0].created_at = "2026-09-16T15:00:00.000Z";
  const client = testFetch({ records, ignoreWindowFilter: true });
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "source_window_mismatch");
  assert.equal(client.requests.some(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails"), false);
});

test("known work events explain progress; unknown event types never leak raw text", () => {
  assert.equal(workEventLabel("automation_claimed"), "自動調査を開始");
  assert.equal(workEventLabel("owner_decision_required"), "運営判断が必要と記録");
  assert.equal(workEventLabel("PRIVATE EVENT TYPE"), "作業記録（種別未分類）");
  const known = source();
  known.workLogs[0].event_type = "automation_replied";
  const text = buildDailyReport("2026-09-16", known, NOW).text;
  assert.match(text, /利用者へ回答/);
  assert.equal(text.includes("PRIVATE LOG"), false);
  assert.equal(text.includes("PRIVATE METADATA"), false);
});

test("the last closed day is sent immediately and one older missed day is recovered per run", async () => {
  const client = testFetch({ cursorDate: "2026-09-16" });
  const later = new Date("2026-09-19T00:05:00.000Z");
  const first = await runDailySupportReport({ env, now: later, fetchImpl: client.fetchImpl });
  assert.equal(first.reportDateJst, "2026-09-18");
  assert.deepEqual(first.recoveredReportDatesJst, ["2026-09-16"]);
  assert.equal(client.state.cursorDate, "2026-09-17");
  assert.equal(client.requests.filter(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails").length, 4);
  const second = await runDailySupportReport({ env, now: later, fetchImpl: client.fetchImpl });
  assert.deepEqual(second.recoveredReportDatesJst, ["2026-09-17"]);
  assert.equal(client.state.cursorDate, "2026-09-18");
  assert.equal(client.requests.filter(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails").length, 6);
  const third = await runDailySupportReport({ env, now: later, fetchImpl: client.fetchImpl });
  assert.deepEqual(third.recoveredReportDatesJst, []);
  assert.equal(client.state.cursorDate, "2026-09-19");
  assert.equal(client.requests.filter(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails").length, 6);
});

test("a failed latest-day query does not block an older missed day", async () => {
  const client = testFetch({ cursorDate: "2026-09-16" });
  const fetchImpl = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/support_tickets" &&
        url.searchParams.getAll("created_at").includes("gte.2026-09-17T15:00:00.000Z")) {
      return Promise.resolve(json({ code: "temporary_failure" }, 503));
    }
    return client.fetchImpl(input, init);
  };
  const result = await runDailySupportReport({ env, now: new Date("2026-09-19T00:05:00.000Z"), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "supabase_http_503");
  assert.deepEqual(result.recoveredReportDatesJst, ["2026-09-16"]);
  assert.equal(client.state.cursorDate, "2026-09-17");
  assert.equal(client.requests.filter(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails").length, 2);
});

test("a crashed send becomes uncertain after lease expiry without duplicate email", async () => {
  const pending = Object.fromEntries(
    [env.REPORT_RECIPIENT_1, env.REPORT_RECIPIENT_2].map((recipient) => [
      `2026-09-16:${recipient}`, { status: "sending", leaseExpired: true },
    ]),
  );
  const client = testFetch({ initialLedger: pending });
  const result = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.expiredLeaseCount, 2);
  assert.deepEqual(result.deliveries.map((item) => item.status), ["uncertain", "uncertain"]);
  assert.equal(client.state.cursorDate, "2026-09-17");
  assert.equal(client.requests.some(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails"), false);
});

test("a live send lease stays held and later expiration unlocks the cursor", async () => {
  const pending = Object.fromEntries(
    [env.REPORT_RECIPIENT_1, env.REPORT_RECIPIENT_2].map((recipient) => [
      `2026-09-16:${recipient}`, { status: "sending", leaseExpired: false,
        idempotency_key: `yutakasa-daily-2026-09-16-${createHash("sha256").update(recipient).digest("hex").slice(0, 16)}`, attempt_count: 1,
        subject: "stored", body: "stored" },
    ]),
  );
  const client = testFetch({ initialLedger: pending });
  const first = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(first.ok, false);
  assert.equal(client.state.cursorDate, "2026-09-16");
  assert.equal(client.requests.some(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails"), false);
  for (const [key, value] of client.ledger) client.ledger.set(key, { ...value, leaseExpired: true });
  const second = await runDailySupportReport({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(second.expiredLeaseCount, 2);
  assert.equal(client.state.cursorDate, "2026-09-17");
  assert.equal(client.requests.some(({ url }) => url.host === "api.resend.com" && url.pathname === "/emails"), false);
});
