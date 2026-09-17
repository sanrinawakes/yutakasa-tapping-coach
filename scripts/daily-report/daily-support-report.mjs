#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  FIRST_REPORT_DATE_JST,
  PROVIDER_EVENTS,
  reportDatesToRun,
  workEventLabel,
} from "./daily-report-reliability.mjs";

const DEFAULT_FROM = "noreply@silversense.cc";
const APP_SUPPORT_URL = "https://yutakasa-tapping-coach.vercel.app/admin/support";
const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const MAX_LISTED_TICKETS = 50;
const MAX_LISTED_EVENTS = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PROVIDER_CHECK_BATCH = 4;
const PROVIDER_RECHECK_MS = 12 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const CATEGORY = new Set(["technical", "login", "quality", "how_to", "feature", "billing", "other"]);
const TICKET_STATUS = new Set(["open", "in_progress", "waiting_user", "resolved"]);
const AUTOMATION_STATUS = new Set(["queued", "investigating", "awaiting_repair", "manual_review", "blocked_decision", "completed", "failed"]);
const MESSAGE_SENDER = new Set(["user", "admin", "system"]);
const MONITOR_STATUS = new Set(["healthy", "action_required", "failed", "abandoned"]);
const MONITOR_REASON = /^[A-Za-z0-9][A-Za-z0-9_]{0,127}$/u;
const EXPECTED_MONITOR_SLOTS = 144;
const REPAIR_STATUS = new Set(["pending_merge", "observing", "verified", "failed", "abandoned"]);
const SHA = /^[a-f0-9]{40}$/u;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{8,160}$/u;
const GITHUB_REPO = "sanrinawakes/yutakasa-tapping-coach";
const MAX_REPAIR_ITEMS = 5;
const SYNTHETIC_SUPPORT_EMAIL = /^yutakasa-auto-smoke\+.*@example\.invalid$/iu;
const REQUIRED_REPAIR_CHECKS = ["source-repair-verify", "ai-repair-independent-review"];

export class DailyReportError extends Error {
  constructor(code) {
    super(code);
    this.name = "DailyReportError";
    this.code = code;
  }
}

function fail(code) {
  throw new DailyReportError(code);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function jstParts(instant) {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) fail("clock_invalid");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour) };
}

export function reportingDate(now = new Date()) {
  const parts = jstParts(now);
  if (parts.hour < 9) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1)).toISOString().slice(0, 10);
}

export function reportWindow(date) {
  if (!validDate(date)) fail("report_date_invalid");
  const startMs = Date.parse(`${date}T00:00:00.000Z`) - 9 * 60 * 60 * 1000;
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 86_400_000).toISOString() };
}

function jstTime(value) {
  if (!validTimestamp(value)) fail("source_timestamp_invalid");
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(value)) + " JST";
}

function requireSecret(env, key, minimum) {
  const value = env[key];
  if (typeof value !== "string" || value.length < minimum || /[\r\n]/u.test(value)) fail(`missing_or_invalid_${key.toLowerCase()}`);
  return value;
}

export function validateEnvironment(env = process.env) {
  const supabase = requireSecret(env, "SUPABASE_URL", 12);
  let url;
  try { url = new URL(supabase); } catch { fail("supabase_url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("supabase_url_invalid");
  const serviceKey = requireSecret(env, "SUPABASE_SERVICE_ROLE_KEY", 20);
  const resendKey = requireSecret(env, "RESEND_API_KEY", 10);
  const from = env.FROM_EMAIL?.trim() || DEFAULT_FROM;
  const validAddress = (value) =>
    typeof value === "string" && value.length >= 5 && value.length <= 254 &&
    /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,63}$/u.test(value) &&
    !value.includes("..") && !value.split("@")[0].endsWith(".");
  if (!validAddress(from)) fail("from_email_invalid");
  const recipients = [env.REPORT_RECIPIENT_1?.trim().toLowerCase(), env.REPORT_RECIPIENT_2?.trim().toLowerCase()];
  if (recipients.some((recipient) => !validAddress(recipient)) || recipients[0] === recipients[1]) {
    fail("report_recipients_invalid");
  }
  return { supabaseUrl: url.origin, serviceKey, resendKey, from, recipients };
}

async function boundedJson(response, code) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) fail(`${code}_too_large`);
  const reader = response.body?.getReader?.();
  if (!reader) fail(`${code}_read_failed`);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) fail(`${code}_read_failed`);
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        fail(`${code}_too_large`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof DailyReportError) throw error;
    fail(`${code}_read_failed`);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(`${code}_invalid_json`); }
}

async function supabaseRequest(config, relativePath, { method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(relativePath, `${config.supabaseUrl}/`);
  if (url.origin !== config.supabaseUrl || !url.pathname.startsWith("/rest/v1/")) fail("supabase_path_invalid");
  let response;
  try {
    response = await fetchImpl(url, {
      method, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { fail("supabase_request_failed"); }
  if (!response.ok) fail(`supabase_http_${response.status}`);
  return boundedJson(response, "supabase_response");
}

async function listByWindow(config, table, select, timeField, window, fetchImpl) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      select,
      [timeField]: `gte.${window.start}`,
      [`${timeField}_upper`]: `lt.${window.end}`,
      order: `${timeField}.asc,id.asc`,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    // PostgREST requires repeated filter keys for the two bounds.
    query.delete(`${timeField}_upper`);
    query.append(timeField, `lt.${window.end}`);
    const batch = await supabaseRequest(config, `rest/v1/${table}?${query}`, { fetchImpl });
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE) fail("source_page_invalid");
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  fail("source_page_limit_exceeded");
}

async function listTicketsByIds(config, ids, fetchImpl) {
  const rows = [];
  const ordered = [...ids].sort();
  for (let index = 0; index < ordered.length; index += 100) {
    const batch = ordered.slice(index, index + 100);
    const query = new URLSearchParams({
      select: "id,user_email,category,status,decision_required,automation_status,created_at,updated_at",
      id: `in.(${batch.join(",")})`,
      limit: "100",
    });
    const result = await supabaseRequest(config, `rest/v1/support_tickets?${query}`, { fetchImpl });
    if (!Array.isArray(result) || result.length !== batch.length) fail("source_ticket_detail_mismatch");
    rows.push(...result);
  }
  return rows;
}

async function listCurrentOpenTickets(config, fetchImpl) {
  const rows = [];
  let afterId = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      select: "id,user_email,status,decision_required,automation_status,updated_at",
      status: "in.(open,in_progress,waiting_user)",
      order: "id.asc",
      limit: String(PAGE_SIZE),
    });
    if (afterId) query.set("id", `gt.${afterId}`);
    const batch = await supabaseRequest(config, `rest/v1/support_tickets?${query}`, { fetchImpl });
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE) fail("open_ticket_page_invalid");
    if (batch.length && (!UUID.test(batch.at(-1)?.id) || (afterId && batch.at(-1).id <= afterId))) {
      fail("open_ticket_page_invalid");
    }
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
    afterId = batch.at(-1).id;
  }
  fail("open_ticket_page_limit_exceeded");
}

