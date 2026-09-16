#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const DEFAULT_PRODUCTION_BASE_URL = "https://yutakasa-tapping-coach.vercel.app";
const DEFAULT_CHAT_TITLE = "新しいチャット";
const PAGE_SIZE = 1_000;
const MAX_PAGES_PER_TABLE = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 55_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const USER_LAST_GRACE_MS = 20 * 60 * 1_000;
const SUPPORT_STALE_LOCK_MS = 30 * 60 * 1_000;
const NEAR_DUPLICATE_DICE_BPS = 8_500;
const MIN_SIMILARITY_TEXT_LENGTH = 8;
const MAX_ENV_FILE_BYTES = 1024 * 1024;

const REQUIRED_SCHEMA = Object.freeze({
  chat_threads: ["id", "user_email", "title", "created_at"],
  chat_messages: ["id", "thread_id", "role", "created_at"],
  otp_codes: ["id", "used"],
  support_tickets: [
    "id",
    "status",
    "automation_status",
    "decision_required",
    "automation_locked_at",
  ],
  support_messages: ["id"],
  support_attachments: ["id"],
  support_work_logs: ["id"],
});

export class SnapshotError extends Error {
  constructor(code) {
    super(code);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function fail(code) {
  throw new SnapshotError(code);
}

function assertPositiveInteger(value, code, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code);
  }
  return value;
}

function assertRegularPrivateFile(filePath, code) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    fail(code);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    fail(code);
  }
  return stats;
}

function requireEnvValue(environment, name, minimumLength = 1) {
  const value = environment[name];
  if (typeof value !== "string" || value.length < minimumLength) {
    fail(`env_missing_${name.toLowerCase()}`);
  }
  if (/\r|\n/u.test(value)) fail(`env_invalid_${name.toLowerCase()}`);
  return value;
}

function parseHttpsUrl(value, code) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) fail(code);
  parsed.hash = "";
  parsed.search = "";
  return parsed;
}

export function parseDotEnv(source) {
  if (typeof source !== "string") fail("env_invalid_text");
  const physicalLines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (const line of physicalLines) {
    const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/u.exec(
      line,
    );
    if (!assignment) continue;
    const rawValue = assignment[1];
    const quote = rawValue[0];
    if (quote !== '"' && quote !== "'") continue;
    let closedAt = -1;
    for (let index = 1; index < rawValue.length; index += 1) {
      if (rawValue[index] !== quote) continue;
      if (quote === '"') {
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && rawValue[cursor] === "\\"; cursor -= 1) {
          slashCount += 1;
        }
        if (slashCount % 2 === 1) continue;
      }
      closedAt = index;
      break;
    }
    if (closedAt === -1) fail("env_parse_failed");
    const trailing = rawValue.slice(closedAt + 1).trim();
    if (trailing && !trailing.startsWith("#")) fail("env_parse_failed");
  }
  let parsed;
  try {
    parsed = parseEnv(source.replace(/^\uFEFF/u, ""));
  } catch {
    fail("env_parse_failed");
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      ([key, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof value === "string",
    ),
  );
}

export function loadSnapshotEnvironment(envFilePath) {
  const resolvedPath = path.resolve(envFilePath);
  const stats = assertRegularPrivateFile(resolvedPath, "env_file_not_private_regular");
  if (stats.size > MAX_ENV_FILE_BYTES) fail("env_file_too_large");

  let environment;
  try {
    environment = parseDotEnv(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    fail("env_file_read_failed");
  }

  const supabaseUrl = requireEnvValue(environment, "SUPABASE_URL", 12);
  const supabaseServiceRoleKey = requireEnvValue(
    environment,
    "SUPABASE_SERVICE_ROLE_KEY",
    20,
  );
  const automationToken =
    typeof environment.JWT_SECRET === "string" && environment.JWT_SECRET.length >= 32
      ? environment.JWT_SECRET
      : requireEnvValue(environment, "CRON_SECRET", 32);
  const jwtSecret =
    typeof environment.JWT_SECRET === "string" && environment.JWT_SECRET.length >= 32
      ? environment.JWT_SECRET
      : null;

  return {
    supabaseUrl: parseHttpsUrl(supabaseUrl, "env_invalid_supabase_url").origin,
    supabaseServiceRoleKey,
    automationToken,
    jwtSecret,
  };
}

function createDeadline(overallTimeoutMs) {
  return Date.now() + overallTimeoutMs;
}

async function readLimitedJsonBody(response, label, signal) {
  const rawContentLength = response.headers?.get?.("content-length");
  if (rawContentLength && /^\d+$/u.test(rawContentLength)) {
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength > MAX_JSON_RESPONSE_BYTES) {
      fail(`${label}_response_too_large`);
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail(`${label}_invalid_json_body`);
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (signal.aborted) fail(`${label}_timeout`);
      if (!result || typeof result !== "object") fail(`${label}_invalid_json_body`);
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) fail(`${label}_invalid_json_body`);
      totalBytes += result.value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_JSON_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        fail(`${label}_response_too_large`);
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The bounded read result remains authoritative.
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label}_invalid_json`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label}_invalid_json`);
  }
}

