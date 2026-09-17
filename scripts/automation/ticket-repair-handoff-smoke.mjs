#!/usr/bin/env node

import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkSyntheticSupportTicket, TEST_SUPPORT_ACK, TEST_SUPPORT_BODY,
  TEST_SUPPORT_SUBJECT } from "./ai-repair-functional-smoke.mjs";
import { collectRemoteDeployment } from "./remote-production.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const PRODUCTION_URL = "https://yutakasa-tapping-coach.vercel.app";
const MARKER = "yutakasa-ai-repair-smoke-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/u;
const DEPENDENTS = ["support_attachments", "yutakasa_repair_ticket_links",
  "yutakasa_ticket_reply_drafts", "yutakasa_ticket_clarifications"];

export class HandoffSmokeError extends Error {
  constructor(code) { super(code); this.name = "HandoffSmokeError"; this.code = code; }
}
function fail(code) { throw new HandoffSmokeError(code); }

function validateEnvironment(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REPOSITORY !== REPO ||
      env.GITHUB_REF !== "refs/heads/main" || !SHA.test(env.GITHUB_SHA ?? "") ||
      env.TICKET_REPAIR_ENABLED !== "false" || env.AUTO_MERGE_ENABLED !== "false" ||
      typeof env.SUPABASE_URL !== "string" ||
      !/^https:\/\/[a-z0-9-]+\.supabase\.co$/u.test(env.SUPABASE_URL) ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
      env.SUPABASE_SERVICE_ROLE_KEY.length < 20 ||
      typeof env.JWT_SECRET !== "string" || env.JWT_SECRET.length < 32 ||
      typeof env.VERCEL_TOKEN !== "string" || env.VERCEL_TOKEN.length < 20) {
    fail("handoff_smoke_configuration_invalid");
  }
}

async function rows(env, fetchImpl, table, query = {}, method = "GET", body = null) {
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, {
    method,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
      ...(method !== "GET" ? { Prefer: "return=representation" } : {}),
      ...(body !== null ? { "Content-Type": "application/json" } : {}) },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("handoff_smoke_database_request_failed"));
  if (![200, 201].includes(response.status)) fail(`handoff_smoke_database_http_${response.status}`);
  const raw = await response.text().catch(() => fail("handoff_smoke_database_body_failed"));
  if (Buffer.byteLength(raw) > 64 * 1024) fail("handoff_smoke_database_response_large");
  let result;
  try { result = JSON.parse(raw); } catch { fail("handoff_smoke_database_response_invalid"); }
  if (!Array.isArray(result) || result.length > 20) fail("handoff_smoke_database_rows_invalid");
  return result;
}