function assertInWindow(value, window) {
  if (!validTimestamp(value) || Date.parse(value) < Date.parse(window.start) ||
      Date.parse(value) >= Date.parse(window.end)) fail("source_window_mismatch");
}

export function validateSource(source, window) {
  if (!source || !Array.isArray(source.createdTickets) || !Array.isArray(source.updatedTickets) ||
      !Array.isArray(source.messages) || !Array.isArray(source.workLogs) ||
      !Array.isArray(source.tickets) || !Array.isArray(source.openTickets)) fail("source_schema_invalid");
  const touched = new Set();
  const createdIds = new Set();
  const updatedIds = new Set();
  const checkTicketReference = (row, field) => {
    if (!UUID.test(row?.id) || !validTimestamp(row.created_at) || !validTimestamp(row.updated_at)) fail("source_ticket_invalid");
    assertInWindow(row[field], window);
    touched.add(row.id);
  };
  source.createdTickets.forEach((row) => {
    checkTicketReference(row, "created_at");
    if (createdIds.has(row.id)) fail("source_ticket_duplicate");
    createdIds.add(row.id);
  });
  source.updatedTickets.forEach((row) => {
    checkTicketReference(row, "updated_at");
    if (updatedIds.has(row.id)) fail("source_ticket_duplicate");
    updatedIds.add(row.id);
  });
  const messageIds = new Set();
  for (const row of source.messages) {
    if (!UUID.test(row?.id) || messageIds.has(row.id) || !UUID.test(row.ticket_id) ||
        !MESSAGE_SENDER.has(row.sender_type)) fail("source_message_invalid");
    assertInWindow(row.created_at, window);
    messageIds.add(row.id); touched.add(row.ticket_id);
  }
  const logIds = new Set();
  for (const row of source.workLogs) {
    if (!UUID.test(row?.id) || logIds.has(row.id) || !UUID.test(row.ticket_id) ||
        typeof row.event_type !== "string" || row.event_type.length < 1) fail("source_log_invalid");
    assertInWindow(row.created_at, window);
    logIds.add(row.id); touched.add(row.ticket_id);
  }
  const ticketIds = new Set();
  for (const row of source.tickets) {
    if (!UUID.test(row?.id) || ticketIds.has(row.id) || !CATEGORY.has(row.category) ||
        typeof row.user_email !== "string" || !row.user_email ||
        !TICKET_STATUS.has(row.status) || !AUTOMATION_STATUS.has(row.automation_status) ||
        typeof row.decision_required !== "boolean" || !validTimestamp(row.created_at) ||
        !validTimestamp(row.updated_at)) fail("source_ticket_invalid");
    ticketIds.add(row.id);
  }
  if (ticketIds.size !== touched.size || [...touched].some((id) => !ticketIds.has(id))) fail("source_ticket_detail_mismatch");
  const openTicketIds = new Set();
  for (const row of source.openTickets) {
    if (!UUID.test(row?.id) || openTicketIds.has(row.id) ||
        typeof row.user_email !== "string" || !row.user_email ||
        !["open", "in_progress", "waiting_user"].includes(row.status) ||
        !AUTOMATION_STATUS.has(row.automation_status) ||
        typeof row.decision_required !== "boolean" || !validTimestamp(row.updated_at)) {
      fail("open_ticket_invalid");
    }
    openTicketIds.add(row.id);
  }
  return source;
}

export async function collectReportSource(config, window, fetchImpl = globalThis.fetch) {
  const [createdTickets, updatedTickets, messages, workLogs, openTickets] = await Promise.all([
    listByWindow(config, "support_tickets", "id,created_at,updated_at", "created_at", window, fetchImpl),
    listByWindow(config, "support_tickets", "id,created_at,updated_at", "updated_at", window, fetchImpl),
    listByWindow(config, "support_messages", "id,ticket_id,sender_type,created_at", "created_at", window, fetchImpl),
    listByWindow(config, "support_work_logs", "id,ticket_id,event_type,created_at", "created_at", window, fetchImpl),
    listCurrentOpenTickets(config, fetchImpl),
  ]);
  const ids = new Set([
    ...createdTickets.map((row) => row.id),
    ...updatedTickets.map((row) => row.id),
    ...messages.map((row) => row.ticket_id),
    ...workLogs.map((row) => row.ticket_id),
  ]);
  if ([...ids].some((id) => !UUID.test(id))) fail("source_ticket_id_invalid");
  const tickets = await listTicketsByIds(config, ids, fetchImpl);
  // Test tickets can be present briefly during a production E2E. Exclude their
  // complete activity, including messages and work logs, from owner reports.
  const syntheticIds = new Set(tickets.filter((row) =>
    typeof row.user_email === "string" && SYNTHETIC_SUPPORT_EMAIL.test(row.user_email)
  ).map((row) => row.id));
  return validateSource({
    createdTickets: createdTickets.filter((row) => !syntheticIds.has(row.id)),
    updatedTickets: updatedTickets.filter((row) => !syntheticIds.has(row.id)),
    messages: messages.filter((row) => !syntheticIds.has(row.ticket_id)),
    workLogs: workLogs.filter((row) => !syntheticIds.has(row.ticket_id)),
    tickets: tickets.filter((row) => !syntheticIds.has(row.id)),
    openTickets: openTickets.filter((row) =>
      typeof row.user_email !== "string" || !SYNTHETIC_SUPPORT_EMAIL.test(row.user_email)
    ),
  }, window);
}

