import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { runDailyReportWatchdog as runWatchdog, WatchdogError } from "./daily-support-report-watchdog.mjs";

const NOW = new Date("2026-09-17T00:25:00.000Z");
const env = {
  YUTAKASA_SUPABASE_URL: "https://example.supabase.co",
  YUTAKASA_SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-with-sufficient-length",
  YUTAKASA_RESEND_API_KEY: "re_test-key",
  YUTAKASA_REPORT_RECIPIENT_1: "owner-one@example.com",
  YUTAKASA_REPORT_RECIPIENT_2: "owner-two@example.com",
};
const approvedRecipientHashes = new Set([
  env.YUTAKASA_REPORT_RECIPIENT_1, env.YUTAKASA_REPORT_RECIPIENT_2,
].map((address) => createHash("sha256").update(address).digest("hex")));

function runDailyReportWatchdog(options) {
  return runWatchdog({ ...options, approvedRecipientHashes });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mock({ deliveries = [
  { report_date_jst: "2026-09-16", recipient: env.YUTAKASA_REPORT_RECIPIENT_1,
    status: "accepted", provider_last_event: "delivered" },
  { report_date_jst: "2026-09-16", recipient: env.YUTAKASA_REPORT_RECIPIENT_2,
    status: "accepted", provider_last_event: "delivered" },
], nextDate = "2026-09-17", health = {}, sourceStatus = 200, resendStatus = 200 } = {}) {
  const requests = [];
  const providerMessages = new Map();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.host === "api.resend.com") {
      assert.equal(url.pathname, "/emails");
      if (resendStatus !== 200) return json({ message: "private provider error" }, resendStatus);
      const payload = JSON.parse(init.body);
      const key = init.headers["Idempotency-Key"];
      if (providerMessages.has(key)) {
        assert.deepEqual(payload, providerMessages.get(key).payload, "retry must use the exact original payload");
        return json({ id: providerMessages.get(key).id });
      }
      const id = `provider-${providerMessages.size + 1}`;
      providerMessages.set(key, { id, payload });
      return json({ id });
    }
    if (url.host !== "example.supabase.co") throw new Error("unexpected host");
    if (sourceStatus !== 200) return json({ message: "private source error" }, sourceStatus);
    if (url.pathname === "/rest/v1/yutakasa_daily_report_deliveries") return json(deliveries);
    if (url.pathname === "/rest/v1/yutakasa_daily_report_state") return json([{ next_report_date_jst: nextDate }]);
    if (url.pathname === "/rest/v1/rpc/get_yutakasa_daily_report_health") {
      return json([{ uncertain_count: 0, failed_count: 0,
        provider_adverse_count: 0, pending_overdue_count: 0, ...health }]);
    }
    throw new Error(`unexpected path ${url.pathname}`);
  };
  return { requests, providerMessages, fetchImpl };
}

test("before the report is due, the watchdog neither reads credentials nor sends mail", async () => {
  const result = await runDailyReportWatchdog({ env: {}, now: new Date("2026-09-16T23:59:00Z"),
    fetchImpl: () => { throw new Error("unexpected request"); } });
  assert.deepEqual(result, { ok: true, skipped: "before_report_due" });
});