async function boundedHttpRequest(
  fetchImpl,
  url,
  init,
  { label, deadlineMs, requestTimeoutMs, consumeJson = false },
) {
  if (!new Set(["GET", "HEAD"]).has(init.method)) fail("non_read_only_http_method");
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) fail("snapshot_overall_timeout");
  const timeoutMs = Math.max(1, Math.min(requestTimeoutMs, remainingMs));
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SnapshotError(`${label}_timeout`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        let response;
        try {
          response = await fetchImpl(url, {
            ...init,
            redirect: "error",
            signal: controller.signal,
          });
        } catch {
          fail(`${label}_network_failure`);
        }
        if (!response || typeof response.ok !== "boolean") {
          fail(`${label}_invalid_response`);
        }
        if (!response.ok) fail(`${label}_http_${Number(response.status) || 0}`);
        if (!consumeJson) return response;
        try {
          return await readLimitedJsonBody(response, label, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) fail(`${label}_timeout`);
          if (error instanceof SnapshotError) {
            if (error.code === `${label}_response_too_large`) controller.abort();
            throw error;
          }
          fail(`${label}_invalid_json`);
        }
      }),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    fail(`${label}_network_failure`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(fetchImpl, url, init, timing, label) {
  return boundedHttpRequest(fetchImpl, url, init, {
    ...timing,
    label,
    consumeJson: true,
  });
}

export async function fetchReadOnlyJson(
  fetchImpl,
  url,
  {
    headers = {},
    label = "read_only",
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS,
  } = {},
) {
  assertPositiveInteger(requestTimeoutMs, "snapshot_invalid_request_timeout", 1, 60_000);
  assertPositiveInteger(overallTimeoutMs, "snapshot_invalid_overall_timeout", 1, 60_000);
  return fetchJson(
    fetchImpl,
    url,
    { method: "GET", headers },
    { deadlineMs: createDeadline(overallTimeoutMs), requestTimeoutMs },
    label,
  );
}

function supabaseHeaders(serviceRoleKey, accept = "application/json") {
  return {
    Accept: accept,
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

function schemaDefinitions(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("supabase_schema_invalid_document");
  }
  const candidates = [document.definitions, document.components?.schemas];
  const definitions = candidates.find(
    (candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate),
  );
  if (!definitions) fail("supabase_schema_missing_definitions");
  return definitions;
}

export function validateSupabaseSchema(document, { includeMessageContent = false } = {}) {
  const definitions = schemaDefinitions(document);
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    const definition = definitions[table];
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      fail(`supabase_schema_missing_table_${table}`);
    }
    const properties = definition.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      fail(`supabase_schema_missing_properties_${table}`);
    }
    for (const column of requiredColumns) {
      if (!Object.hasOwn(properties, column)) {
        fail(`supabase_schema_missing_column_${table}_${column}`);
      }
    }
  }
  if (
    includeMessageContent &&
    !Object.hasOwn(definitions.chat_messages.properties, "content")
  ) {
    fail("supabase_schema_missing_column_chat_messages_content");
  }
  return true;
}

async function readSupportApiCount(
  fetchImpl,
  productionBaseUrl,
  automationToken,
  timing,
) {
  const url = new URL("/api/internal/support-automation", productionBaseUrl);
  url.searchParams.set("limit", "25");
  const payload = await fetchJson(
    fetchImpl,
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-automation-token": automationToken,
      },
    },
    timing,
    "support_api",
  );
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tickets)) {
    fail("support_api_invalid_shape");
  }
  if (payload.tickets.length > 25) fail("support_api_batch_limit_exceeded");
  return payload.tickets.length;
}

async function readOpenApiSchema(
  fetchImpl,
  supabaseUrl,
  serviceRoleKey,
  timing,
  { includeMessageContent = false } = {},
) {
  const url = new URL("/rest/v1/", supabaseUrl);
  const document = await fetchJson(
    fetchImpl,
    url,
    {
      method: "GET",
      headers: supabaseHeaders(serviceRoleKey, "application/openapi+json"),
    },
    timing,
    "supabase_schema",
  );
  validateSupabaseSchema(document, { includeMessageContent });
}