export function summarizeMonitorRows(rows, window) {
  if (!Array.isArray(rows)) fail("monitor_rows_invalid");
  if (rows.length === 0) return { state: "missing", completedCount: 0 };
  const statusCounts = Object.fromEntries([...MONITOR_STATUS].map((status) => [status, 0]));
  const reasonCounts = new Map();
  const runIds = new Set();
  const observedHours = new Set();
  const observedSlots = new Set();
  let alertDispatches = 0;
  let repairDispatches = 0;
  for (const row of rows) {
    if (!UUID.test(row?.run_id) || runIds.has(row.run_id) ||
        !validTimestamp(row.started_at) || !MONITOR_STATUS.has(row.status) ||
        !Array.isArray(row.reason_codes) || row.reason_codes.length > 32 ||
        row.reason_codes.some((code) => typeof code !== "string" || !MONITOR_REASON.test(code)) ||
        typeof row.alert_dispatched !== "boolean" || typeof row.repair_dispatched !== "boolean") {
      fail("monitor_rows_invalid");
    }
    assertInWindow(row.finished_at, window);
    runIds.add(row.run_id);
    statusCounts[row.status] += 1;
    for (const reason of new Set(row.reason_codes)) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    if (row.alert_dispatched) alertDispatches += 1;
    if (row.repair_dispatched) repairDispatches += 1;
    const hour = Math.floor((Date.parse(row.started_at) - Date.parse(window.start)) / 3_600_000);
    if (hour >= 0 && hour < 24) observedHours.add(hour);
    const slot = Math.floor((Date.parse(row.started_at) - Date.parse(window.start)) / 600_000);
    if (slot >= 0 && slot < EXPECTED_MONITOR_SLOTS) observedSlots.add(slot);
  }
  return {
    state: "observed",
    completedCount: rows.length,
    observedHourCount: observedHours.size,
    observedSlotCount: observedSlots.size,
    statusCounts,
    reasonCounts: [...reasonCounts].sort(([a], [b]) => a.localeCompare(b)),
    alertDispatches,
    repairDispatches,
  };
}

export async function collectMonitorSummary(config, window, fetchImpl = globalThis.fetch) {
  const rows = [];
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        select: "run_id,started_at,finished_at,status,reason_codes,alert_dispatched,repair_dispatched",
        run_kind: "eq.scheduled",
        finished_at: `gte.${window.start}`,
        order: "finished_at.asc,run_id.asc",
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      query.append("finished_at", `lt.${window.end}`);
      const batch = await supabaseRequest(config, `rest/v1/yutakasa_monitor_runs?${query}`, { fetchImpl });
      if (!Array.isArray(batch) || batch.length > PAGE_SIZE) fail("monitor_rows_invalid");
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) return summarizeMonitorRows(rows, window);
    }
  } catch {
    // The monitor table is introduced separately; reporting must remain truthful
    // while the monitor is unavailable or its schema has not been applied.
    return { state: "unavailable" };
  }
  return { state: "unavailable" };
}

function monitorSummaryLines(summary) {
  if (summary?.state === "missing") {
    return ["障害監視: 前日の完了記録0件。監視結果を確認できないため、障害0件とは判定していません。"];
  }
  if (summary?.state !== "observed") {
    return ["障害監視: 実行記録を取得できません。監視結果を確認できないため、障害0件とは判定していません。"];
  }
  const counts = summary.statusCounts;
  const lines = [
    `障害監視の完了記録（確認できた実行のみ）: ${summary.completedCount}件（記録のある10分枠${summary.observedSlotCount}/${EXPECTED_MONITOR_SLOTS}、時間帯${summary.observedHourCount}/24、正常${counts.healthy}件、要対応${counts.action_required}件、失敗${counts.failed}件、期限切れ${counts.abandoned}件）`,
    `通知処理: GitHubへの警告依頼${summary.alertDispatches}件、AI調査依頼${summary.repairDispatches}件。AI修正・PR/issueの結果は未確認です。依頼の受理は本番復旧の完了を示しません。`,
  ];
  if (summary.observedSlotCount < EXPECTED_MONITOR_SLOTS) {
    lines.push("監視の完了記録がない10分枠があります。前日全体が正常とは判定していません。");
  }
  if (summary.reasonCounts.length > 0) {
    const listed = summary.reasonCounts.slice(0, 20).map(([code, count]) => `${code} ${count}件`);
    lines.push(`検知・失敗理由: ${listed.join("、")}`);
    if (summary.reasonCounts.length > 20) lines.push(`ほか${summary.reasonCounts.length - 20}種類の理由があります。`);
  }
  return lines;
}

function repairTimestampInWindow(value, window) {
  return validTimestamp(value) && Date.parse(value) >= Date.parse(window.start) &&
    Date.parse(value) < Date.parse(window.end);
}