test("a complete, healthy ledger sends no alert", async () => {
  const client = mock();
  const result = await runDailyReportWatchdog({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.deepEqual(result, { ok: true, reportDateJst: "2026-09-16", state: "healthy" });
  assert.equal(client.requests.filter(({ url }) => url.host === "api.resend.com").length, 0);
});

test("a missing report sends only the two approved operator alerts, once per date", async () => {
  const client = mock({ deliveries: [] });
  const first = await runDailyReportWatchdog({ env, now: NOW, fetchImpl: client.fetchImpl });
  const second = await runDailyReportWatchdog({ env, now: new Date("2026-09-17T14:25:00Z"),
    fetchImpl: client.fetchImpl });
  assert.equal(first.ok, false);
  assert.equal(first.state, "delivery_unresolved");
  assert.equal(second.state, "delivery_unresolved");
  assert.equal(client.providerMessages.size, 2, "Resend idempotency must suppress hourly duplicates");
  const alerts = client.requests.filter(({ url }) => url.host === "api.resend.com");
  assert.equal(alerts.length, 4);
  assert.deepEqual(alerts.slice(0, 2).map(({ init }) => JSON.parse(init.body).to[0]),
    [env.YUTAKASA_REPORT_RECIPIENT_1, env.YUTAKASA_REPORT_RECIPIENT_2]);
  for (const { init } of alerts) {
    const payload = JSON.parse(init.body);
    assert.match(payload.subject, /2026-09-16/u);
    assert.doesNotMatch(JSON.stringify(payload), /customer@example\.com|PRIVATE MESSAGE|PRIVATE SUBJECT/u);
    assert.equal(payload.to.length, 1);
  }
});

test("one missing recipient, a stale cursor, and an old unresolved delivery each trigger an alert", async () => {
  const baseline = mock();
  const oneMissing = mock({ deliveries: [
    { report_date_jst: "2026-09-16", recipient: env.YUTAKASA_REPORT_RECIPIENT_1,
      status: "accepted", provider_last_event: "delivered" },
  ] });
  const backlog = mock({ nextDate: "2026-09-16" });
  const oldFailure = mock({ health: { provider_adverse_count: 1 } });
  const latestBounce = mock({ deliveries: [
    { report_date_jst: "2026-09-16", recipient: env.YUTAKASA_REPORT_RECIPIENT_1,
      status: "accepted", provider_last_event: "bounced" },
    { report_date_jst: "2026-09-16", recipient: env.YUTAKASA_REPORT_RECIPIENT_2,
      status: "accepted", provider_last_event: "delivered" },
  ] });
  assert.equal((await runDailyReportWatchdog({ env, now: NOW, fetchImpl: baseline.fetchImpl })).state, "healthy");
  assert.equal((await runDailyReportWatchdog({ env, now: NOW, fetchImpl: oneMissing.fetchImpl })).state, "delivery_unresolved");
  assert.equal((await runDailyReportWatchdog({ env, now: NOW, fetchImpl: backlog.fetchImpl })).state, "backlog_unresolved");
  assert.equal((await runDailyReportWatchdog({ env, now: NOW, fetchImpl: oldFailure.fetchImpl })).state, "delivery_unresolved");
  assert.equal((await runDailyReportWatchdog({ env, now: NOW, fetchImpl: latestBounce.fetchImpl })).state, "delivery_unresolved");
  for (const client of [oneMissing, backlog, oldFailure, latestBounce]) assert.equal(client.providerMessages.size, 2);
});

test("source outage still produces an alert with no private exception text", async () => {
  const client = mock({ sourceStatus: 503 });
  const result = await runDailyReportWatchdog({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.state, "source_unavailable");
  assert.equal(client.providerMessages.size, 2);
  assert.doesNotMatch(JSON.stringify(result), /private source error/u);
});

test("missing mail credentials fail closed before any external call", async () => {
  for (const invalidEnv of [
    { ...env, YUTAKASA_RESEND_API_KEY: "" },
    { ...env, YUTAKASA_REPORT_RECIPIENT_1: "owner@example.com\nBcc: outsider@example.com" },
    { ...env, YUTAKASA_REPORT_RECIPIENT_2: "OWNER-ONE@example.com" },
    { ...env, YUTAKASA_REPORT_RECIPIENT_2: "unapproved@example.com" },
  ]) {
    await assert.rejects(() => runDailyReportWatchdog({ env: invalidEnv, now: NOW,
      fetchImpl: () => { throw new Error("unexpected request"); } }),
    (error) => error instanceof WatchdogError);
  }
});

test("a provider failure stays visible and never claims that the alert was accepted", async () => {
  const client = mock({ deliveries: [], resendStatus: 503 });
  const result = await runDailyReportWatchdog({ env, now: NOW, fetchImpl: client.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.notifications.length, 2);
  assert.deepEqual(result.notifications.map(({ accepted, code }) => [accepted, code]),
    [[false, "alert_http_503"], [false, "alert_http_503"]]);
  assert.equal(client.providerMessages.size, 0);
});

test("an uncertain provider response retries the same request without creating a second message", async () => {
  const client = mock({ deliveries: [] });
  let failFirstResponse = true;
  const fetchImpl = async (input, init) => {
    const response = await client.fetchImpl(input, init);
    if (new URL(String(input)).host === "api.resend.com" && failFirstResponse) {
      failFirstResponse = false;
      throw new Error("connection closed after provider accepted the mail");
    }
    return response;
  };
  const first = await runDailyReportWatchdog({ env, now: NOW, fetchImpl });
  assert.equal(first.notifications[0].code, "alert_request_uncertain");
  assert.equal(client.providerMessages.size, 2);
  const second = await runDailyReportWatchdog({ env, now: new Date("2026-09-17T01:25:00Z"), fetchImpl });
  assert.deepEqual(second.notifications.map(({ accepted }) => accepted), [true, true]);
  assert.equal(client.providerMessages.size, 2);
  assert.doesNotMatch(JSON.stringify(first), /connection closed/u);
});