function tableUrl(supabaseUrl, table) {
  return new URL(`/rest/v1/${encodeURIComponent(table)}`, supabaseUrl);
}

async function readExactCount(
  fetchImpl,
  supabaseUrl,
  serviceRoleKey,
  table,
  filters,
  timing,
) {
  const url = tableUrl(supabaseUrl, table);
  url.searchParams.set("select", "id");
  for (const [column, value] of Object.entries(filters ?? {})) {
    url.searchParams.set(column, value);
  }
  const response = await boundedHttpRequest(
    fetchImpl,
    url,
    {
      method: "HEAD",
      headers: {
        ...supabaseHeaders(serviceRoleKey),
        Prefer: "count=exact",
        Range: "0-0",
        "Range-Unit": "items",
      },
    },
    { ...timing, label: `supabase_count_${table}`, consumeJson: false },
  );
  const contentRange = response.headers?.get?.("content-range") ?? "";
  const match = /\/(\d+)$/u.exec(contentRange);
  if (!match) fail(`supabase_count_${table}_missing_exact_count`);
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 0) {
    fail(`supabase_count_${table}_invalid_exact_count`);
  }
  return count;
}

async function readAllRows(
  fetchImpl,
  supabaseUrl,
  serviceRoleKey,
  table,
  select,
  timing,
) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES_PER_TABLE; page += 1) {
    const offset = page * PAGE_SIZE;
    const url = tableUrl(supabaseUrl, table);
    url.searchParams.set("select", select);
    url.searchParams.set("order", "id.asc");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    const payload = await fetchJson(
      fetchImpl,
      url,
      {
        method: "GET",
        headers: {
          ...supabaseHeaders(serviceRoleKey),
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
          "Range-Unit": "items",
        },
      },
      timing,
      `supabase_page_${table}`,
    );
    if (!Array.isArray(payload) || payload.length > PAGE_SIZE) {
      fail(`supabase_page_${table}_invalid_shape`);
    }
    rows.push(...payload);
    if (payload.length < PAGE_SIZE) return rows;
  }
  fail(`supabase_page_${table}_limit_exceeded`);
}

function requireString(row, key, table, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail(`supabase_row_${table}_${index}_invalid`);
  }
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`supabase_row_${table}_${index}_invalid_${key}`);
  }
  return value;
}

function timestampMs(row, key, table, index) {
  const value = requireString(row, key, table, index);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`supabase_row_${table}_${index}_invalid_${key}`);
  return parsed;
}

function countRoles(messages, cutoffMs = Number.NEGATIVE_INFINITY) {
  let user = 0;
  let assistant = 0;
  let other = 0;
  for (const message of messages) {
    if (message.createdAtMs < cutoffMs) continue;
    if (message.role === "user") user += 1;
    else if (message.role === "assistant") assistant += 1;
    else other += 1;
  }
  return { user, assistant, other, deltaUserMinusAssistant: user - assistant };
}