function validateRepairRelease(row) {
  if (!Number.isSafeInteger(row?.pr_number) || row.pr_number < 1 ||
      !SHA.test(row.head_sha) || !REPAIR_STATUS.has(row.status) ||
      !validTimestamp(row.created_at) ||
      (row.merge_sha !== null && !SHA.test(row.merge_sha)) ||
      (row.merge_recorded_at !== null && !validTimestamp(row.merge_recorded_at)) ||
      (row.verified_at !== null && !validTimestamp(row.verified_at)) ||
      (row.deployment_id !== null && !DEPLOYMENT_ID.test(row.deployment_id)) ||
      !Number.isSafeInteger(row.healthy_count) || row.healthy_count < 0 ||
      ((row.status === "pending_merge" || row.status === "abandoned") !== (row.merge_sha === null)) ||
      (row.merge_sha !== null && row.merge_recorded_at === null) ||
      (row.status === "verified" && (!row.verified_at || !row.deployment_id || row.healthy_count < 3))) {
    fail("repair_release_invalid");
  }
}

async function githubRepairJson(pathname, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}${pathname}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch { fail("github_request_failed"); }
  if (!response.ok) fail(`github_http_${response.status}`);
  return boundedJson(response, "github_response");
}

async function repairCiStatus(release, fetchImpl) {
  try {
    const [pr, checks, statuses] = await Promise.all([
      githubRepairJson(`/pulls/${release.pr_number}`, fetchImpl),
      githubRepairJson(`/commits/${release.head_sha}/check-runs?per_page=100`, fetchImpl),
      githubRepairJson(`/commits/${release.head_sha}/status`, fetchImpl),
    ]);
    if (pr?.number !== release.pr_number || pr?.head?.sha !== release.head_sha ||
        pr?.head?.repo?.full_name !== GITHUB_REPO || pr?.base?.ref !== "main") return "mismatch";
    if (!Number.isSafeInteger(checks?.total_count) || checks.total_count > 100 ||
        !Array.isArray(checks.check_runs) || checks.check_runs.length !== checks.total_count ||
        statuses?.sha !== release.head_sha || !Array.isArray(statuses.statuses)) return "unknown";
    const states = REQUIRED_REPAIR_CHECKS.map((name) => {
      const matching = checks.check_runs.filter((check) =>
        check?.name === name && check?.head_sha === release.head_sha &&
        check?.app?.slug === "github-actions" && Number.isSafeInteger(check?.id));
      const latest = matching.sort((a, b) => b.id - a.id)[0];
      if (!latest || latest.status !== "completed") return "pending";
      return latest.conclusion === "success" ? "passed" : "failed";
    });
    const vercel = statuses.statuses.find((status) => status?.context === "Vercel");
    states.push(!vercel || vercel.state === "pending" ? "pending" :
      vercel.state === "success" && vercel.description === "Deployment has completed" ? "passed" : "failed");
    return states.includes("failed") ? "failed" : states.includes("pending") ? "pending" : "passed";
  } catch { return "unknown"; }
}

export async function collectRepairProgress(config, window, fetchImpl = globalThis.fetch) {
  try {
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        select: "pr_number,head_sha,merge_sha,status,created_at,merge_recorded_at,deployment_id,healthy_count,verified_at",
        order: "pr_number.asc", limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE),
      });
      const batch = await supabaseRequest(config, `rest/v1/yutakasa_repair_releases?${query}`, { fetchImpl });
      if (!Array.isArray(batch) || batch.length > PAGE_SIZE) fail("repair_releases_invalid");
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) fail("repair_release_page_limit_exceeded");
    }
    const ids = new Set();
    for (const row of rows) {
      validateRepairRelease(row);
      if (ids.has(row.pr_number)) fail("repair_release_duplicate");
      ids.add(row.pr_number);
    }
    const isActive = (row) => ["pending_merge", "observing", "failed"].includes(row.status);
    const relevant = rows.filter((row) => isActive(row) ||
      repairTimestampInWindow(row.created_at, window) ||
      repairTimestampInWindow(row.merge_recorded_at, window) ||
      repairTimestampInWindow(row.verified_at, window));
    const listed = relevant.sort((a, b) => b.pr_number - a.pr_number).slice(0, MAX_REPAIR_ITEMS);
    const entries = await Promise.all(listed.map(async (row) => ({
      prNumber: row.pr_number, status: row.status, healthyCount: row.healthy_count,
      ci: await repairCiStatus(row, fetchImpl),
    })));
    return {
      state: "observed",
      createdCount: rows.filter((row) => repairTimestampInWindow(row.created_at, window)).length,
      mergedCount: rows.filter((row) => repairTimestampInWindow(row.merge_recorded_at, window)).length,
      verifiedCount: rows.filter((row) => repairTimestampInWindow(row.verified_at, window)).length,
      activeCount: rows.filter(isActive).length,
      relevantCount: relevant.length,
      entries,
    };
  } catch { return { state: "unavailable" }; }
}

function repairProgressLines(progress) {
  if (progress?.state !== "observed") {
    return ["自動修正PR: 専用台帳を取得できません。PR・CI・本番確認の結果は未確認です。"];
  }
  const lines = [
    `自動修正PR（専用台帳）: 前日登録${progress.createdCount}件、前日マージ記録${progress.mergedCount}件、前日本番検証完了${progress.verifiedCount}件。集計時点の未完了${progress.activeCount}件。`,
  ];
  if (progress.relevantCount === 0) lines.push("前日の記録と集計時点の未完了PRは0件です。これは他の手動PRを含みません。");
  const labels = { pending_merge: "マージ待ち", observing: "本番観測中",
    verified: "本番検証済み", failed: "本番観測失敗", abandoned: "中止" };
  const ciLabels = { passed: "必須チェック成功", failed: "必須チェック失敗",
    pending: "必須チェック未完了", unknown: "CI未確認", mismatch: "台帳とGitHub不一致" };
  for (const item of progress.entries) {
    lines.push(`PR #${item.prNumber} | ${labels[item.status]}${item.status === "observing" ? `（正常観測${item.healthyCount}/3件）` : ""} | CI: ${ciLabels[item.ci]} | https://github.com/${GITHUB_REPO}/pull/${item.prNumber}`);
  }
  if (progress.relevantCount > progress.entries.length) {
    lines.push(`ほか${progress.relevantCount - progress.entries.length}件。詳細表示は最大${MAX_REPAIR_ITEMS}件です。`);
  }
  lines.push("CIは表示したPRのGitHubチェックを確認した時点の結果です。本番検証済みは専用台帳の3回連続観測の記録を指します。");
  return lines;
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  return counts;
}