async function supportApi(env, fetchImpl, action, body, lockToken = null, expectedStatus = 200) {
  const url = new URL("/api/internal/support-automation", PRODUCTION_URL);
  if (action === "detail") url.searchParams.set("ticketId", body.ticketId);
  const response = await fetchImpl(url, {
    method: action === "detail" ? "GET" : "PATCH",
    headers: { "x-automation-token": env.JWT_SECRET,
      ...(lockToken ? { "x-automation-lock-token": lockToken } : {}),
      ...(action !== "detail" ? { "Content-Type": "application/json" } : {}) },
    ...(action !== "detail" ? { body: JSON.stringify({ action, ...body }) } : {}),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("handoff_smoke_support_request_failed"));
  if (response.status !== expectedStatus) fail(`handoff_smoke_support_http_${response.status}`);
  if (expectedStatus !== 200) return null;
  const raw = await response.text().catch(() => fail("handoff_smoke_support_body_failed"));
  if (Buffer.byteLength(raw) > 64 * 1024) fail("handoff_smoke_support_response_large");
  try { return JSON.parse(raw); } catch { fail("handoff_smoke_support_response_invalid"); }
}

function sessionToken(secret, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ email, iat: now, exp: now + 10 * 60 })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${createHmac("sha256", secret).update(content).digest("base64url")}`;
}

async function verifyCleanupRpc(env, fetchImpl) {
  // This deliberately invalid call must fail before any write. It proves the
  // deployed PostgREST schema exposes the cleanup RPC to service_role.
  const url = new URL("/rest/v1/rpc/cleanup_yutakasa_ticket_handoff_smoke", env.SUPABASE_URL);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ p_run_id: null, p_account_id: null,
      p_account_updated_at: null, p_ticket_id: null,
      p_ticket_updated_at: null, p_work_id: null, p_lock_token: null }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("handoff_smoke_cleanup_preflight_failed"));
  if (response.status !== 400) fail("handoff_smoke_cleanup_preflight_failed");
  const raw = await response.text().catch(() => fail("handoff_smoke_cleanup_preflight_failed"));
  if (Buffer.byteLength(raw) > 4_096) fail("handoff_smoke_cleanup_preflight_failed");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail("handoff_smoke_cleanup_preflight_failed"); }
  if (parsed?.code !== "22023") fail("handoff_smoke_cleanup_preflight_failed");
}

async function preflight(env, fetchImpl) {
  const checks = [
    ["subscribers", { email: "like.yutakasa-auto-smoke*", select: "id", limit: "1" }],
    ["support_tickets", { user_email: "like.yutakasa-auto-smoke*", select: "id", limit: "1" }],
    ["chat_threads", { user_email: "like.yutakasa-auto-smoke*", select: "id", limit: "1" }],
    ["otp_codes", { email: "like.yutakasa-auto-smoke*", select: "id", limit: "1" }],
    ["yutakasa_ticket_repair_jobs", { select: "work_id", limit: "1" }],
    ["yutakasa_repair_releases", { select: "pr_number", limit: "1" }],
  ];
  for (const [table, query] of checks) {
    if ((await rows(env, fetchImpl, table, query)).length !== 0) {
      fail("handoff_smoke_preflight_not_empty");
    }
  }
}

async function ticketForEmail(env, fetchImpl, email) {
  const result = await rows(env, fetchImpl, "support_tickets", {
    user_email: `eq.${email}`,
    select: "id,user_email,category,subject,client_request_id,status,automation_status,decision_required,automation_lock_token,updated_at",
    limit: "2",
  });
  if (result.length > 1) fail("handoff_smoke_ticket_ambiguous");
  return result[0] ?? null;
}

async function supportEvidence(env, fetchImpl, ticketId, email, workId, lockToken) {
  const ticket = await ticketForEmail(env, fetchImpl, email);
  if (!ticket || ticket.id !== ticketId || ticket.user_email !== email ||
      ticket.category !== "technical" || ticket.subject !== TEST_SUPPORT_SUBJECT ||
      !UUID.test(ticket.client_request_id ?? "") || ticket.decision_required !== false ||
      !Number.isFinite(Date.parse(ticket.updated_at ?? ""))) fail("handoff_smoke_ticket_changed");
  const messages = await rows(env, fetchImpl, "support_messages", {
    ticket_id: `eq.${ticketId}`,
    select: "id,ticket_id,sender_type,sender_email,body,client_request_id", limit: "3",
  });
  if (messages.length !== 2 || messages.some((message) =>
      !UUID.test(message?.id ?? "") || message.ticket_id !== ticketId) ||
      messages.filter((message) => message.sender_type === "user" &&
        message.sender_email === email && message.body === TEST_SUPPORT_BODY &&
        message.client_request_id === ticket.client_request_id).length !== 1 ||
      messages.filter((message) => message.sender_type === "system" &&
        message.sender_email === null && message.body === TEST_SUPPORT_ACK &&
        UUID.test(message.client_request_id ?? "") &&
        message.client_request_id !== ticket.client_request_id).length !== 1) {
    fail("handoff_smoke_messages_changed");
  }
  for (const table of DEPENDENTS) {
    if ((await rows(env, fetchImpl, table, {
      ticket_id: `eq.${ticketId}`, select: "ticket_id", limit: "1",
    })).length !== 0) fail("handoff_smoke_unexpected_dependent");
  }
  const logs = await rows(env, fetchImpl, "support_work_logs", {
    ticket_id: `eq.${ticketId}`, select: "event_type,metadata", limit: "3",
  });
  const jobs = await rows(env, fetchImpl, "yutakasa_ticket_repair_jobs", {
    ticket_id: `eq.${ticketId}`,
    select: "work_id,ticket_id,latest_user_message_id,status,attempt_count,claimed_run_id,pr_number,head_sha",
    limit: "2",
  });
  const userMessageId = messages.find((message) => message.sender_type === "user").id;
  const queued = ticket.status === "open" && ticket.automation_status === "queued" &&
    ticket.automation_lock_token === null && logs.length === 0 && jobs.length === 0;
  const investigating = ticket.status === "in_progress" &&
    ticket.automation_status === "investigating" && ticket.automation_lock_token === lockToken &&
    logs.length === 1 && logs[0].event_type === "automation_claimed" && jobs.length === 0;
  const awaiting = ticket.status === "in_progress" &&
    ticket.automation_status === "awaiting_repair" && ticket.automation_lock_token === null &&
    logs.length === 2 && logs.some((log) => log.event_type === "automation_claimed") &&
    logs.some((log) => log.event_type === "repair_work_queued" &&
      log.metadata?.work_id === workId) && jobs.length === 1 &&
    jobs[0].work_id === workId && jobs[0].ticket_id === ticketId &&
    jobs[0].latest_user_message_id === userMessageId && jobs[0].status === "queued" &&
    jobs[0].attempt_count === 0 && jobs[0].claimed_run_id === null &&
    jobs[0].pr_number === null && jobs[0].head_sha === null;
  if (!queued && !investigating && !awaiting) fail("handoff_smoke_unexpected_state");
  return { ticket, userMessageId, phase: queued ? "queued" : investigating ? "investigating" : "awaiting" };
}

async function cleanup(env, fetchImpl, email, runId, ticketId, workId, lockToken) {
  const accounts = await rows(env, fetchImpl, "subscribers", {
    email: `eq.${email}`,
    select: "id,email,name,status,subscription_status,first_payment_date,subscription_started_at,subscription_last_event_at,myasp_data,updated_at", limit: "2",
  });
  if (accounts.length > 1) fail("handoff_smoke_account_ambiguous");
  const account = accounts[0] ?? null;
  if (account && (!UUID.test(account.id ?? "") || account.email !== email ||
      account.name !== "System monitor test identity (no customer, no payment)" ||
      account.status !== "active" || account.subscription_status !== "active" ||
      account.first_payment_date !== null || account.subscription_started_at !== null ||
      account.subscription_last_event_at !== null ||
      account.myasp_data?.automation_test_identity !== MARKER ||
      account.myasp_data?.source !== "system_monitor_no_payment" ||
      account.myasp_data?.smoke_run_id !== runId ||
      !Number.isFinite(Date.parse(account.updated_at ?? "")))) {
    fail("handoff_smoke_account_changed");
  }
  if ((await rows(env, fetchImpl, "chat_threads", {
    user_email: `eq.${email}`, select: "id", limit: "1",
  })).length !== 0 || (await rows(env, fetchImpl, "otp_codes", {
    email: `eq.${email}`, select: "id", limit: "1",
  })).length !== 0) fail("handoff_smoke_unexpected_identity_data");

  const existingTicket = await ticketForEmail(env, fetchImpl, email);
  let current = null;
  if (existingTicket) {
    if (!account || !UUID.test(existingTicket.id) ||
        (ticketId && existingTicket.id !== ticketId)) fail("handoff_smoke_ticket_ambiguous");
    // Re-read exact messages, work logs and job immediately before a CAS delete.
    // Any operator change or claim leaves the ticket in place for investigation.
    const evidence = await supportEvidence(env, fetchImpl, existingTicket.id, email, workId, lockToken);
    current = await ticketForEmail(env, fetchImpl, email);
    if (!current || current.id !== existingTicket.id ||
        current.updated_at !== evidence.ticket.updated_at ||
        current.automation_status !== evidence.ticket.automation_status) {
      fail("handoff_smoke_ticket_changed");
    }
  }
  // One database transaction locks job -> ticket -> subscriber, validates
  // exact synthetic contents and deletes both rows. A concurrent AI claim
  // can change the job without touching ticket.updated_at, so HTTP DELETE
  // with a ticket timestamp alone would be unsafe here.
  const cleaned = await rows(env, fetchImpl, "rpc/cleanup_yutakasa_ticket_handoff_smoke",
    {}, "POST", {
      p_run_id: runId, p_account_id: account?.id ?? null,
      p_account_updated_at: account?.updated_at ?? null,
      p_ticket_id: current?.id ?? null,
      p_ticket_updated_at: current?.updated_at ?? null,
      p_work_id: workId, p_lock_token: lockToken,
    });
  if (cleaned.length !== 1 || cleaned[0].ticket_deleted !== Boolean(current) ||
      cleaned[0].subscriber_deleted !== Boolean(account)) {
    fail("handoff_smoke_cleanup_receipt_invalid");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (await ticketForEmail(env, fetchImpl, email) ||
        (await rows(env, fetchImpl, "subscribers", {
          email: `eq.${email}`, select: "id", limit: "1",
        })).length !== 0 ||
        (await rows(env, fetchImpl, "otp_codes", {
          email: `eq.${email}`, select: "id", limit: "1",
        })).length !== 0 ||
        (await rows(env, fetchImpl, "chat_threads", {
          user_email: `eq.${email}`, select: "id", limit: "1",
        })).length !== 0) fail("handoff_smoke_cleanup_incomplete");
    if (ticketId) {
      for (const table of ["support_messages", "support_work_logs", "yutakasa_ticket_repair_jobs",
        ...DEPENDENTS]) {
        if ((await rows(env, fetchImpl, table, {
          ticket_id: `eq.${ticketId}`, select: "ticket_id", limit: "1",
        })).length !== 0) fail("handoff_smoke_cleanup_incomplete");
      }
    }
    if (workId && (await rows(env, fetchImpl, "yutakasa_ticket_repair_jobs", {
      work_id: `eq.${workId}`, select: "work_id", limit: "1",
    })).length !== 0) fail("handoff_smoke_cleanup_incomplete");
  }
}

/** A main-only production probe; no AI, GitHub dispatch, email, or payment call. */
export async function runTicketRepairHandoffSmoke({ env = process.env,
  fetchImpl = globalThis.fetch, deploymentImpl = collectRemoteDeployment,
  supportTicketImpl = checkSyntheticSupportTicket } = {}) {
  validateEnvironment(env);
  const before = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  if (before?.ready !== true || before.mainSha !== env.GITHUB_SHA) {
    fail("handoff_smoke_production_not_at_main");
  }
  await verifyCleanupRpc(env, fetchImpl);
  await preflight(env, fetchImpl);
  const runId = randomUUID();
  const email = `yutakasa-auto-smoke+${runId}@example.invalid`;
  const lockToken = randomUUID();
  const workId = randomUUID();
  let ticketId = null;
  let primaryError;
  let completed = false;
  try {
    const account = await rows(env, fetchImpl, "subscribers", {
      select: "id,email,name,status,subscription_status,first_payment_date,subscription_started_at,subscription_last_event_at,myasp_data,updated_at",
    }, "POST", {
      email, name: "System monitor test identity (no customer, no payment)",
      status: "active", subscription_status: "active", first_payment_date: null,
      myasp_data: { automation_test_identity: MARKER,
        source: "system_monitor_no_payment", smoke_run_id: runId },
    });
    if (account.length !== 1 || account[0].email !== email ||
        account[0].myasp_data?.smoke_run_id !== runId) fail("handoff_smoke_account_insert_unconfirmed");
    const support = await supportTicketImpl(env, fetchImpl, email, sessionToken(env.JWT_SECRET, email));
    if (support?.ticketCreated !== true || support?.idempotent !== true ||
        support?.messagesSaved !== true || support?.queueIsolated !== true) {
      fail("handoff_smoke_support_creation_unconfirmed");
    }
    const initial = await ticketForEmail(env, fetchImpl, email);
    if (!initial) fail("handoff_smoke_ticket_missing");
    ticketId = initial.id;
    if ((await supportEvidence(env, fetchImpl, ticketId, email, workId, lockToken)).phase !== "queued") {
      fail("handoff_smoke_initial_state_invalid");
    }
    const claim = await supportApi(env, fetchImpl, "claim", { ticketId, lockToken });
    if (claim?.ticket?.id !== ticketId || claim.ticket.automation_status !== "investigating" ||
        claim.ticket.automation_lock_token !== lockToken) fail("handoff_smoke_claim_unconfirmed");
    const detail = await supportApi(env, fetchImpl, "detail", { ticketId }, lockToken);
    if (detail?.ticket?.id !== ticketId || detail.ticket.automation_status !== "investigating" ||
        detail.ticket.has_attachments !== false ||
        !Number.isFinite(Date.parse(detail.ticket.updated_at ?? "")) ||
        !Array.isArray(detail.messages) || detail.messages.length !== 2 ||
        detail.messages.filter((message) => message.sender_type === "user" &&
          message.body === TEST_SUPPORT_BODY && UUID.test(message.id ?? "")).length !== 1) {
      fail("handoff_smoke_detail_unconfirmed");
    }
    const latestUserMessageId = detail.messages.find((message) => message.sender_type === "user").id;
    const handoff = await supportApi(env, fetchImpl, "handoff", {
      ticketId, lockToken, workId, latestUserMessageId,
      ticketVersion: detail.ticket.updated_at,
    });
    if (handoff?.workId !== workId) fail("handoff_smoke_handoff_unconfirmed");
    const queued = await supportEvidence(env, fetchImpl, ticketId, email, workId, lockToken);
    if (queued.phase !== "awaiting" || queued.userMessageId !== latestUserMessageId) {
      fail("handoff_smoke_job_unconfirmed");
    }
    const due = await rows(env, fetchImpl, "rpc/list_due_yutakasa_ticket_repair_jobs", {}, "POST", {});
    if (due.length !== 1 || due[0].work_id !== workId) fail("handoff_smoke_dispatch_queue_invalid");
    await supportApi(env, fetchImpl, "handoff", {
      ticketId, lockToken, workId, latestUserMessageId,
      ticketVersion: detail.ticket.updated_at,
    }, null, 409);
    completed = true;
  } catch (error) {
    primaryError = error;
  } finally {
    try { await cleanup(env, fetchImpl, email, runId, ticketId, workId, lockToken); }
    catch { primaryError = new HandoffSmokeError("handoff_smoke_cleanup_incomplete"); }
  }
  if (primaryError) throw primaryError;
  if (!completed) fail("handoff_smoke_incomplete");
  const after = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  if (after?.ready !== true || after.mainSha !== before.mainSha ||
      after.deploymentId !== before.deploymentId) fail("handoff_smoke_production_changed");
  return { ok: true, mainSha: before.mainSha, deploymentId: before.deploymentId,
    supportApiClaimed: true, repairJobQueued: true, duplicateHandoffRejected: true,
    syntheticDataCleaned: true };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runTicketRepairHandoffSmoke().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const code = error instanceof HandoffSmokeError ? error.code : "handoff_smoke_failed";
      process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    },
  );
}
