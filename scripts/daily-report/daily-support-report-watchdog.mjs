#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FIRST_REPORT_DATE_JST, nextJstDate } from "./daily-report-reliability.mjs";
import { reportingDate } from "./daily-support-report.mjs";

const FROM = "noreply@silversense.cc";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16_384;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,63}$/u;
const ADVERSE_EVENTS = new Set(["bounced", "canceled", "complained", "failed", "suppressed"]);
// SHA-256 of the two addresses explicitly approved for operator reports.
// The public repository must not contain their plaintext addresses.
const APPROVED_RECIPIENT_HASHES = new Set([
  "341581a0b84367a7387a871a0a716264e5731bad1b18313ce5935df0f7e2586d",
  "d778fa46683e797a0cc33a1e687b66c843d904b40b6109b4802f955697592ae7",
]);

export class WatchdogError extends Error {
  constructor(code) {
    super(code);
    this.name = "WatchdogError";
    this.code = code;
  }
}

function fail(code) { throw new WatchdogError(code); }

function validateEmailConfig(env, approvedRecipientHashes) {
  const resendKey = env.YUTAKASA_RESEND_API_KEY;
  const recipients = [env.YUTAKASA_REPORT_RECIPIENT_1, env.YUTAKASA_REPORT_RECIPIENT_2]
    .map((value) => typeof value === "string" ? value.trim().toLowerCase() : "");
  if (typeof resendKey !== "string" || resendKey.length < 10 || /[\r\n]/u.test(resendKey)) {
    fail("resend_key_missing_or_invalid");
  }
  if (recipients.some((value) => value.length > 254 || !ADDRESS.test(value) || value.includes("..") ||
      value.split("@")[0].endsWith(".")) || recipients[0] === recipients[1]) {
    fail("report_recipients_missing_or_invalid");
  }
  if (approvedRecipientHashes.size !== 2 || recipients.some((recipient) =>
    !approvedRecipientHashes.has(createHash("sha256").update(recipient).digest("hex")))) {
    fail("report_recipients_not_approved");
  }
  return { resendKey, recipients };
}

function validateSourceConfig(env) {
  const key = env.YUTAKASA_SUPABASE_SERVICE_ROLE_KEY;
  let url;
  try { url = new URL(env.YUTAKASA_SUPABASE_URL); } catch { fail("source_config_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      typeof key !== "string" || key.length < 20 || /[\r\n]/u.test(key)) {
    fail("source_config_invalid");
  }
  return { origin: url.origin, key };
}

async function boundedJson(response, code) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) fail(code);
  const reader = response.body?.getReader?.();
  if (!reader) fail(code);
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) fail(code);
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        fail(code);
      }
      parts.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof WatchdogError) throw error;
    fail(code);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail(code); }
}