function lastEventTime(ticketId, source) {
  const values = [
    ...source.messages.filter((row) => row.ticket_id === ticketId).map((row) => row.created_at),
    ...source.workLogs.filter((row) => row.ticket_id === ticketId).map((row) => row.created_at),
    ...source.createdTickets.filter((row) => row.id === ticketId).map((row) => row.created_at),
    ...source.updatedTickets.filter((row) => row.id === ticketId).map((row) => row.updated_at),
  ];
  return values.sort().at(-1);
}

export function buildDailyReport(date, source, preparedAt = new Date(), monitorSummary = { state: "unavailable" }, repairProgress = { state: "unavailable" }) {
  const window = reportWindow(date);
  validateSource(source, window);
  const messages = countBy(source.messages, "sender_type");
  const created = new Set(source.createdTickets.map((row) => row.id));
  const updated = new Set(source.updatedTickets.map((row) => row.id));
  const sorted = [...source.tickets].sort((a, b) => a.id.localeCompare(b.id));
  const currentOpenByStatus = countBy(source.openTickets, "status");
  const actionRequired = source.openTickets.filter((row) => row.decision_required ||
    ["manual_review", "failed", "blocked_decision"].includes(row.automation_status))
    .sort((a, b) => a.id.localeCompare(b.id));
  const senderLabels = { user: "利用者投稿", admin: "運営返信", system: "システム投稿" };
  const events = [
    ...source.messages.map((row) => ({ id: row.id, ticketId: row.ticket_id, at: row.created_at, label: senderLabels[row.sender_type] })),
    ...source.workLogs.map((row) => ({ id: row.id, ticketId: row.ticket_id, at: row.created_at, label: workEventLabel(row.event_type) })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const categoryLabels = {
    technical: "技術", login: "ログイン", quality: "回答品質", how_to: "使い方",
    feature: "機能", billing: "請求・契約", other: "その他",
  };
  const statusLabels = { open: "未対応", in_progress: "対応中", waiting_user: "利用者回答待ち", resolved: "解決済み" };
  const automationLabels = {
    queued: "待機", investigating: "調査中", awaiting_repair: "修正PR待ち",
    manual_review: "運営確認待ち", blocked_decision: "運営判断待ち",
    completed: "完了", failed: "自動処理失敗",
  };
  const actionLines = actionRequired.slice(0, MAX_LISTED_TICKETS).map((ticket) =>
    `ID ${ticket.id} | 自動処理:${automationLabels[ticket.automation_status]}` +
    `${ticket.decision_required ? " | 運営判断要" : ""}` +
    ` | 最終更新 ${jstTime(ticket.updated_at)}`);
  if (actionRequired.length > MAX_LISTED_TICKETS) {
    actionLines.push(`ほか${actionRequired.length - MAX_LISTED_TICKETS}件。全件は管理画面で確認してください。`);
  }
  const lines = [
    `対象期間: ${date} 00:00–24:00（日本時間）`,
    `作成日時: ${jstTime(preparedAt.toISOString())}`,
    "データ元: 豊かさBOTの問い合わせDB。状態は作成時点の値です。",
    "",
    `現在の未解決: ${source.openTickets.length}件（未対応${currentOpenByStatus.get("open") || 0}件、対応中${currentOpenByStatus.get("in_progress") || 0}件、利用者回答待ち${currentOpenByStatus.get("waiting_user") || 0}件）`,
    `うち運営判断要${source.openTickets.filter((row) => row.decision_required).length}件、自動処理失敗${source.openTickets.filter((row) => row.automation_status === "failed").length}件、運営判断待ち${source.openTickets.filter((row) => row.automation_status === "blocked_decision").length}件、運営確認待ち${source.openTickets.filter((row) => row.automation_status === "manual_review").length}件`,
    `現在、運営が対応するチケット: ${actionRequired.length}件`,
    ...actionLines,
    "",
    `前日に動きがあったチケット: ${sorted.length}件（新規${created.size}件、更新時刻が期間内${updated.size}件・新規を含む）`,
    `やりとり: 利用者${messages.get("user") || 0}件、運営${messages.get("admin") || 0}件、システム${messages.get("system") || 0}件`,
    `問い合わせへの作業記録: ${source.workLogs.length}件`,
    `前日の対象チケットで要運営判断: ${sorted.filter((row) => row.decision_required).length}件`,
    ...monitorSummaryLines(monitorSummary),
    ...repairProgressLines(repairProgress),
    "",
    `前日のやりとり・作業時系列: ${events.length}件`,
  ];
  if (events.length === 0) lines.push("前日の投稿・作業記録は0件です。");
  for (const event of events.slice(0, MAX_LISTED_EVENTS)) {
    lines.push(`${jstTime(event.at)} | ID ${event.ticketId} | ${event.label}`);
  }
  if (events.length > MAX_LISTED_EVENTS) lines.push(`ほか${events.length - MAX_LISTED_EVENTS}件。時系列の表示は最大${MAX_LISTED_EVENTS}件です。`);
  lines.push("", "前日に動きがあったチケット:");
  if (sorted.length === 0) lines.push("対象期間中の新規・更新・投稿・作業記録は0件です。現在の未解決件数は上記のとおりです。");
  for (const ticket of sorted.slice(0, MAX_LISTED_TICKETS)) {
    const ticketMessages = source.messages.filter((row) => row.ticket_id === ticket.id);
    const ticketLogs = source.workLogs.filter((row) => row.ticket_id === ticket.id);
    lines.push(
      `ID ${ticket.id} | ${categoryLabels[ticket.category]} | ${statusLabels[ticket.status]} | 自動処理:${automationLabels[ticket.automation_status]}` +
      `${ticket.decision_required ? " | 運営判断要" : ""}` +
      ` | 投稿${ticketMessages.length}件・作業記録${ticketLogs.length}件` +
      ` | 最終記録 ${jstTime(lastEventTime(ticket.id, source))}`,
    );
  }
  if (sorted.length > MAX_LISTED_TICKETS) lines.push(`ほか${sorted.length - MAX_LISTED_TICKETS}件。全件は管理画面で確認してください。`);
  lines.push("", `管理画面: ${APP_SUPPORT_URL}`, "", "相談本文、氏名、メールアドレス、添付、内部ログの原文は掲載していません。", "本メールはDB上の記録の要約です。メール受理、配達、本番復旧を示すものではありません。");
  return { subject: `【豊かさBOT】問い合わせ・障害対応 日報｜${date}（日本時間）`, text: lines.join("\n") };
}

function oneRpcRow(payload, code) {
  if (!Array.isArray(payload) || payload.length !== 1 || !payload[0] || typeof payload[0] !== "object") fail(code);
  return payload[0];
}

function payloadHash(subject, text) {
  return createHash("sha256").update(`${subject}\n${text}`).digest("hex");
}

function idempotencyKey(date, recipient) {
  return `yutakasa-daily-${date}-${createHash("sha256").update(recipient).digest("hex").slice(0, 16)}`;
}

async function readExistingDeliveries(config, date, fetchImpl) {
  const query = new URLSearchParams({
    select: "recipient,status",
    report_date_jst: `eq.${date}`,
    recipient: `in.(${config.recipients.join(",")})`,
    limit: "2",
  });
  const rows = await supabaseRequest(config, `rest/v1/yutakasa_daily_report_deliveries?${query}`, { fetchImpl });
  if (!Array.isArray(rows) || rows.length > 2) fail("ledger_status_invalid");
  const statuses = new Map();
  for (const row of rows) {
    if (!config.recipients.includes(row?.recipient) || !["sending", "accepted", "uncertain", "failed"].includes(row.status) ||
        statuses.has(row.recipient)) fail("ledger_status_invalid");
    statuses.set(row.recipient, row.status);
  }
  return statuses;
}

async function expireStaleLeases(config, fetchImpl) {
  const count = await supabaseRequest(config, "rest/v1/rpc/expire_yutakasa_daily_report_leases", {
    method: "POST", body: {}, fetchImpl,
  });
  if (!Number.isSafeInteger(count) || count < 0 || count > 100) fail("ledger_lease_expiry_invalid");
  return count;
}

async function readReportCursor(config, fetchImpl) {
  const rows = await supabaseRequest(config,
    "rest/v1/yutakasa_daily_report_state?select=next_report_date_jst&id=eq.1&limit=1",
    { fetchImpl });
  if (!Array.isArray(rows) || rows.length !== 1 ||
      !validDate(rows[0]?.next_report_date_jst) ||
      rows[0].next_report_date_jst < FIRST_REPORT_DATE_JST) fail("report_cursor_invalid");
  return rows[0].next_report_date_jst;
}

async function earliestFailedDate(config, cursorDate, fetchImpl) {
  const query = new URLSearchParams({
    select: "report_date_jst,recipient,status",
    report_date_jst: `lt.${cursorDate}`,
    recipient: `in.(${config.recipients.join(",")})`,
    status: "eq.failed",
    order: "report_date_jst.asc,recipient.asc",
    limit: "1",
  });
  const rows = await supabaseRequest(config,
    `rest/v1/yutakasa_daily_report_deliveries?${query}`, { fetchImpl });
  if (!Array.isArray(rows) || rows.length > 1) fail("report_retry_queue_invalid");
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!validDate(row?.report_date_jst) || row.report_date_jst >= cursorDate ||
      row.report_date_jst < FIRST_REPORT_DATE_JST ||
      !config.recipients.includes(row.recipient) || row.status !== "failed") {
    fail("report_retry_queue_invalid");
  }
  return row.report_date_jst;
}

async function advanceReportCursor(config, date, fetchImpl) {
  const payload = await supabaseRequest(config,
    "rest/v1/rpc/advance_yutakasa_daily_report_cursor", {
      method: "POST", fetchImpl,
      body: { p_report_date_jst: date,
        p_recipient_1: config.recipients[0], p_recipient_2: config.recipients[1] },
    });
  const row = oneRpcRow(payload, "report_cursor_advance_invalid");
  if (!validDate(row.next_report_date_jst) || typeof row.advanced !== "boolean") {
    fail("report_cursor_advance_invalid");
  }
  return row;
}

async function reserveDelivery(config, date, recipient, report, fetchImpl) {
  const payload = await supabaseRequest(config, "rest/v1/rpc/reserve_yutakasa_daily_report_delivery", {
    method: "POST", fetchImpl,
    body: {
      p_report_date_jst: date,
      p_recipient: recipient,
      p_subject: report.subject,
      p_body: report.text,
      p_payload_sha256: payloadHash(report.subject, report.text),
      p_idempotency_key: idempotencyKey(date, recipient),
    },
  });
  const row = oneRpcRow(payload, "ledger_reserve_invalid");
  if (typeof row.can_send !== "boolean" || !["prepared", "sending", "accepted", "uncertain", "failed"].includes(row.status) ||
      typeof row.subject !== "string" || typeof row.body !== "string" ||
      row.idempotency_key !== idempotencyKey(date, recipient) ||
      !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0) fail("ledger_reserve_invalid");
  if (row.can_send && row.status !== "sending") fail("ledger_reserve_invalid");
  return row;
}

async function finishDelivery(config, date, recipient, reserved, status, providerEmailId, errorCode, fetchImpl) {
  const payload = await supabaseRequest(config, "rest/v1/rpc/finish_yutakasa_daily_report_delivery", {
    method: "POST", fetchImpl,
    body: {
      p_report_date_jst: date,
      p_recipient: recipient,
      p_idempotency_key: reserved.idempotency_key,
      p_attempt_count: reserved.attempt_count,
      p_status: status,
      p_provider_email_id: providerEmailId,
      p_error_code: errorCode,
    },
  });
  const row = oneRpcRow(payload, "ledger_finish_unverified");
  if (row.status !== status || row.attempt_count !== reserved.attempt_count ||
      (status === "accepted" && row.provider_email_id !== providerEmailId)) fail("ledger_finish_unverified");
  return row;
}

async function sendViaResend(config, recipient, reserved, fetchImpl) {
  let response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": reserved.idempotency_key,
        "User-Agent": "yutakasa-daily-report/1.0",
      },
      body: JSON.stringify({
        from: `豊かさAI 日報 <${config.from}>`,
        to: [recipient], subject: reserved.subject, text: reserved.body,
      }),
    });
  } catch { return { status: "uncertain", providerEmailId: null, errorCode: "resend_request_uncertain" }; }
  if (!response.ok) {
    const rejected = [400, 401, 403, 404, 422, 429].includes(response.status);
    return { status: rejected ? "failed" : "uncertain", providerEmailId: null, errorCode: `resend_http_${response.status}` };
  }
  let result;
  try { result = await boundedJson(response, "resend_response"); }
  catch { return { status: "uncertain", providerEmailId: null, errorCode: "resend_response_unverified" }; }
  if (typeof result?.id !== "string" || !UUID.test(result.id)) {
    return { status: "uncertain", providerEmailId: null, errorCode: "resend_response_unverified" };
  }
  return { status: "accepted", providerEmailId: result.id, errorCode: null };
}