export function aggregateChatMetrics(threadRows, messageRows, nowMs) {
  if (!Array.isArray(threadRows) || !Array.isArray(messageRows)) {
    fail("chat_rows_invalid");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("snapshot_invalid_now");
  const recentCutoffMs = nowMs - RECENT_WINDOW_MS;
  const unansweredCutoffMs = nowMs - USER_LAST_GRACE_MS;
  const threads = [];
  const threadsById = new Map();

  for (const [index, row] of threadRows.entries()) {
    const id = requireString(row, "id", "chat_threads", index);
    const userEmail = requireString(row, "user_email", "chat_threads", index)
      .trim()
      .toLowerCase();
    if (!userEmail) fail(`supabase_row_chat_threads_${index}_invalid_user_email`);
    const title = typeof row.title === "string" ? row.title : "";
    const createdAtMs = timestampMs(row, "created_at", "chat_threads", index);
    if (threadsById.has(id)) fail("chat_threads_duplicate_id");
    const thread = {
      id,
      userEmail,
      title,
      createdAtMs,
      messageCount: 0,
      lastMessage: null,
      hasRecentMessage: false,
    };
    threads.push(thread);
    threadsById.set(id, thread);
  }

  const messages = [];
  let orphanMessagesAll = 0;
  for (const [index, row] of messageRows.entries()) {
    const id = requireString(row, "id", "chat_messages", index);
    const threadId = requireString(row, "thread_id", "chat_messages", index);
    const role = requireString(row, "role", "chat_messages", index);
    const createdAtMs = timestampMs(row, "created_at", "chat_messages", index);
    const message = { id, threadId, role, createdAtMs };
    messages.push(message);
    const thread = threadsById.get(threadId);
    if (!thread) {
      orphanMessagesAll += 1;
      continue;
    }
    thread.messageCount += 1;
    if (createdAtMs >= recentCutoffMs) thread.hasRecentMessage = true;
    if (
      !thread.lastMessage ||
      createdAtMs > thread.lastMessage.createdAtMs ||
      (createdAtMs === thread.lastMessage.createdAtMs && id > thread.lastMessage.id)
    ) {
      thread.lastMessage = message;
    }
  }

  const allRoles = countRoles(messages);
  const recentRoles = countRoles(messages, recentCutoffMs);
  const emptyThreads = threads.filter((thread) => thread.messageCount === 0);
  const emptyByUser = new Map();
  for (const thread of emptyThreads) {
    const list = emptyByUser.get(thread.userEmail) ?? [];
    list.push(thread);
    emptyByUser.set(thread.userEmail, list);
  }
  let duplicateEmptyThreadGroupsAll = 0;
  let duplicateEmptyThreadExcessAll = 0;
  let duplicateEmptyThreadExcessCreatedLast24h = 0;
  for (const list of emptyByUser.values()) {
    list.sort(
      (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
    );
    if (list.length > 1) duplicateEmptyThreadGroupsAll += 1;
    duplicateEmptyThreadExcessAll += Math.max(0, list.length - 1);
    duplicateEmptyThreadExcessCreatedLast24h += list
      .slice(1)
      .filter((thread) => thread.createdAtMs >= recentCutoffMs).length;
  }

  const userLastOver20m = threads.filter(
    (thread) =>
      thread.lastMessage?.role === "user" &&
      thread.lastMessage.createdAtMs <= unansweredCutoffMs,
  );

  return {
    threadsTotal: threads.length,
    threadsCreatedLast24h: threads.filter(
      (thread) => thread.createdAtMs >= recentCutoffMs,
    ).length,
    messagesTotal: messages.length,
    messagesCreatedLast24h:
      recentRoles.user + recentRoles.assistant + recentRoles.other,
    userMessagesTotal: allRoles.user,
    assistantMessagesTotal: allRoles.assistant,
    otherRoleMessagesTotal: allRoles.other,
    userMessagesLast24h: recentRoles.user,
    assistantMessagesLast24h: recentRoles.assistant,
    otherRoleMessagesLast24h: recentRoles.other,
    roleDeltaUserMinusAssistantAll: allRoles.deltaUserMinusAssistant,
    roleDeltaUserMinusAssistantLast24h: recentRoles.deltaUserMinusAssistant,
    defaultTitleWithMessagesAll: threads.filter(
      (thread) =>
        thread.title.trim() === DEFAULT_CHAT_TITLE && thread.messageCount > 0,
    ).length,
    defaultTitleWithMessagesActiveLast24h: threads.filter(
      (thread) =>
        thread.title.trim() === DEFAULT_CHAT_TITLE &&
        thread.messageCount > 0 &&
        thread.hasRecentMessage,
    ).length,
    emptyThreadsAll: emptyThreads.length,
    emptyThreadsCreatedLast24h: emptyThreads.filter(
      (thread) => thread.createdAtMs >= recentCutoffMs,
    ).length,
    duplicateEmptyThreadGroupsAll,
    duplicateEmptyThreadExcessAll,
    duplicateEmptyThreadExcessCreatedLast24h,
    userLastOver20mAll: userLastOver20m.length,
    userLastOver20mLast24h: userLastOver20m.filter(
      (thread) => thread.lastMessage.createdAtMs >= recentCutoffMs,
    ).length,
    orphanMessagesAll,
  };
}

export function aggregateSupportQueueMetrics(ticketRows, nowMs) {
  if (!Array.isArray(ticketRows)) fail("support_ticket_rows_invalid");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("snapshot_invalid_now");
  const staleBeforeMs = nowMs - SUPPORT_STALE_LOCK_MS;
  let staleRecoveryCandidates = 0;
  let pendingTicketsExactAfterRecovery = 0;

  for (const [index, row] of ticketRows.entries()) {
    requireString(row, "id", "support_tickets", index);
    const status = requireString(row, "status", "support_tickets", index);
    const automationStatus = requireString(
      row,
      "automation_status",
      "support_tickets",
      index,
    );
    if (typeof row.decision_required !== "boolean") {
      fail(`supabase_row_support_tickets_${index}_invalid_decision_required`);
    }
    let lockedAtMs = null;
    if (row.automation_locked_at !== null) {
      if (typeof row.automation_locked_at !== "string") {
        fail(`supabase_row_support_tickets_${index}_invalid_automation_locked_at`);
      }
      lockedAtMs = Date.parse(row.automation_locked_at);
      if (!Number.isFinite(lockedAtMs)) {
        fail(`supabase_row_support_tickets_${index}_invalid_automation_locked_at`);
      }
    }
    const activeStatus = status === "open" || status === "in_progress";
    const recoverable =
      row.decision_required === false &&
      activeStatus &&
      automationStatus === "investigating" &&
      (lockedAtMs === null || lockedAtMs < staleBeforeMs);
    if (recoverable) staleRecoveryCandidates += 1;
    const automationStatusAfterRecovery = recoverable ? "failed" : automationStatus;
    if (
      row.decision_required === false &&
      activeStatus &&
      (automationStatusAfterRecovery === "queued" ||
        automationStatusAfterRecovery === "failed")
    ) {
      pendingTicketsExactAfterRecovery += 1;
    }
  }
  return { staleRecoveryCandidates, pendingTicketsExactAfterRecovery };
}

function compareMessages(left, right) {
  return left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id);
}

function normalizedSimilarityText(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function diceSimilarityBasisPoints(leftInput, rightInput) {
  if (typeof leftInput !== "string" || typeof rightInput !== "string") return 0;
  const left = Array.from(normalizedSimilarityText(leftInput));
  const right = Array.from(normalizedSimilarityText(rightInput));
  if (
    left.length < MIN_SIMILARITY_TEXT_LENGTH ||
    right.length < MIN_SIMILARITY_TEXT_LENGTH
  ) {
    return 0;
  }
  if (left.join("") === right.join("")) return 10_000;
  const leftPairs = [];
  const rightPairs = [];
  for (let index = 0; index < left.length - 1; index += 1) {
    leftPairs.push(`${left[index]}\u0000${left[index + 1]}`);
  }
  for (let index = 0; index < right.length - 1; index += 1) {
    rightPairs.push(`${right[index]}\u0000${right[index + 1]}`);
  }
  const counts = new Map();
  for (const pair of leftPairs) counts.set(pair, (counts.get(pair) ?? 0) + 1);
  let intersection = 0;
  for (const pair of rightPairs) {
    const remaining = counts.get(pair) ?? 0;
    if (remaining <= 0) continue;
    intersection += 1;
    counts.set(pair, remaining - 1);
  }
  return Math.round((2 * intersection * 10_000) / (leftPairs.length + rightPairs.length));
}

function anonymousFingerprint(hmacKey, namespace, value) {
  return crypto
    .createHmac("sha256", hmacKey)
    .update(`${namespace}\u0000${value}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

export function classifyUserLastAnomalies(threadRows, messageRows, nowMs, hmacKey) {
  if (!Array.isArray(threadRows) || !Array.isArray(messageRows)) {
    fail("anomaly_rows_invalid");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("snapshot_invalid_now");
  if (typeof hmacKey !== "string" || hmacKey.length < 32) {
    fail("anomaly_requires_jwt_secret");
  }
  const unansweredCutoffMs = nowMs - USER_LAST_GRACE_MS;
  const threadsById = new Map();
  for (const [index, row] of threadRows.entries()) {
    const id = requireString(row, "id", "chat_threads", index);
    const userEmail = requireString(row, "user_email", "chat_threads", index)
      .trim()
      .toLowerCase();
    if (!userEmail) fail(`supabase_row_chat_threads_${index}_invalid_user_email`);
    if (threadsById.has(id)) fail("chat_threads_duplicate_id");
    threadsById.set(id, { id, userEmail, messages: [] });
  }
  for (const [index, row] of messageRows.entries()) {
    const id = requireString(row, "id", "chat_messages", index);
    const threadId = requireString(row, "thread_id", "chat_messages", index);
    const role = requireString(row, "role", "chat_messages", index);
    const createdAtMs = timestampMs(row, "created_at", "chat_messages", index);
    if (typeof row.content !== "string") {
      fail(`supabase_row_chat_messages_${index}_invalid_content`);
    }
    const thread = threadsById.get(threadId);
    if (!thread) continue;
    thread.messages.push({ id, threadId, role, content: row.content, createdAtMs });
  }
  for (const thread of threadsById.values()) thread.messages.sort(compareMessages);

  const candidateThreads = [...threadsById.values()].filter((thread) => {
    const last = thread.messages.at(-1);
    return last?.role === "user" && last.createdAtMs <= unansweredCutoffMs;
  });
  const candidates = [];
  for (const thread of candidateThreads) {
    const lastUser = thread.messages.at(-1);
    const matchesByThread = new Map();
    for (const otherThread of threadsById.values()) {
      if (otherThread.id === thread.id || otherThread.userEmail !== thread.userEmail) continue;
      for (const message of otherThread.messages) {
        if (message.role !== "user") continue;
        const similarityBasisPoints = diceSimilarityBasisPoints(
          lastUser.content,
          message.content,
        );
        if (similarityBasisPoints < NEAR_DUPLICATE_DICE_BPS) continue;
        const followedByAssistant = otherThread.messages.some(
          (candidate) =>
            candidate.role === "assistant" && compareMessages(candidate, message) > 0,
        );
        const previous = matchesByThread.get(otherThread.id);
        if (
          !previous ||
          Number(followedByAssistant) > Number(previous.followedByAssistant) ||
          (followedByAssistant === previous.followedByAssistant &&
            similarityBasisPoints > previous.similarityBasisPoints)
        ) {
          matchesByThread.set(otherThread.id, {
            otherThread,
            followedByAssistant,
            similarityBasisPoints,
          });
        }
      }
    }
    const matches = [...matchesByThread.values()].sort(
      (left, right) =>
        Number(right.followedByAssistant) - Number(left.followedByAssistant) ||
        right.similarityBasisPoints - left.similarityBasisPoints ||
        left.otherThread.id.localeCompare(right.otherThread.id),
    );
    const chosen = matches[0] ?? null;
    const answeredElsewhere = matches.some((match) => match.followedByAssistant);
    const userCount = thread.messages.filter((message) => message.role === "user").length;
    const assistantCount = thread.messages.filter(
      (message) => message.role === "assistant",
    ).length;
    candidates.push({
      candidateFingerprint: anonymousFingerprint(hmacKey, "thread", thread.id),
      lastUserAt: new Date(lastUser.createdAtMs).toISOString(),
      messageCounts: {
        total: thread.messages.length,
        user: userCount,
        assistant: assistantCount,
        other: thread.messages.length - userCount - assistantCount,
      },
      nearDuplicateOtherThreadCount: matches.length,
      nearDuplicateThreadFingerprint: chosen
        ? anonymousFingerprint(hmacKey, "thread", chosen.otherThread.id)
        : null,
      nearDuplicateSimilarityBasisPoints: chosen?.similarityBasisPoints ?? 0,
      nearDuplicateFollowedByAssistant: answeredElsewhere,
      classification: answeredElsewhere ? "answered_elsewhere" : "missing_assistant",
    });
  }
  candidates.sort(
    (left, right) =>
      left.lastUserAt.localeCompare(right.lastUserAt) ||
      left.candidateFingerprint.localeCompare(right.candidateFingerprint),
  );
  return {
    classificationOnly: true,
    algorithm: {
      name: "normalized_bigram_dice",
      minimumTextCharacters: MIN_SIMILARITY_TEXT_LENGTH,
      nearDuplicateThresholdBasisPoints: NEAR_DUPLICATE_DICE_BPS,
    },
    candidateCount: candidates.length,
    missingAssistantCount: candidates.filter(
      (candidate) => candidate.classification === "missing_assistant",
    ).length,
    answeredElsewhereCount: candidates.filter(
      (candidate) => candidate.classification === "answered_elsewhere",
    ).length,
    nearDuplicateCandidateCount: candidates.filter(
      (candidate) => candidate.nearDuplicateOtherThreadCount > 0,
    ).length,
    candidates,
  };
}

export async function collectProductionSnapshot({
  environment,
  fetchImpl = globalThis.fetch,
  productionBaseUrl = DEFAULT_PRODUCTION_BASE_URL,
  nowMs = Date.now(),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS,
  mode = "snapshot",
} = {}) {
  if (!environment || typeof environment !== "object") fail("snapshot_missing_environment");
  if (typeof fetchImpl !== "function") fail("snapshot_missing_fetch");
  assertPositiveInteger(requestTimeoutMs, "snapshot_invalid_request_timeout", 1, 60_000);
  assertPositiveInteger(overallTimeoutMs, "snapshot_invalid_overall_timeout", 1, 60_000);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("snapshot_invalid_now");
  if (mode !== "snapshot" && mode !== "anomalies") fail("snapshot_invalid_mode");
  const includeAnomalies = mode === "anomalies";

  const supabaseUrl = parseHttpsUrl(
    requireEnvValue(environment, "supabaseUrl", 12),
    "snapshot_invalid_supabase_url",
  );
  const serviceRoleKey = requireEnvValue(
    environment,
    "supabaseServiceRoleKey",
    20,
  );
  const automationToken = requireEnvValue(environment, "automationToken", 32);
  const jwtSecret = includeAnomalies
    ? requireEnvValue(environment, "jwtSecret", 32)
    : null;
  const productionUrl = parseHttpsUrl(
    productionBaseUrl,
    "snapshot_invalid_production_url",
  );
  const timing = {
    deadlineMs: createDeadline(overallTimeoutMs),
    requestTimeoutMs,
  };

  await readOpenApiSchema(fetchImpl, supabaseUrl, serviceRoleKey, timing, {
    includeMessageContent: includeAnomalies,
  });

  const [
    threadRows,
    messageRows,
    supportTicketRows,
    supportMessages,
    supportAttachments,
    supportWorkLogs,
    otpTotal,
    otpUsed,
    otpUnused,
    otpNull,
  ] = await Promise.all([
    readAllRows(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      "chat_threads",
      "id,user_email,title,created_at",
      timing,
    ),
    readAllRows(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      "chat_messages",
      includeAnomalies
        ? "id,thread_id,role,content,created_at"
        : "id,thread_id,role,created_at",
      timing,
    ),
    readAllRows(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      "support_tickets",
      "id,status,automation_status,decision_required,automation_locked_at",
      timing,
    ),
    readExactCount(fetchImpl, supabaseUrl, serviceRoleKey, "support_messages", {}, timing),
    readExactCount(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      "support_attachments",
      {},
      timing,
    ),
    readExactCount(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      "support_work_logs",
      {},
      timing,
    ),
    readExactCount(fetchImpl, supabaseUrl, serviceRoleKey, "otp_codes", {}, timing),
    readExactCount(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      "otp_codes",
      { used: "eq.true" },
      timing,
    ),
    readExactCount(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      "otp_codes",
      { used: "eq.false" },
      timing,
    ),
    readExactCount(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      "otp_codes",
      { used: "is.null" },
      timing,
    ),
  ]);

  if (otpUsed + otpUnused + otpNull !== otpTotal) {
    fail("otp_exact_counts_inconsistent");
  }
  const chat = aggregateChatMetrics(threadRows, messageRows, nowMs);
  const supportQueue = aggregateSupportQueueMetrics(supportTicketRows, nowMs);
  const anomalies = includeAnomalies
    ? classifyUserLastAnomalies(threadRows, messageRows, nowMs, jwtSecret)
    : null;

  let pendingTicketBatchCount;
  try {
    pendingTicketBatchCount = await readSupportApiCount(
      fetchImpl,
      productionUrl,
      automationToken,
      timing,
    );
  } catch {
    fail("support_api_failed_possible_recovery_side_effect");
  }
  const expectedPendingTicketBatchCount = Math.min(
    supportQueue.pendingTicketsExactAfterRecovery,
    25,
  );
  const pendingTicketBatchCountMismatch =
    pendingTicketBatchCount !== expectedPendingTicketBatchCount;

  const snapshot = {
    schemaVersion: 2,
    mode,
    observedAt: new Date(nowMs).toISOString(),
    windows: {
      recentHours: 24,
      userLastGraceMinutes: 20,
      supportStaleLockMinutes: 30,
    },
    supportApi: {
      pendingTicketBatchCount,
      expectedPendingTicketBatchCount,
      pendingTicketBatchCountMismatch,
      batchLimit: 25,
      intentionalStaleRecoveryCheck: true,
      getMayUpdateStaleLocksAndInsertRecoveryLogs: true,
    },
    database: {
      support: {
        tickets: supportTicketRows.length,
        messages: supportMessages,
        attachments: supportAttachments,
        workLogs: supportWorkLogs,
        staleRecoveryCandidatesBeforeGet: supportQueue.staleRecoveryCandidates,
        pendingTicketsExactAfterRecovery:
          supportQueue.pendingTicketsExactAfterRecovery,
      },
      otp: { total: otpTotal, used: otpUsed, unused: otpUnused, nullUsed: otpNull },
      chat,
    },
  };
  if (anomalies) snapshot.anomalies = anomalies;
  return snapshot;
}

export function collectProductionAnomalies(options = {}) {
  return collectProductionSnapshot({ ...options, mode: "anomalies" });
}

export function countOnlySummary(snapshot) {
  const summary = {
    pendingTicketBatchCount: snapshot.supportApi.pendingTicketBatchCount,
    expectedPendingTicketBatchCount:
      snapshot.supportApi.expectedPendingTicketBatchCount,
    pendingTicketBatchCountMismatch: Number(
      snapshot.supportApi.pendingTicketBatchCountMismatch,
    ),
    intentionalStaleRecoveryCheck: Number(
      snapshot.supportApi.intentionalStaleRecoveryCheck,
    ),
    supportTickets: snapshot.database.support.tickets,
    supportMessages: snapshot.database.support.messages,
    supportAttachments: snapshot.database.support.attachments,
    supportWorkLogs: snapshot.database.support.workLogs,
    staleRecoveryCandidatesBeforeGet:
      snapshot.database.support.staleRecoveryCandidatesBeforeGet,
    pendingTicketsExactAfterRecovery:
      snapshot.database.support.pendingTicketsExactAfterRecovery,
    otpTotal: snapshot.database.otp.total,
    otpUsed: snapshot.database.otp.used,
    otpUnused: snapshot.database.otp.unused,
    otpNullUsed: snapshot.database.otp.nullUsed,
    ...snapshot.database.chat,
  };
  if (snapshot.anomalies) {
    summary.anomalyCandidateCount = snapshot.anomalies.candidateCount;
    summary.anomalyMissingAssistantCount = snapshot.anomalies.missingAssistantCount;
    summary.anomalyAnsweredElsewhereCount = snapshot.anomalies.answeredElsewhereCount;
    summary.anomalyNearDuplicateCandidateCount =
      snapshot.anomalies.nearDuplicateCandidateCount;
  }
  return summary;
}

export function writeSnapshotFile(outputFilePath, snapshot) {
  const resolvedPath = path.resolve(outputFilePath);
  const parentPath = path.dirname(resolvedPath);
  let parentStats;
  try {
    parentStats = fs.lstatSync(parentPath);
  } catch {
    fail("output_parent_missing");
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    fail("output_parent_invalid");
  }
  const payload = `${JSON.stringify(snapshot)}\n`;
  let descriptor;
  let created = false;
  let completed = false;
  try {
    descriptor = fs.openSync(resolvedPath, "wx", 0o600);
    created = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, payload, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      fail("output_mode_invalid");
    }
    completed = true;
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    fail("output_write_failed");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The write failure remains the authoritative error.
      }
    }
    if (created && !completed) {
      try {
        const stats = fs.lstatSync(resolvedPath);
        if (stats.isFile() && !stats.isSymbolicLink()) fs.unlinkSync(resolvedPath);
      } catch {
        // Nothing else should be removed.
      }
    }
  }
  return resolvedPath;
}

function errorCode(error) {
  return error instanceof SnapshotError ? error.code : "snapshot_unexpected_failure";
}

export function validateCliFileLayout(envFilePath, outputFilePath) {
  const resolvedEnvPath = path.resolve(envFilePath);
  const resolvedOutputPath = path.resolve(outputFilePath);
  if (resolvedEnvPath === resolvedOutputPath) fail("cli_files_must_differ");
  const envParent = path.dirname(resolvedEnvPath);
  const outputParent = path.dirname(resolvedOutputPath);
  if (envParent !== outputParent) fail("cli_files_must_share_parent");
  let parentStats;
  try {
    parentStats = fs.lstatSync(envParent);
  } catch {
    fail("cli_parent_missing");
  }
  if (
    !parentStats.isDirectory() ||
    parentStats.isSymbolicLink() ||
    (parentStats.mode & 0o777) !== 0o700
  ) {
    fail("cli_parent_must_be_0700_directory");
  }
  try {
    fs.lstatSync(resolvedOutputPath);
    fail("cli_output_must_be_new");
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (error?.code !== "ENOENT") fail("cli_output_check_failed");
  }
  return { resolvedEnvPath, resolvedOutputPath };
}

export async function runSnapshotCli(argv = process.argv.slice(2)) {
  const [command, envFilePath, outputFilePath, ...extra] = argv;
  if (
    (command !== "snapshot" && command !== "anomalies") ||
    typeof envFilePath !== "string" ||
    typeof outputFilePath !== "string" ||
    extra.length !== 0
  ) {
    fail("usage_snapshot_or_anomalies_envfile_outputfile");
  }
  const { resolvedEnvPath, resolvedOutputPath } = validateCliFileLayout(
    envFilePath,
    outputFilePath,
  );
  const environment = loadSnapshotEnvironment(resolvedEnvPath);
  const snapshot =
    command === "anomalies"
      ? await collectProductionAnomalies({ environment })
      : await collectProductionSnapshot({ environment });
  writeSnapshotFile(resolvedOutputPath, snapshot);
  process.stdout.write(`${JSON.stringify(countOnlySummary(snapshot))}\n`);
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  runSnapshotCli().catch((error) => {
    process.stderr.write(`snapshot_failed:${errorCode(error)}\n`);
    process.exitCode = 1;
  });
}
