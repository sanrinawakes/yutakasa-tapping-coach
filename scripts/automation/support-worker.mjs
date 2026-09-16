import crypto from "node:crypto";
import { MonitorLedgerError } from "./monitor-ledger.mjs";
import fs from "node:fs";

const SUPPORT_API = "https://yutakasa-tapping-coach.vercel.app/api/internal/support-automation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DECISION_TERMS = /返金|払い戻し|請求|決済|料金|価格|値上げ|値下げ|課金|契約|解約|退会|キャンセル|補償|賠償|弁護士|訴訟|法的|個人情報.{0,8}(削除|開示)|個人データ.{0,8}(削除|開示)|損害賠償|消費者センター/u;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONTEXT_BYTES = 8 * 1024 * 1024;
const MAX_TICKETS = 25;
const DEFAULT_MAX_RUNTIME_MS = 20 * 60 * 1000;

export class SupportWorkerError extends Error {
  constructor(code) {
    super(code);
    this.name = "SupportWorkerError";
    this.code = code;
  }
}

function fail(code) {
  throw new SupportWorkerError(code);
}

function validUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function latestUserMessage(ticket) {
  const users = ticket.messages.filter((message) => message.sender_type === "user");
  return users.at(-1);
}

export function validateTicketContext(context) {
  if (
    context?.schemaVersion !== 1 ||
    context.trust !== "untrusted_customer_input" ||
    !Number.isFinite(Date.parse(context.obtainedAt)) ||
    !Array.isArray(context.tickets) ||
    context.tickets.length > MAX_TICKETS
  ) {
    fail("support_context_schema_invalid");
  }
  const seen = new Set();
  for (const entry of context.tickets) {
    const ticket = entry?.ticket;
    if (
      !validUuid(ticket?.id) ||
      seen.has(ticket.id) ||
      !["queued", "failed"].includes(ticket.automation_status) ||
      !["open", "in_progress"].includes(ticket.status) ||
      ticket.decision_required !== false ||
      !["technical", "login", "quality", "how_to", "feature", "billing", "other"].includes(ticket.category) ||
      typeof ticket.subject !== "string" ||
      ticket.subject.length > 120 ||
      !Array.isArray(entry.messages) ||
      !Array.isArray(entry.work_logs) ||
      entry.messages.length > 500 ||
      entry.work_logs.length > 500
    ) {
      fail("support_context_ticket_invalid");
    }
    seen.add(ticket.id);
    for (const message of entry.messages) {
      if (
        !validUuid(message?.id) ||
        !["user", "admin", "system"].includes(message.sender_type) ||
        typeof message.body !== "string" ||
        message.body.length > 10_000 ||
        !Number.isFinite(Date.parse(message.created_at))
      ) {
        fail("support_context_message_invalid");
      }
    }
    for (const log of entry.work_logs) {
      if (typeof log?.event_type !== "string" || typeof log?.metadata !== "object") {
        fail("support_context_work_log_invalid");
      }
    }
  }
  return context.tickets;
}

export function readTicketContextFile(contextPath) {
  let stat;
  try {
    stat = fs.lstatSync(contextPath);
  } catch {
    fail("support_context_file_missing");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_CONTEXT_BYTES) {
    fail("support_context_file_security_invalid");
  }
  try {
    return validateTicketContext(JSON.parse(fs.readFileSync(contextPath, "utf8")));
  } catch (error) {
    if (error instanceof SupportWorkerError) throw error;
    fail("support_context_file_invalid");
  }
}

export function planTicket(entry) {
  const latest = latestUserMessage(entry);
  if (!latest) fail("support_context_missing_user_message");
  const decision =
    entry.ticket.category === "billing" ||
    DECISION_TERMS.test(`${entry.ticket.subject}\n${entry.messages.filter((message) => message.sender_type === "user").map((message) => message.body).join("\n")}`);
  if (decision) return { kind: "decision_required", latestUserMessageId: latest.id };
  const seen = entry.work_logs.some((log) =>
    log.event_type === "remote_support_escalated" &&
    log.metadata?.latestUserMessageId === latest.id
  );
  if (seen) return { kind: "already_escalated", latestUserMessageId: latest.id };
  return {
    kind: "technical_handoff",
    latestUserMessageId: latest.id,
  };
}

async function readApiJson(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_API_RESPONSE_BYTES) {
    fail("support_api_response_too_large");
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail("support_api_response_invalid");
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail("support_api_response_invalid");
      size += part.value.byteLength;
      if (size > MAX_API_RESPONSE_BYTES) {
        // A broken stream may ignore cancellation. The caller's hard deadline still applies.
        void reader.cancel().catch(() => {});
        fail("support_api_response_too_large");
      }
      chunks.push(part.value);
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
    fail("support_api_response_invalid_json");
  }
}

function validateApiResult(body, payload) {
  if (body.action === "log") {
    if (payload?.success !== true) fail("support_api_log_confirmation_invalid");
    return;
  }
  const ticket = payload?.ticket;
  if (!ticket || ticket.id !== body.ticketId) {
    fail(`support_api_${body.action}_confirmation_invalid`);
  }
  if (body.action === "claim") {
    if (
      ticket.automation_status !== "investigating" ||
      ticket.automation_lock_token !== body.lockToken ||
      ticket.decision_required !== false
    ) {
      fail("support_api_claim_confirmation_invalid");
    }
  } else if (body.action === "decision_required") {
    if (
      ticket.automation_status !== "blocked_decision" ||
      ticket.decision_required !== true ||
      ticket.automation_lock_token !== null
    ) {
      fail("support_api_decision_required_confirmation_invalid");
    }
  } else if (body.action === "failed") {
    if (ticket.automation_status !== "failed" || ticket.automation_lock_token !== null) {
      fail("support_api_failed_confirmation_invalid");
    }
  } else {
    fail("support_api_action_invalid");
  }
}