async function providerLedgerRows(config, query, fetchImpl) {
  const rows = await supabaseRequest(config,
    `rest/v1/yutakasa_daily_report_deliveries?${query}`, { fetchImpl });
  if (!Array.isArray(rows) || rows.length > 14) fail("provider_ledger_invalid");
  for (const row of rows) {
    if (!validDate(row?.report_date_jst) || !config.recipients.includes(row.recipient) ||
        row.status !== "accepted" || !UUID.test(row.provider_email_id) ||
        (row.provider_checked_at !== null && !validTimestamp(row.provider_checked_at)) ||
        (row.provider_last_event !== null && !PROVIDER_EVENTS.has(row.provider_last_event))) {
      fail("provider_ledger_invalid");
    }
  }
  return rows;
}

async function providerCandidates(config, latestDate, now, fetchImpl) {
  const select = "report_date_jst,recipient,status,provider_email_id,provider_last_event,provider_checked_at";
  const earliestRecent = new Date(Date.parse(`${latestDate}T00:00:00.000Z`) - 6 * 86_400_000)
    .toISOString().slice(0, 10);
  const recentQuery = new URLSearchParams({
    select, report_date_jst: `gte.${earliestRecent}`,
    recipient: `in.(${config.recipients.join(",")})`, status: "eq.accepted",
    order: "provider_checked_at.asc.nullsfirst,report_date_jst.asc,recipient.asc",
    limit: "14",
  });
  const uncheckedQuery = new URLSearchParams({
    select, recipient: `in.(${config.recipients.join(",")})`, status: "eq.accepted",
    provider_checked_at: "is.null", order: "report_date_jst.asc,recipient.asc",
    limit: String(PROVIDER_CHECK_BATCH),
  });
  const recent = await providerLedgerRows(config, recentQuery, fetchImpl);
  const unchecked = await providerLedgerRows(config, uncheckedQuery, fetchImpl);
  const seen = new Set();
  const due = [];
  for (const row of [...recent, ...unchecked]) {
    const key = `${row.report_date_jst}:${row.recipient}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.provider_checked_at !== null &&
        Date.parse(row.provider_checked_at) > now.getTime() - PROVIDER_RECHECK_MS) continue;
    if (due.length < PROVIDER_CHECK_BATCH) due.push(row);
  }
  return due;
}

async function retrieveProviderEvent(config, row, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://api.resend.com/emails/${row.provider_email_id}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${config.resendKey}`, Accept: "application/json" },
    });
  } catch { fail("provider_request_failed"); }
  if (!response.ok) fail(`provider_http_${response.status}`);
  const result = await boundedJson(response, "provider_response");
  if (result?.object !== "email" || result.id !== row.provider_email_id ||
      !Array.isArray(result.to) || result.to.length !== 1 ||
      result.to[0]?.toLowerCase() !== row.recipient ||
      !PROVIDER_EVENTS.has(result.last_event)) fail("provider_receipt_invalid");
  return result.last_event;
}

