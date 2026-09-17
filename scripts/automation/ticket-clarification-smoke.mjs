#!/usr/bin/env node

import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectRemoteDeployment } from "./remote-production.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const APP = "https://yutakasa-tapping-coach.vercel.app";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/u;
const MARKER = "yutakasa-clarification-smoke-v1";
const ACK = "お問い合わせを受け付けました。内容を確認して対応します。調査内容によっては2〜3日かかる場合があります。対応後、この画面でご連絡します。";
const REPLY = "お問い合わせありがとうございます。状況を確認するため、問題が起きた画面、直前に行った操作、表示されたエラー文（あれば）、発生した日時を教えてください。パスワードや認証コードは送らないでください。";
const RELATED = ["support_messages", "support_work_logs", "support_attachments",
  "yutakasa_ticket_clarifications", "yutakasa_repair_ticket_links",
  "yutakasa_ticket_repair_jobs", "yutakasa_ticket_reply_drafts"];

export class ClarificationSmokeError extends Error {
  constructor(code) { super(code); this.name = "ClarificationSmokeError"; this.code = code; }
}
function fail(code) { throw new ClarificationSmokeError(code); }
function uuid(value) { return typeof value === "string" && UUID.test(value); }

async function jsonRequest(fetchImpl, url, init, code, maxBytes = 32 * 1024) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch { fail(`${code}_request_failed`); }
  let raw;
  try { raw = await response.text(); } catch { fail(`${code}_body_failed`); }
  if (Buffer.byteLength(raw) > maxBytes) fail(`${code}_body_large`);
  let data;
  try { data = JSON.parse(raw); } catch { fail(`${code}_json_invalid`); }
  return { status: response.status, data };
}

function dbHeaders(env, write = false) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
    ...(write ? { "Content-Type": "application/json", Prefer: "return=representation" } : {}),
  };
}