async function sourceJson(config, relativePath, { method = "GET", body, fetchImpl }) {
  const url = new URL(relativePath, `${config.origin}/`);
  if (url.origin !== config.origin || !url.pathname.startsWith("/rest/v1/")) fail("source_path_invalid");
  let response;
  try {
    response = await fetchImpl(url, {
      method, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}`,
        Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { fail("source_unavailable"); }
  if (!response.ok) fail("source_unavailable");
  return boundedJson(response, "source_response_invalid");
}

function oneRow(payload) {
  if (!Array.isArray(payload) || payload.length !== 1 || !payload[0] || typeof payload[0] !== "object") {
    fail("source_response_invalid");
  }
  return payload[0];
}

async function reportState(config, reportDateJst, recipients, fetchImpl) {
  const query = new URLSearchParams({
    select: "report_date_jst,recipient,status,provider_last_event",
    report_date_jst: `eq.${reportDateJst}`,
    limit: "20",
  });
  const deliveries = await sourceJson(config, `rest/v1/yutakasa_daily_report_deliveries?${query}`, { fetchImpl });
  if (!Array.isArray(deliveries) || deliveries.length > 20) fail("source_response_invalid");
  const recipientRows = recipients.map((recipient) => deliveries.filter((row) => row?.recipient === recipient));
  if (recipientRows.some((rows) => rows.length !== 1 || rows[0].report_date_jst !== reportDateJst ||
      rows[0].status !== "accepted" || ADVERSE_EVENTS.has(rows[0].provider_last_event))) {
    return "delivery_unresolved";
  }

  const cursorQuery = new URLSearchParams({ select: "next_report_date_jst", id: "eq.1", limit: "1" });
  const cursor = oneRow(await sourceJson(config, `rest/v1/yutakasa_daily_report_state?${cursorQuery}`, { fetchImpl }));
  if (typeof cursor.next_report_date_jst !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(cursor.next_report_date_jst)) fail("source_response_invalid");
  if (cursor.next_report_date_jst < nextJstDate(reportDateJst)) return "backlog_unresolved";

  const health = oneRow(await sourceJson(config, "rest/v1/rpc/get_yutakasa_daily_report_health", {
    method: "POST", body: { p_recipient_1: recipients[0], p_recipient_2: recipients[1] }, fetchImpl,
  }));
  for (const key of ["uncertain_count", "failed_count", "provider_adverse_count", "pending_overdue_count"]) {
    if (!Number.isSafeInteger(health[key]) || health[key] < 0) fail("source_response_invalid");
  }
  return health.uncertain_count || health.failed_count || health.provider_adverse_count || health.pending_overdue_count
    ? "delivery_unresolved" : "healthy";
}

function alertPayload(reportDateJst, recipient) {
  // Same date, recipient and body on every run. Resend retains keys for 24h;
  // the scheduled runs for one JST report date are less than 24h apart.
  const recipientHash = createHash("sha256").update(recipient).digest("hex").slice(0, 24);
  return {
    key: `yutakasa-daily-alert-${reportDateJst}-${recipientHash}`,
    body: {
      from: `豊かさAI 日報監視 <${FROM}>`,
      to: [recipient],
      subject: `【豊かさBOT】日次対応レポートの配信確認が必要です（${reportDateJst}）`,
      text: `対象日（日本時間）: ${reportDateJst}\n\n日次対応レポートの両宛先への配信を確認できませんでした。Railwayの日報実行履歴、Supabaseの送信台帳、Resendの配達履歴を確認してください。\n\nこの通知には顧客の問い合わせ内容、メールアドレス、添付情報を含めていません。`,
    },
  };
}

async function sendAlert(config, reportDateJst, recipient, fetchImpl) {
  const payload = alertPayload(reportDateJst, recipient);
  let response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${config.resendKey}`, "Content-Type": "application/json",
        "Idempotency-Key": payload.key },
      body: JSON.stringify(payload.body),
    });
  } catch { return { accepted: false, code: "alert_request_uncertain" }; }
  if (!response.ok) return { accepted: false, code: `alert_http_${response.status}` };
  let receipt;
  try { receipt = await boundedJson(response, "alert_receipt_invalid"); }
  catch { return { accepted: false, code: "alert_receipt_invalid" }; }
  if (typeof receipt?.id !== "string" || !/^[A-Za-z0-9_-]{8,255}$/u.test(receipt.id)) {
    return { accepted: false, code: "alert_receipt_invalid" };
  }
  return { accepted: true, providerEmailId: receipt.id };
}

export async function runDailyReportWatchdog({ env = process.env, now = new Date(),
  fetchImpl = globalThis.fetch, approvedRecipientHashes = APPROVED_RECIPIENT_HASHES } = {}) {
  const reportDateJst = reportingDate(now);
  if (reportDateJst === null || reportDateJst < FIRST_REPORT_DATE_JST) {
    return { ok: true, skipped: "before_report_due" };
  }
  const emailConfig = validateEmailConfig(env, approvedRecipientHashes);
  let state;
  try {
    const sourceConfig = validateSourceConfig(env);
    state = await reportState(sourceConfig, reportDateJst, emailConfig.recipients, fetchImpl);
  } catch (error) {
    state = error instanceof WatchdogError ? error.code : "source_unavailable";
  }
  if (state === "healthy") return { ok: true, reportDateJst, state };

  const notifications = [];
  for (const [index, recipient] of emailConfig.recipients.entries()) {
    const result = await sendAlert(emailConfig, reportDateJst, recipient, fetchImpl);
    notifications.push({ recipientNumber: index + 1, ...result });
  }
  return { ok: false, reportDateJst, state, notifications };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runDailyReportWatchdog().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 2;
    },
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false,
        code: error instanceof WatchdogError ? error.code : "watchdog_unexpected_failure" })}\n`);
      process.exitCode = 1;
    },
  );
}