async function recordProviderEvent(config, row, event, fetchImpl) {
  const payload = await supabaseRequest(config,
    "rest/v1/rpc/record_yutakasa_daily_report_provider_event", {
      method: "POST", fetchImpl,
      body: {
        p_report_date_jst: row.report_date_jst,
        p_recipient: row.recipient,
        p_provider_email_id: row.provider_email_id,
        p_last_event: event,
      },
    });
  const recorded = oneRpcRow(payload, "provider_record_invalid");
  if (recorded.provider_last_event !== event || !validTimestamp(recorded.provider_checked_at)) {
    fail("provider_record_invalid");
  }
}

async function reconcileProviderDeliveries(config, latestDate, now, fetchImpl) {
  const due = await providerCandidates(config, latestDate, now, fetchImpl);
  const checks = [];
  for (const row of due) {
    try {
      const event = await retrieveProviderEvent(config, row, fetchImpl);
      await recordProviderEvent(config, row, event, fetchImpl);
      checks.push({ reportDateJst: row.report_date_jst,
        recipientNumber: config.recipients.indexOf(row.recipient) + 1, event });
    } catch (error) {
      checks.push({ reportDateJst: row.report_date_jst,
        recipientNumber: config.recipients.indexOf(row.recipient) + 1,
        errorCode: error instanceof DailyReportError ? error.code : "provider_unexpected_failure" });
    }
  }
  return checks;
}