async function patchAction({ automationToken, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SupportWorkerError(`support_api_${body.action}_timeout_uncertain`));
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetchImpl(SUPPORT_API, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-automation-token": automationToken,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 409) return { status: "conflict" };
      if (response.status !== 200) {
        fail(`support_api_${body.action}_http_failure`);
      }
      // Confirm the state without ever returning or logging customer data.
      const payload = await readApiJson(response);
      validateApiResult(body, payload);
      return { status: "ok" };
    })();
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (error instanceof SupportWorkerError) throw error;
    fail(`support_api_${body.action}_request_uncertain`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function emptyResult() {
  return {
    examined: 0,
    skippedPriorEscalation: 0,
    claimConflicts: 0,
    decisionsRequired: 0,
    technicalHandoffs: 0,
    lostLocks: 0,
    uncertain: 0,
    deferred: 0,
  };
}

export async function processSupportTickets({
  automationToken,
  tickets,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxTickets = MAX_TICKETS,
  maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  now = Date.now,
  beforeMutation = async () => {},
} = {}) {
  if (typeof automationToken !== "string" || automationToken.length < 32 || /[\r\n]/u.test(automationToken)) {
    fail("support_automation_token_invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    fail("support_request_timeout_invalid");
  }
  if (!Number.isSafeInteger(maxTickets) || maxTickets < 1 || maxTickets > MAX_TICKETS) {
    fail("support_batch_limit_invalid");
  }
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < timeoutMs * 5 || maxRuntimeMs > DEFAULT_MAX_RUNTIME_MS) {
    fail("support_runtime_limit_invalid");
  }
  validateTicketContext({
    schemaVersion: 1,
    trust: "untrusted_customer_input",
    obtainedAt: new Date().toISOString(),
    tickets,
  });
  const result = emptyResult();
  const ownedPatchAction = async (arguments_) => {
    await beforeMutation();
    return patchAction(arguments_);
  };
  const deadline = now() + maxRuntimeMs;
  const batch = tickets.slice(0, maxTickets);
  for (const [index, entry] of batch.entries()) {
    if (now() + timeoutMs * 5 > deadline) {
      result.deferred += batch.length - index;
      break;
    }
    result.examined += 1;
    const plan = planTicket(entry);
    if (plan.kind === "already_escalated") {
      result.skippedPriorEscalation += 1;
      continue;
    }
    const ticketId = entry.ticket.id;
    const lockToken = crypto.randomUUID();
    let claimAttempted = false;
    try {
      claimAttempted = true;
      const claim = await ownedPatchAction({
        automationToken,
        body: { action: "claim", ticketId, lockToken },
        fetchImpl,
        timeoutMs,
      });
      if (claim.status === "conflict") {
        result.claimConflicts += 1;
        continue;
      }
      const heartbeat = await ownedPatchAction({
        automationToken,
        body: {
          action: "log",
          ticketId,
          lockToken,
          eventType: "automation_heartbeat",
          summary: "自動処理の所有権を確認しました。顧客への返信と本番変更は行っていません。",
          metadata: {},
        },
        fetchImpl,
        timeoutMs,
      });
      if (heartbeat.status === "conflict") {
        result.lostLocks += 1;
        continue;
      }
      if (plan.kind === "technical_handoff") {
        const log = await ownedPatchAction({
          automationToken,
          body: {
            action: "log",
            ticketId,
            lockToken,
            eventType: "remote_support_escalated",
            summary: "技術調査と本番検証が必要です。顧客への返信と本番変更は行っていません。",
            metadata: { latestUserMessageId: plan.latestUserMessageId },
          },
          fetchImpl,
          timeoutMs,
        });
        if (log.status === "conflict") {
          result.lostLocks += 1;
          continue;
        }
      }
      const terminal = await ownedPatchAction({
        automationToken,
        body: plan.kind === "decision_required"
          ? {
              action: "decision_required",
              ticketId,
              lockToken,
              summary: "料金、契約、法的対応、個人情報などの運営判断が必要です。顧客への返信と変更は行っていません。",
            }
          : {
              action: "failed",
              ticketId,
              lockToken,
              summary: "自動処理で原因と本番での修正結果を確定できません。技術担当による調査が必要です。顧客への返信と本番変更は行っていません。",
            },
        fetchImpl,
        timeoutMs,
      });
      if (terminal.status === "conflict") {
        result.lostLocks += 1;
        continue;
      }
      if (plan.kind === "decision_required") result.decisionsRequired += 1;
      else result.technicalHandoffs += 1;
      claimAttempted = false;
    } catch (error) {
      if (error instanceof MonitorLedgerError) throw error;
      result.uncertain += 1;
      if (claimAttempted) {
        try {
          const release = await ownedPatchAction({
            automationToken,
            body: {
              action: "failed",
              ticketId,
              lockToken,
              summary: "自動処理中のAPI応答を確認できません。再調査が必要です。顧客への返信と本番変更は行っていません。",
            },
            fetchImpl,
            timeoutMs,
          });
          if (release.status === "conflict") result.lostLocks += 1;
        } catch {
          // The API's 30-minute stale-lock recovery handles an uncertain release.
        }
      }
    }
  }
  result.ok = result.uncertain === 0 && result.lostLocks === 0 && result.deferred === 0;
  return result;
}

export async function processSupportTicketContextFile({ contextPath, ...options }) {
  const tickets = readTicketContextFile(contextPath);
  return processSupportTickets({ ...options, tickets });
}
