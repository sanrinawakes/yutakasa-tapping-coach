#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "sanrinawakes/yutakasa-tapping-coach";
const API_BASE = `https://api.github.com/repos/${REPOSITORY}`;
const MAX_DISPATCH_BYTES = 2_048;
const MAX_OPEN_ISSUE_PAGES = 10;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const GENERIC_FAILURE = "remote_monitor_failure";
const PUBLIC_REASON_CODES = new Set([
  "pending_tickets",
  "drive_intake_items",
  "all_time_user_last_baseline_changed",
  "recent_user_last_over_20m",
  "recent_default_title_with_messages",
  "recent_duplicate_empty_threads",
  "orphan_messages",
  "production_log_fiveXx",
  "production_log_levelError",
  "production_log_timeout",
  "production_log_gemini",
  "historical_production_log_fiveXx",
  "historical_production_log_levelError",
  "historical_production_log_timeout",
  "historical_production_log_gemini",
  "deployment_snapshot_failed",
  "vercel_log_snapshot_failed",
  "drive_intake_snapshot_failed",
  "final_drive_intake_snapshot_failed",
  "snapshot_schema_invalid",
  "snapshot_queue_batch_mismatch",
  "detail_api_http_failure_possible_recovery_side_effect",
  "detail_api_failed_possible_recovery_side_effect",
  "detail_api_queue_mismatch",
  "run_cleanup_failed",
  "production_evidence_invalid",
  "remote_monitor_unexpected_failure",
  "dispatch_http_failure",
  "dispatch_request_failed",
  "support_lock_lost",
  "support_owner_decision_required",
  "support_technical_review_required",
  "support_context_stale",
  "support_worker_uncertain",
  "support_deferred",
  "support_worker_nonhealthy",
  "ticket_reconcile_work_due",
  "ticket_reconcile_dispatch_failed",
  GENERIC_FAILURE,
]);

export class MonitorAlertError extends Error {
  constructor(code) {
    super(code);
    this.name = "MonitorAlertError";
    this.code = code;
  }
}

function fail(code) {
  throw new MonitorAlertError(code);
}

export function normalizeAlertInput(reasonCodesJson, deploymentId) {
  if (
    typeof reasonCodesJson !== "string" ||
    Buffer.byteLength(reasonCodesJson) > MAX_DISPATCH_BYTES ||
    typeof deploymentId !== "string" ||
    !(deploymentId === "unknown" || /^dpl_[A-Za-z0-9]{12,80}$/u.test(deploymentId))
  ) {
    fail("alert_input_invalid");
  }
  let rawCodes;
  try {
    rawCodes = JSON.parse(reasonCodesJson);
  } catch {
    fail("alert_reason_codes_invalid");
  }
  if (
    !Array.isArray(rawCodes) ||
    rawCodes.length < 1 ||
    rawCodes.length > 20 ||
    rawCodes.some((code) => typeof code !== "string" || code.length < 1 || code.length > 256)
  ) {
    fail("alert_reason_codes_invalid");
  }
  const reasonCodes = [...new Set(rawCodes.map((code) =>
    PUBLIC_REASON_CODES.has(code) ? code : GENERIC_FAILURE,
  ))].sort();
  return { reasonCodes, deploymentId };
}

function githubHeaders(token) {
  if (typeof token !== "string" || token.length < 20 || /[\r\n]/u.test(token)) {
    fail("github_token_missing_or_invalid");
  }
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) fail("github_response_invalid");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) fail("github_response_invalid");
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail("github_response_too_large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("github_response_invalid");
  }
}

async function githubRequest(url, options, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail("github_request_failed");
  }
  return response;
}

export function alertTitle(reasonCode) {
  if (!PUBLIC_REASON_CODES.has(reasonCode)) fail("alert_reason_not_public");
  return `[Yutakasa monitor] ${reasonCode}`;
}

export async function listOpenAlertTitles({ token, fetchImpl = globalThis.fetch }) {
  const titles = new Set();
  const headers = githubHeaders(token);
  for (let page = 1; page <= MAX_OPEN_ISSUE_PAGES; page += 1) {
    const url = new URL(`${API_BASE}/issues`);
    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await githubRequest(url, { method: "GET", headers }, fetchImpl);
    if (response.status !== 200) fail("github_issue_list_failed");
    const rows = await readBoundedJson(response);
    if (!Array.isArray(rows) || rows.length > 100) fail("github_issue_list_invalid");
    for (const row of rows) {
      if (!row || typeof row.title !== "string" || !Number.isSafeInteger(row.number)) {
        fail("github_issue_list_invalid");
      }
      if (!row.pull_request) titles.add(row.title);
    }
    if (rows.length < 100) return titles;
  }
  fail("github_issue_list_limit_exceeded");
}

function alertBody(reasonCode, deploymentId) {
  return [
    "豊かさBOT監視の確認コードがGitHub Actionsに渡されました。",
    "",
    `理由コード: \`${reasonCode}\``,
    `監視時点の本番デプロイID（履歴ログの発生元を示しません）: \`${deploymentId}\``,
    "",
    "問い合わせ本文、顧客情報、ログ本文はこのIssueに含めていません。",
    "このIssueは監視通知です。原因の確定、顧客対応、修正、本番確認を示すものではありません。",
  ].join("\n");
}

export async function createAlertIssue({ reasonCode, deploymentId, token, fetchImpl = globalThis.fetch }) {
  const response = await githubRequest(
    `${API_BASE}/issues`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ title: alertTitle(reasonCode), body: alertBody(reasonCode, deploymentId) }),
    },
    fetchImpl,
  );
  if (response.status !== 201) fail("github_issue_create_failed");
  const issue = await readBoundedJson(response);
  if (
    !Number.isSafeInteger(issue?.number) ||
    issue.number < 1 ||
    issue.title !== alertTitle(reasonCode)
  ) {
    fail("github_issue_create_unverified");
  }
  return issue.number;
}

export async function runMonitorAlert({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY) fail("github_repository_invalid");
  const { reasonCodes, deploymentId } = normalizeAlertInput(
    env.ALERT_REASON_CODES,
    env.ALERT_DEPLOYMENT_ID,
  );
  const token = env.GITHUB_TOKEN;
  const titles = await listOpenAlertTitles({ token, fetchImpl });
  let created = 0;
  let existing = 0;
  for (const reasonCode of reasonCodes) {
    const title = alertTitle(reasonCode);
    if (titles.has(title)) {
      existing += 1;
      continue;
    }
    await createAlertIssue({ reasonCode, deploymentId, token, fetchImpl });
    titles.add(title);
    created += 1;
  }
  return { ok: true, created, existing, reasonCodes };
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runMonitorAlert().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    (error) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: error instanceof MonitorAlertError ? error.code : "monitor_alert_failed" })}\n`,
      );
      process.exitCode = 1;
    },
  );
}