async function auditDeliveryHealth(config, fetchImpl) {
  const payload = await supabaseRequest(config,
    "rest/v1/rpc/get_yutakasa_daily_report_health", {
      method: "POST", fetchImpl,
      body: { p_recipient_1: config.recipients[0], p_recipient_2: config.recipients[1] },
    });
  const row = oneRpcRow(payload, "delivery_health_invalid");
  for (const key of ["uncertain_count", "failed_count", "provider_adverse_count", "pending_overdue_count"]) {
    if (!Number.isSafeInteger(row[key]) || row[key] < 0) fail("delivery_health_invalid");
  }
  return {
    uncertainCount: row.uncertain_count,
    failedCount: row.failed_count,
    providerAdverseCount: row.provider_adverse_count,
    pendingOverdueCount: row.pending_overdue_count,
  };
}

async function runReportDate(config, date, now, fetchImpl) {
  const existing = await readExistingDeliveries(config, date, fetchImpl);
  if (config.recipients.every((recipient) =>
    existing.get(recipient) === "accepted" || existing.get(recipient) === "uncertain")) {
    const deliveries = config.recipients.map((recipient, index) => ({
      recipientNumber: index + 1,
      status: existing.get(recipient),
      sentNow: false,
    }));
    const ok = deliveries.every((delivery) => delivery.status === "accepted");
    return { ok, reportDateJst: date, skipped: ok ? "already_accepted" : "awaiting_reconciliation_or_lease", deliveries };
  }
  const window = reportWindow(date);
  const [source, monitorSummary, repairProgress] = await Promise.all([
    collectReportSource(config, window, fetchImpl),
    collectMonitorSummary(config, window, fetchImpl),
    collectRepairProgress(config, window, fetchImpl),
  ]);
  const report = buildDailyReport(date, source, now, monitorSummary, repairProgress);
  const deliveries = [];
  for (const [index, recipient] of config.recipients.entries()) {
    const reserved = await reserveDelivery(config, date, recipient, report, fetchImpl);
    if (!reserved.can_send) {
      deliveries.push({ recipientNumber: index + 1, status: reserved.status, sentNow: false });
      continue;
    }
    const result = await sendViaResend(config, recipient, reserved, fetchImpl);
    await finishDelivery(config, date, recipient, reserved, result.status, result.providerEmailId, result.errorCode, fetchImpl);
    deliveries.push({ recipientNumber: index + 1, status: result.status, sentNow: result.status === "accepted", providerEmailId: result.providerEmailId });
  }
  return {
    ok: deliveries.every((delivery) => delivery.status === "accepted"),
    reportDateJst: date,
    ticketCount: source.tickets.length,
    messageCount: source.messages.length,
    workLogCount: source.workLogs.length,
    currentOpenCount: source.openTickets.length,
    monitorState: monitorSummary.state,
    monitorCompletedCount: monitorSummary.completedCount ?? null,
    repairProgressState: repairProgress.state,
    deliveries,
  };
}

export async function runDailySupportReport({ env = process.env, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const latestDate = reportingDate(now);
  if (latestDate === null) return { ok: true, skipped: "before_09_jst" };
  if (latestDate < FIRST_REPORT_DATE_JST) return { ok: true, skipped: "before_first_report_date" };
  const config = validateEnvironment(env);
  const expiredLeaseCount = await expireStaleLeases(config, fetchImpl);
  const cursorDate = await readReportCursor(config, fetchImpl);
  const retryDate = await earliestFailedDate(config, cursorDate, fetchImpl);
  let dates;
  try { dates = reportDatesToRun({ latestDate, cursorDate, retryDate }); }
  catch { fail("report_cursor_invalid"); }
  const results = [];
  for (const date of dates) {
    let result;
    try {
      result = await runReportDate(config, date, now, fetchImpl);
    } catch (error) {
      result = {
        ok: false,
        reportDateJst: date,
        errorCode: error instanceof DailyReportError ? error.code : "daily_report_unexpected_failure",
        deliveries: [],
      };
    }
    results.push(result);
    if (date === cursorDate && !result.errorCode) {
      await advanceReportCursor(config, date, fetchImpl);
    }
  }
  const latest = results[0];
  let provider;
  try { provider = { checks: await reconcileProviderDeliveries(config, latestDate, now, fetchImpl) }; }
  catch (error) {
    provider = { checks: [],
      errorCode: error instanceof DailyReportError ? error.code : "provider_unexpected_failure" };
  }
  let health;
  try { health = await auditDeliveryHealth(config, fetchImpl); }
  catch (error) {
    health = { uncertainCount: null, failedCount: null, providerAdverseCount: null, pendingOverdueCount: null,
      errorCode: error instanceof DailyReportError ? error.code : "delivery_health_unexpected_failure" };
  }
  const unresolved = health.uncertainCount > 0 || health.failedCount > 0 ||
    health.providerAdverseCount > 0 || health.pendingOverdueCount > 0;
  return {
    ...latest,
    ok: results.every((result) => result.ok) && !provider.errorCode &&
      !health.errorCode && !unresolved && provider.checks.every((check) => !check.errorCode),
    expiredLeaseCount,
    recoveredReportDatesJst: results.slice(1).map((result) => result.reportDateJst),
    providerChecks: provider.checks,
    unresolvedUncertainCount: health.uncertainCount,
    pendingFailedCount: health.failedCount,
    providerAdverseCount: health.providerAdverseCount,
    pendingOverdueCount: health.pendingOverdueCount,
    ...(unresolved ? { unresolvedDeliveryCode: "daily_report_delivery_unresolved" } : {}),
    ...(provider.errorCode ? { providerErrorCode: provider.errorCode } : {}),
    ...(health.errorCode ? { healthErrorCode: health.errorCode } : {}),
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runDailySupportReport().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 2;
    },
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof DailyReportError ? error.code : "daily_report_unexpected_failure" })}\n`);
      process.exitCode = 1;
    },
  );
}