async function dbRequest(env, fetchImpl, resource, { query = {}, body, method = "GET" } = {}) {
  const url = new URL(`/rest/v1/${resource}`, env.SUPABASE_URL);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const { status, data } = await jsonRequest(fetchImpl, url, {
    method, headers: dbHeaders(env, method !== "GET"),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, "clarification_smoke_db");
  if (![200, 201].includes(status) || !Array.isArray(data) || data.length > 20) {
    fail(`clarification_smoke_db_http_${status}`);
  }
  return data;
}

async function appRequest(fetchImpl, method, path, token, body, cookie = null,
  extraHeaders = {}) {
  const { status, data } = await jsonRequest(fetchImpl, `${APP}${path}`, {
    method, headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { "x-automation-token": token } : {}),
      ...(cookie ? { Cookie: `session=${cookie}` } : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, "clarification_smoke_api", 8 * 1024);
  return { status, data };
}

function sessionToken(secret, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ email, iat: now, exp: now + 600 })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${createHmac("sha256", secret).update(content).digest("base64url")}`;
}

function required(env, requireSmokeGate = true) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
    (requireSmokeGate && env.YUTAKASA_CLARIFICATION_SMOKE_ENABLED !== "true") ||
    !SHA.test(env.GITHUB_SHA ?? "")) fail("clarification_smoke_trusted_main_required");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/u.test(env.SUPABASE_URL ?? "") ||
    typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
    env.SUPABASE_SERVICE_ROLE_KEY.length < 20 ||
    typeof env.JWT_SECRET !== "string" || env.JWT_SECRET.length < 32 ||
    typeof env.VERCEL_TOKEN !== "string" || env.VERCEL_TOKEN.length < 20) {
    fail("clarification_smoke_credentials_missing");
  }
}

function statePath(env) {
  const base = env.RUNNER_TEMP;
  const file = env.YUTAKASA_CLARIFICATION_SMOKE_STATE_PATH;
  if (typeof base !== "string" || !path.isAbsolute(base) ||
    typeof file !== "string" || !path.isAbsolute(file) ||
    path.dirname(file) !== path.resolve(base) ||
    path.basename(file) !== "yutakasa-clarification-smoke-state.json") {
    fail("clarification_smoke_state_path_invalid");
  }
  return file;
}

function defaultStateStore(env) {
  const file = statePath(env);
  return {
    save(runId, requestId, lockToken) {
      fs.writeFileSync(file, JSON.stringify({ runId, requestId, lockToken }),
        { flag: "wx", mode: 0o600 });
    },
    read() {
      let stat;
      try { stat = fs.lstatSync(file); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
        stat.size > 256) fail("clarification_smoke_state_file_invalid");
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!uuid(value?.runId) || !uuid(value?.requestId) || !uuid(value?.lockToken)) {
        fail("clarification_smoke_state_file_invalid");
      }
      return value;
    },
    remove() { fs.unlinkSync(file); },
  };
}

async function rows(env, fetchImpl, table, filter, select = "id") {
  return dbRequest(env, fetchImpl, table, {
    query: { ...filter, select, limit: "5" },
  });
}

async function cleanup(env, fetchImpl, runId, requestId, lockToken, email) {
  const result = await dbRequest(env, fetchImpl,
    "rpc/cleanup_yutakasa_ticket_clarification_smoke", {
      method: "POST", body: { p_run_id: runId, p_client_request_id: requestId,
        p_lock_token: lockToken },
    });
  if (result.length !== 1 || typeof result[0]?.cleaned !== "boolean" ||
    (result[0].ticket_id !== null && !uuid(result[0].ticket_id))) {
    fail("clarification_smoke_cleanup_confirmation_invalid");
  }
  const ticketId = result[0].ticket_id;
  if ((await rows(env, fetchImpl, "subscribers", { email: `eq.${email}` })).length ||
    (await rows(env, fetchImpl, "support_tickets", { user_email: `eq.${email}` })).length ||
    (await rows(env, fetchImpl, "chat_threads", { user_email: `eq.${email}` })).length ||
    (await rows(env, fetchImpl, "otp_codes", { email: `eq.${email}` })).length) {
    fail("clarification_smoke_cleanup_identity_remaining");
  }
  if (ticketId) {
    for (const table of RELATED) {
      if ((await rows(env, fetchImpl, table, { ticket_id: `eq.${ticketId}` }, "ticket_id")).length) {
        fail("clarification_smoke_cleanup_dependents_remaining");
      }
    }
  }
  return result[0].cleaned;
}

async function assertCompleted(env, fetchImpl, ticketId, email, userMessageId, replyMessageId) {
  const [tickets, messages, logs, ledger, attachments, links, jobs, drafts] = await Promise.all([
    rows(env, fetchImpl, "support_tickets", { id: `eq.${ticketId}` },
      "id,user_email,status,automation_status,automation_lock_token,decision_required"),
    rows(env, fetchImpl, "support_messages", { ticket_id: `eq.${ticketId}` },
      "id,sender_type,sender_email,body"),
    rows(env, fetchImpl, "support_work_logs", { ticket_id: `eq.${ticketId}` },
      "event_type,metadata"),
    rows(env, fetchImpl, "yutakasa_ticket_clarifications", { ticket_id: `eq.${ticketId}` },
      "ticket_id,latest_user_message_id,reply_message_id"),
    ...["support_attachments", "yutakasa_repair_ticket_links",
      "yutakasa_ticket_repair_jobs", "yutakasa_ticket_reply_drafts"].map((table) =>
      rows(env, fetchImpl, table, { ticket_id: `eq.${ticketId}` }, "ticket_id")),
  ]);
  if (tickets.length !== 1 || tickets[0].user_email !== email ||
    tickets[0].status !== "waiting_user" || tickets[0].automation_status !== "completed" ||
    tickets[0].automation_lock_token !== null || tickets[0].decision_required !== false ||
    messages.length !== 3 ||
    messages.filter((m) => m.sender_type === "user" && m.id === userMessageId &&
      m.sender_email === email && m.body === "使えない").length !== 1 ||
    messages.filter((m) => m.sender_type === "system" && m.sender_email === null &&
      m.body === ACK).length !== 1 ||
    messages.filter((m) => m.sender_type === "admin" && m.id === replyMessageId &&
      m.sender_email === null && m.body === REPLY).length !== 1 ||
    logs.length !== 2 ||
    logs.filter((l) => l.event_type === "automation_claimed").length !== 1 ||
    logs.filter((l) => l.event_type === "automation_clarification_sent" &&
      l.metadata?.message_id === replyMessageId &&
      l.metadata?.latest_user_message_id === userMessageId).length !== 1 ||
    ledger.length !== 1 || ledger[0].ticket_id !== ticketId ||
    ledger[0].latest_user_message_id !== userMessageId ||
    ledger[0].reply_message_id !== replyMessageId ||
    attachments.length || links.length || jobs.length || drafts.length) {
    fail("clarification_smoke_state_invalid");
  }
}

export async function runClarificationSmoke({ env = process.env, fetchImpl = fetch,
  deploymentImpl = collectRemoteDeployment, uuidImpl = randomUUID, stateStore = null } = {}) {
  required(env);
  const state = stateStore ?? defaultStateStore(env);
  const before = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  if (before?.ready !== true || before.mainSha !== env.GITHUB_SHA) {
    fail("clarification_smoke_deployment_not_main");
  }
  // A bogus lock cannot write a ticket. Distinct 409 errors prove the deployed
  // Vercel flag is on before any synthetic database row is created.
  const probe = await appRequest(fetchImpl, "PATCH", "/api/internal/support-automation",
    env.JWT_SECRET, { action: "clarify", ticketId: randomUUID(), lockToken: randomUUID() });
  if (probe.status !== 409 || probe.data?.error !==
    "This ticket is not locked by the current automation run.") {
    fail("clarification_smoke_vercel_flag_not_ready");
  }
  // Concurrent jobs share a workflow lock; any older reserved-family row is
  // therefore residue and must be investigated before creating a new one.
  for (const [table, column] of [["subscribers", "email"],
    ["support_tickets", "user_email"], ["chat_threads", "user_email"],
    ["otp_codes", "email"]]) {
    if ((await rows(env, fetchImpl, table,
      { [column]: "like.yutakasa-auto-smoke+*@example.invalid" })).length) {
      fail("clarification_smoke_prior_fixture_remaining");
    }
  }
  const runId = uuidImpl();
  const requestId = uuidImpl();
  const lockToken = uuidImpl();
  if (![runId, requestId, lockToken].every(uuid) ||
    new Set([runId, requestId, lockToken]).size !== 3) fail("clarification_smoke_uuid_invalid");
  const email = `yutakasa-auto-smoke+${runId}@example.invalid`;
  // This no-op also checks that the service-role-only cleanup RPC is deployed.
  if (await cleanup(env, fetchImpl, runId, requestId, lockToken, email)) {
    fail("clarification_smoke_preexisting_fixture");
  }
  // Persist only synthetic UUIDs before the first write. A later workflow
  // step can rescue cleanup even if the Node process is killed mid-request.
  state.save(runId, requestId, lockToken);
  let createdIdentity = false;
  let primaryError;
  let completed = false;
  try {
    const identity = await dbRequest(env, fetchImpl, "subscribers", {
      method: "POST", query: { select: "id,email,status,subscription_status,first_payment_date,myasp_data" },
      body: { email, name: "System monitor clarification test (no customer, no payment)",
        status: "active", subscription_status: "active", first_payment_date: null,
        myasp_data: { automation_test_identity: MARKER,
          source: "system_monitor_no_payment", smoke_run_id: runId } },
    });
    if (identity.length !== 1 || identity[0]?.email !== email ||
      identity[0]?.myasp_data?.automation_test_identity !== MARKER) {
      fail("clarification_smoke_identity_unconfirmed");
    }
    createdIdentity = true;
    const session = sessionToken(env.JWT_SECRET, email);
    const created = await appRequest(fetchImpl, "POST", "/api/support/tickets", null,
      { category: "technical", subject: "使えない", body: "使えない",
        clientRequestId: requestId }, session);
    const ticketId = created.data?.ticket_id;
    const userMessageId = created.data?.message_id;
    if (created.status !== 201 || created.data?.created !== true ||
      !uuid(ticketId) || !uuid(userMessageId)) fail("clarification_smoke_ticket_unconfirmed");
    const claimed = await appRequest(fetchImpl, "PATCH", "/api/internal/support-automation",
      env.JWT_SECRET, { action: "claim", ticketId, lockToken });
    if (claimed.status !== 200 || claimed.data?.ticket?.id !== ticketId ||
      claimed.data.ticket.automation_status !== "investigating" ||
      claimed.data.ticket.status !== "in_progress") fail("clarification_smoke_claim_invalid");
    const context = await appRequest(fetchImpl, "GET",
      `/api/internal/support-automation?ticketId=${ticketId}`, env.JWT_SECRET,
      undefined, null, { "x-automation-lock-token": lockToken });
    const version = context.data?.ticket?.updated_at;
    if (context.status !== 200 || context.data?.ticket?.id !== ticketId ||
      context.data.ticket.automation_lock_token !== lockToken ||
      context.data.ticket.subject !== "使えない" ||
      !Number.isFinite(Date.parse(version)) ||
      context.data.messages?.length !== 2 ||
      context.data.messages.filter((m) => m.id === userMessageId &&
        m.sender_type === "user" && m.body === "使えない").length !== 1 ||
      context.data.messages.filter((m) => m.sender_type === "system" &&
        m.body === ACK).length !== 1) fail("clarification_smoke_context_invalid");
    const body = { action: "clarify", ticketId, lockToken,
      latestUserMessageId: userMessageId, ticketVersion: version };
    const clarified = await appRequest(fetchImpl, "PATCH", "/api/internal/support-automation",
      env.JWT_SECRET, body);
    const replyMessageId = clarified.data?.messageId;
    if (clarified.status !== 200 || clarified.data?.created !== true ||
      !uuid(replyMessageId)) fail("clarification_smoke_reply_unconfirmed");
    const retry = await dbRequest(env, fetchImpl, "rpc/append_yutakasa_ticket_clarification", {
      method: "POST", body: { p_ticket_id: ticketId, p_lock_token: lockToken,
        p_latest_user_message_id: userMessageId, p_ticket_version: version },
    });
    if (retry.length !== 1 || retry[0]?.created !== false ||
      retry[0]?.message_id !== replyMessageId) fail("clarification_smoke_retry_not_idempotent");
    const apiRetry = await appRequest(fetchImpl, "PATCH", "/api/internal/support-automation",
      env.JWT_SECRET, body);
    if (apiRetry.status !== 409) fail("clarification_smoke_api_retry_not_rejected");
    await assertCompleted(env, fetchImpl, ticketId, email, userMessageId, replyMessageId);
    completed = true;
  } catch (error) { primaryError = error; }
  try {
    const cleaned = await cleanup(env, fetchImpl, runId, requestId, lockToken, email);
    if (createdIdentity && !cleaned) fail("clarification_smoke_cleanup_not_confirmed");
  } catch { fail("clarification_smoke_cleanup_incomplete"); }
  state.remove();
  if (primaryError) throw primaryError;
  if (!completed) fail("clarification_smoke_incomplete");
  const after = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  if (after?.ready !== true || after.mainSha !== before.mainSha ||
    after.deploymentId !== before.deploymentId) fail("clarification_smoke_deployment_changed");
  return { ok: true, mainSha: before.mainSha, deploymentId: before.deploymentId,
    clarificationCreated: 1, idempotentRetry: true, syntheticRowsRemaining: 0,
    customerEmailPathUsed: false };
}

export async function runCleanupOnly({ env = process.env, fetchImpl = fetch,
  stateStore = null } = {}) {
  // Rescue must remain available if the run gate is disabled mid-job.
  required(env, false);
  const state = stateStore ?? defaultStateStore(env);
  const saved = state.read();
  if (!saved) return { ok: true, rescueNeeded: false };
  if (!uuid(saved.runId) || !uuid(saved.requestId) || !uuid(saved.lockToken)) {
    fail("clarification_smoke_state_file_invalid");
  }
  const email = `yutakasa-auto-smoke+${saved.runId}@example.invalid`;
  await cleanup(env, fetchImpl, saved.runId, saved.requestId, saved.lockToken, email);
  state.remove();
  return { ok: true, rescueNeeded: true, syntheticRowsRemaining: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (process.argv[2] === "--cleanup-only" ? runCleanupOnly() : runClarificationSmoke()).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const code = error instanceof ClarificationSmokeError ? error.code :
        "clarification_smoke_failed";
      process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    },
  );
}
