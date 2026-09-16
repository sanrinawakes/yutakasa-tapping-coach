import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SnapshotError,
  aggregateSupportQueueMetrics,
  collectProductionAnomalies,
  collectProductionSnapshot,
  countOnlySummary,
  diceSimilarityBasisPoints,
  fetchReadOnlyJson,
  loadSnapshotEnvironment,
  parseDotEnv,
  validateCliFileLayout,
  validateSupabaseSchema,
  writeSnapshotFile,
} from "./yutakasa-production-snapshot.mjs";

const NOW_MS = Date.parse("2026-08-28T10:30:00.000Z");
const ENVIRONMENT = Object.freeze({
  supabaseUrl: "https://project.supabase.co",
  supabaseServiceRoleKey: "service-role-secret-that-must-never-be-printed",
  automationToken: "automation-secret-that-must-never-be-printed-123456",
  jwtSecret: "jwt-hmac-secret-that-must-never-be-printed-123456789",
});

function iso(minutesBeforeNow) {
  return new Date(NOW_MS - minutesBeforeNow * 60_000).toISOString();
}

function openApiDocument(overrides = {}) {
  const definitions = {
    chat_threads: {
      properties: {
        id: {},
        user_email: {},
        title: {},
        created_at: {},
      },
    },
    chat_messages: {
      properties: { id: {}, thread_id: {}, role: {}, content: {}, created_at: {} },
    },
    otp_codes: { properties: { id: {}, used: {}, created_at: {} } },
    support_tickets: {
      properties: {
        id: {},
        status: {},
        automation_status: {},
        decision_required: {},
        automation_locked_at: {},
      },
    },
    support_messages: { properties: { id: {} } },
    support_attachments: { properties: { id: {} } },
    support_work_logs: { properties: { id: {} } },
    ...overrides,
  };
  return { swagger: "2.0", definitions };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch({
  threads = [],
  messages = [],
  supportTickets = [],
  pendingTickets = [],
  counts = {},
  schema = openApiDocument(),
  inspect,
} = {}) {
  const defaults = {
    support_tickets: 0,
    support_messages: 0,
    support_attachments: 0,
    support_work_logs: 0,
    otp_codes: 0,
    "otp_codes:used:eq.true": 0,
    "otp_codes:used:eq.false": 0,
    "otp_codes:used:is.null": 0,
  };
  const exactCounts = { ...defaults, ...counts };
  return async (input, init = {}) => {
    const url = new URL(String(input));
    inspect?.(url, init);
    assert.ok(init.signal instanceof AbortSignal, "every request has a finite timeout signal");
    assert.ok(["GET", "HEAD"].includes(init.method), "only read-only HTTP methods are used");
    assert.equal(init.redirect, "error", "redirects are rejected before credentials can move");

    if (url.pathname === "/api/internal/support-automation") {
      return jsonResponse({ tickets: pendingTickets });
    }
    if (url.pathname === "/rest/v1/") return jsonResponse(schema);

    const table = decodeURIComponent(url.pathname.split("/").at(-1));
    if (init.method === "HEAD") {
      const filter = url.searchParams.get("used");
      const key = filter ? `${table}:used:${filter}` : table;
      const count = exactCounts[key];
      assert.notEqual(count, undefined, `unexpected exact count request: ${key}`);
      return new Response(null, {
        status: 200,
        headers: { "content-range": count === 0 ? "*/0" : `0-0/${count}` },
      });
    }

    const rows =
      table === "chat_threads"
        ? threads
        : table === "chat_messages"
          ? messages
          : supportTickets;
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return jsonResponse(rows.slice(offset, offset + limit));
  };
}

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "yutakasa-snapshot-test-"));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("normal snapshot reports exact all-time and last-24h metrics separately", async () => {
  const threads = [
    {
      id: "thread-1",
      user_email: "person@example.invalid",
      title: "  新しいチャット  ",
      created_at: iso(60),
    },
    {
      id: "thread-2",
      user_email: "duplicate@example.invalid",
      title: "メモ",
      created_at: iso(1_500),
    },
    {
      id: "thread-3",
      user_email: "duplicate@example.invalid",
      title: "メモ2",
      created_at: iso(10),
    },
    {
      id: "thread-4",
      user_email: "old@example.invalid",
      title: "古い会話",
      created_at: iso(3_000),
    },
  ];
  const messages = [
    { id: "m1", thread_id: "thread-1", role: "assistant", created_at: iso(40) },
    { id: "m2", thread_id: "thread-1", role: "user", created_at: iso(30) },
    { id: "m3", thread_id: "thread-4", role: "user", created_at: iso(2_000) },
  ];
  const supportTickets = [
    {
      id: "ticket-1",
      status: "open",
      automation_status: "queued",
      decision_required: false,
      automation_locked_at: null,
    },
    {
      id: "ticket-2",
      status: "resolved",
      automation_status: "completed",
      decision_required: false,
      automation_locked_at: null,
    },
    {
      id: "ticket-3",
      status: "open",
      automation_status: "blocked_decision",
      decision_required: true,
      automation_locked_at: null,
    },
    {
      id: "ticket-4",
      status: "in_progress",
      automation_status: "investigating",
      decision_required: false,
      automation_locked_at: iso(5),
    },
  ];
  const snapshot = await collectProductionSnapshot({
    environment: ENVIRONMENT,
    fetchImpl: mockFetch({
      threads,
      messages,
      supportTickets,
      pendingTickets: [{ private: "must-not-escape" }],
      counts: {
        support_messages: 7,
        support_attachments: 2,
        support_work_logs: 9,
        otp_codes: 5,
        "otp_codes:used:eq.true": 3,
        "otp_codes:used:eq.false": 2,
        "otp_codes:used:is.null": 0,
      },
    }),
    nowMs: NOW_MS,
  });

  assert.equal(snapshot.supportApi.pendingTicketBatchCount, 1);
  assert.equal(snapshot.supportApi.expectedPendingTicketBatchCount, 1);
  assert.equal(snapshot.supportApi.pendingTicketBatchCountMismatch, false);
  assert.equal(snapshot.supportApi.intentionalStaleRecoveryCheck, true);
  assert.equal(
    snapshot.supportApi.getMayUpdateStaleLocksAndInsertRecoveryLogs,
    true,
  );
  assert.deepEqual(snapshot.database.support, {
    tickets: 4,
    messages: 7,
    attachments: 2,
    workLogs: 9,
    staleRecoveryCandidatesBeforeGet: 0,
    pendingTicketsExactAfterRecovery: 1,
  });
  assert.deepEqual(snapshot.database.otp, {
    total: 5,
    used: 3,
    unused: 2,
    nullUsed: 0,
  });
  assert.equal(snapshot.database.chat.userLastOver20mAll, 2);
  assert.equal(snapshot.database.chat.userLastOver20mLast24h, 1);
  assert.equal(snapshot.database.chat.defaultTitleWithMessagesAll, 1);
  assert.equal(snapshot.database.chat.emptyThreadsAll, 2);
  assert.equal(snapshot.database.chat.duplicateEmptyThreadGroupsAll, 1);
  assert.equal(snapshot.database.chat.duplicateEmptyThreadExcessAll, 1);
  assert.equal(snapshot.database.chat.duplicateEmptyThreadExcessCreatedLast24h, 1);
  assert.equal(snapshot.database.chat.roleDeltaUserMinusAssistantAll, 1);
  assert.equal(snapshot.database.chat.roleDeltaUserMinusAssistantLast24h, 0);
});

test("dotenv parser removes Vercel quotes and preserves values without printing them", () => {
  const directory = tempDirectory();
  const envPath = path.join(directory, "production.env");
  const jwt = "jwt-secret-with-padding-and-more-than-32-characters==";
  const service = "service-role-with-padding-and-more-than-20-characters==";
  try {
    fs.writeFileSync(
      envPath,
      [
        'SUPABASE_URL="https://quoted.supabase.co"',
        `SUPABASE_SERVICE_ROLE_KEY="${service}"`,
        `export JWT_SECRET='${jwt}'`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const parsed = loadSnapshotEnvironment(envPath);
    assert.equal(parsed.supabaseUrl, "https://quoted.supabase.co");
    assert.equal(parsed.supabaseServiceRoleKey, service);
    assert.equal(parsed.automationToken, jwt);
    assert.equal(parsed.jwtSecret, jwt);
    assert.ok(!parsed.automationToken.startsWith("'") && !parsed.automationToken.endsWith("'"));
    assert.ok(!parsed.supabaseServiceRoleKey.startsWith('"'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("chat tables are paged in deterministic batches of 1000 until complete", async () => {
  const threads = Array.from({ length: 1_001 }, (_, index) => ({
    id: `thread-${String(index).padStart(4, "0")}`,
    user_email: `person-${index}@example.invalid`,
    title: "題名",
    created_at: iso(5),
  }));
  const messages = Array.from({ length: 1_001 }, (_, index) => ({
    id: `message-${String(index).padStart(4, "0")}`,
    thread_id: threads[index].id,
    role: index % 2 === 0 ? "user" : "assistant",
    created_at: iso(5),
  }));
  const pageOffsets = { chat_threads: [], chat_messages: [] };
  const snapshot = await collectProductionSnapshot({
    environment: ENVIRONMENT,
    fetchImpl: mockFetch({
      threads,
      messages,
      inspect(url, init) {
        if (init.method !== "GET" || !url.searchParams.has("offset")) return;
        const table = url.pathname.split("/").at(-1);
        pageOffsets[table]?.push(Number(url.searchParams.get("offset")));
      },
    }),
    nowMs: NOW_MS,
  });
  assert.deepEqual(pageOffsets.chat_threads, [0, 1_000]);
  assert.deepEqual(pageOffsets.chat_messages, [0, 1_000]);
  assert.equal(snapshot.database.chat.threadsTotal, 1_001);
  assert.equal(snapshot.database.chat.messagesTotal, 1_001);
});

test("OpenAPI schema mismatch fails closed before database table reads", async () => {
  const schema = openApiDocument({
    chat_messages: { properties: { id: {}, thread_id: {}, created_at: {} } },
  });
  let tableReads = 0;
  let supportCalls = 0;
  await assert.rejects(
    collectProductionSnapshot({
      environment: ENVIRONMENT,
      fetchImpl: mockFetch({
        schema,
        inspect(url) {
          if (url.pathname === "/api/internal/support-automation") supportCalls += 1;
          if (url.pathname.startsWith("/rest/v1/") && url.pathname !== "/rest/v1/") {
            tableReads += 1;
          }
        },
      }),
      nowMs: NOW_MS,
    }),
    (error) =>
      error instanceof SnapshotError &&
      error.code === "supabase_schema_missing_column_chat_messages_role",
  );
  assert.equal(tableReads, 0);
  assert.equal(supportCalls, 0);
});

test("all schema reads, database reads, and aggregation finish before support GET", async () => {
  const calls = [];
  const snapshot = await collectProductionSnapshot({
    environment: ENVIRONMENT,
    fetchImpl: mockFetch({
      inspect(url, init) {
        calls.push(
          url.pathname === "/api/internal/support-automation"
            ? "support"
            : `${init.method}:${url.pathname}`,
        );
      },
    }),
    nowMs: NOW_MS,
  });
  assert.equal(calls.at(-1), "support");
  assert.equal(calls.filter((call) => call === "support").length, 1);
  assert.equal(snapshot.supportApi.intentionalStaleRecoveryCheck, true);
});

test("database failure prevents the side-effecting support GET", async () => {
  let supportCalls = 0;
  const baseFetch = mockFetch();
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/internal/support-automation") supportCalls += 1;
    if (url.pathname === "/rest/v1/chat_threads" && init.method === "GET") {
      return jsonResponse({ error: "private database failure" }, 500);
    }
    return baseFetch(input, init);
  };
  await assert.rejects(
    collectProductionSnapshot({ environment: ENVIRONMENT, fetchImpl, nowMs: NOW_MS }),
    (error) =>
      error instanceof SnapshotError &&
      error.code === "supabase_page_chat_threads_http_500",
  );
  assert.equal(supportCalls, 0);
});

test("support queue recovery exactly matches the route's strict 30-minute boundary", () => {
  const row = (id, status, automationStatus, decisionRequired, lockedAt) => ({
    id,
    status,
    automation_status: automationStatus,
    decision_required: decisionRequired,
    automation_locked_at: lockedAt,
  });
  const metrics = aggregateSupportQueueMetrics(
    [
      row("queued", "open", "queued", false, null),
      row("failed", "in_progress", "failed", false, null),
      row("null-lock", "open", "investigating", false, null),
      row("older", "open", "investigating", false, new Date(NOW_MS - 1_800_001).toISOString()),
      row("boundary", "open", "investigating", false, new Date(NOW_MS - 1_800_000).toISOString()),
      row("fresh", "open", "investigating", false, new Date(NOW_MS - 1_799_999).toISOString()),
      row("decision", "open", "investigating", true, null),
      row("resolved", "resolved", "investigating", false, null),
    ],
    NOW_MS,
  );
  assert.deepEqual(metrics, {
    staleRecoveryCandidates: 2,
    pendingTicketsExactAfterRecovery: 4,
  });
});

test("support tickets page past 1000 and exact pending count is not truncated at 25", async () => {
  const supportTickets = Array.from({ length: 1_001 }, (_, index) => ({
    id: `ticket-${index}`,
    status: "open",
    automation_status: "queued",
    decision_required: false,
    automation_locked_at: null,
  }));
  const pendingTickets = Array.from({ length: 25 }, (_, index) => ({ id: index }));
  const supportOffsets = [];
  const snapshot = await collectProductionSnapshot({
    environment: ENVIRONMENT,
    fetchImpl: mockFetch({
      supportTickets,
      pendingTickets,
      inspect(url, init) {
        if (url.pathname === "/rest/v1/support_tickets" && init.method === "GET") {
          supportOffsets.push(Number(url.searchParams.get("offset")));
        }
      },
    }),
    nowMs: NOW_MS,
  });
  assert.deepEqual(supportOffsets, [0, 1_000]);
  assert.equal(snapshot.database.support.pendingTicketsExactAfterRecovery, 1_001);
  assert.equal(snapshot.supportApi.pendingTicketBatchCount, 25);
  assert.equal(snapshot.supportApi.expectedPendingTicketBatchCount, 25);
  assert.equal(snapshot.supportApi.pendingTicketBatchCountMismatch, false);
});

test("HTTP failures expose only a fixed status code and never response PII", async () => {
  const responsePii = "customer@example.invalid private complaint secret-token";
  let supportReached = false;
  const baseFetch = mockFetch();
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/internal/support-automation") {
      supportReached = true;
      assert.equal(init.redirect, "error");
      return jsonResponse({ error: responsePii }, 401);
    }
    return baseFetch(input, init);
  };
  let caught;
  try {
    await collectProductionSnapshot({
      environment: ENVIRONMENT,
      fetchImpl,
      nowMs: NOW_MS,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SnapshotError);
  assert.equal(caught.code, "support_api_failed_possible_recovery_side_effect");
  assert.equal(supportReached, true);
  assert.ok(!String(caught).includes(responsePii));
  assert.ok(!String(caught).includes(ENVIRONMENT.automationToken));
});

test("request timeout remains finite when fetch itself ignores abort", async () => {
  const neverSettles = () => new Promise(() => {});
  const startedAt = Date.now();
  await assert.rejects(
    collectProductionSnapshot({
      environment: ENVIRONMENT,
      fetchImpl: neverSettles,
      nowMs: NOW_MS,
      requestTimeoutMs: 20,
      overallTimeoutMs: 50,
    }),
    (error) => error instanceof SnapshotError && error.code === "supabase_schema_timeout",
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("JSON response body consumption shares the same finite request deadline", async () => {
  const hangingBodyFetch = async (_input, init) => {
    assert.equal(init.redirect, "error");
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        pull: () => new Promise(() => {}),
      }),
    };
  };
  const startedAt = Date.now();
  await assert.rejects(
    fetchReadOnlyJson(hangingBodyFetch, "https://example.invalid/read", {
      label: "hanging_body",
      requestTimeoutMs: 20,
      overallTimeoutMs: 50,
    }),
    (error) => error instanceof SnapshotError && error.code === "hanging_body_timeout",
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("JSON body rejects an oversized Content-Length before consuming its stream", async () => {
  const privateBody = "private-response-body-must-not-escape";
  let pullCount = 0;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(64 * 1024 * 1024 + 1) }),
    body: new ReadableStream({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new TextEncoder().encode(privateBody));
        controller.close();
      },
    }),
  });
  let caught;
  try {
    await fetchReadOnlyJson(fetchImpl, "https://example.invalid/oversized", {
      label: "oversized_header",
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SnapshotError);
  assert.equal(caught.code, "oversized_header_response_too_large");
  assert.ok(!String(caught).includes(privateBody));
  assert.ok(pullCount <= 1, "the helper never advances beyond stream prefetch");
});

test("JSON body stream without Content-Length is stopped after the 64 MiB cap", async () => {
  const oneMiB = new Uint8Array(1024 * 1024);
  let emittedChunks = 0;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      pull(controller) {
        emittedChunks += 1;
        controller.enqueue(oneMiB);
        if (emittedChunks >= 65) controller.close();
      },
    }),
  });
  await assert.rejects(
    fetchReadOnlyJson(fetchImpl, "https://example.invalid/stream-too-large", {
      label: "oversized_stream",
      requestTimeoutMs: 2_000,
      overallTimeoutMs: 3_000,
    }),
    (error) =>
      error instanceof SnapshotError &&
      error.code === "oversized_stream_response_too_large",
  );
  assert.equal(emittedChunks, 65);
});

test("native fetch rejects a cross-origin redirect before credential forwarding", async () => {
  let sourceRequestCount = 0;
  let targetRequestCount = 0;
  let targetHeaders = null;
  const target = http.createServer((request, response) => {
    targetRequestCount += 1;
    targetHeaders = request.headers;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const source = http.createServer((_request, response) => {
    sourceRequestCount += 1;
    response.writeHead(302, {
      location: `http://127.0.0.1:${target.address().port}/target`,
    });
    response.end();
  });
  try {
    const targetAddress = await listen(target);
    assert.ok(targetAddress.port > 0);
    const sourceAddress = await listen(source);
    await assert.rejects(
      fetchReadOnlyJson(
        globalThis.fetch,
        `http://127.0.0.1:${sourceAddress.port}/source`,
        {
          label: "redirect_guard",
          headers: {
            "x-automation-token": ENVIRONMENT.automationToken,
            apikey: ENVIRONMENT.supabaseServiceRoleKey,
          },
          requestTimeoutMs: 5_000,
          overallTimeoutMs: 6_000,
        },
      ),
      (error) =>
        error instanceof SnapshotError && error.code === "redirect_guard_network_failure",
    );
    assert.equal(sourceRequestCount, 1);
    assert.equal(targetRequestCount, 0);
    assert.equal(targetHeaders, null);
  } finally {
    await closeServer(source);
    await closeServer(target);
  }
});

test("overall timeout is hard-capped at the monitor's 60-second command limit", async () => {
  await assert.rejects(
    collectProductionSnapshot({
      environment: ENVIRONMENT,
      fetchImpl: mockFetch(),
      nowMs: NOW_MS,
      overallTimeoutMs: 60_001,
    }),
    (error) =>
      error instanceof SnapshotError &&
      error.code === "snapshot_invalid_overall_timeout",
  );
});

test("snapshot and stdout summary contain counts but no IDs, text, email, or secrets", async () => {
  const markers = [
    "private-thread-id",
    "private-message-id",
    "private-user@example.invalid",
    "private-title-marker",
    "private-ticket-body-marker",
    ENVIRONMENT.supabaseServiceRoleKey,
    ENVIRONMENT.automationToken,
    ENVIRONMENT.jwtSecret,
  ];
  const snapshot = await collectProductionSnapshot({
    environment: ENVIRONMENT,
    fetchImpl: mockFetch({
      threads: [
        {
          id: markers[0],
          user_email: markers[2],
          title: markers[3],
          created_at: iso(10),
        },
      ],
      messages: [
        { id: markers[1], thread_id: markers[0], role: "user", created_at: iso(10) },
      ],
      pendingTickets: [{ body: markers[4], user_email: markers[2] }],
    }),
    nowMs: NOW_MS,
  });
  const serializedSnapshot = JSON.stringify(snapshot);
  const stdout = JSON.stringify(countOnlySummary(snapshot));
  assert.equal(snapshot.supportApi.pendingTicketBatchCountMismatch, true);
  for (const marker of markers) {
    assert.ok(!serializedSnapshot.includes(marker));
    assert.ok(!stdout.includes(marker));
  }
  assert.ok(Object.values(countOnlySummary(snapshot)).every(Number.isSafeInteger));
});

test("anomalies mode classifies four anonymous user-last candidates as 3 missing and 1 answered elsewhere", async () => {
  const threads = [
    ["candidate-answered", "same-person@example.invalid", "private title one"],
    ["answered-other-thread", "same-person@example.invalid", "private title two"],
    ["candidate-missing-1", "missing-one@example.invalid", "private title three"],
    ["candidate-missing-2", "missing-two@example.invalid", "private title four"],
    ["candidate-missing-3", "missing-three@example.invalid", "private title five"],
  ].map(([id, user_email, title]) => ({ id, user_email, title, created_at: iso(300) }));
  const messages = [
    {
      id: "private-message-a1",
      thread_id: "candidate-answered",
      role: "user",
      content: "ログイン用の認証メールが届かないので確認してください",
      created_at: iso(70),
    },
    {
      id: "private-message-a2",
      thread_id: "answered-other-thread",
      role: "user",
      content: "ログイン用認証メールが届かないので、確認してください！",
      created_at: iso(65),
    },
    {
      id: "private-message-a3",
      thread_id: "answered-other-thread",
      role: "assistant",
      content: "private assistant reply",
      created_at: iso(60),
    },
    {
      id: "private-message-m1",
      thread_id: "candidate-missing-1",
      role: "user",
      content: "今週の振り返りを保存できませんでした",
      created_at: iso(100),
    },
    {
      id: "private-message-m2a",
      thread_id: "candidate-missing-2",
      role: "assistant",
      content: "private earlier answer",
      created_at: iso(150),
    },
    {
      id: "private-message-m2b",
      thread_id: "candidate-missing-2",
      role: "user",
      content: "別の技術的な質問が未回答です",
      created_at: iso(90),
    },
    {
      id: "private-message-m3",
      thread_id: "candidate-missing-3",
      role: "user",
      content: "履歴の題名が更新されない状態です",
      created_at: iso(80),
    },
  ];
  let standardMessageSelect = "";
  let anomalyMessageSelect = "";
  await collectProductionSnapshot({
    environment: ENVIRONMENT,
    fetchImpl: mockFetch({
      threads,
      messages,
      inspect(url) {
        if (url.pathname === "/rest/v1/chat_messages") {
          standardMessageSelect = url.searchParams.get("select") ?? "";
        }
      },
    }),
    nowMs: NOW_MS,
  });
  const snapshot = await collectProductionAnomalies({
    environment: ENVIRONMENT,
    fetchImpl: mockFetch({
      threads,
      messages,
      inspect(url) {
        if (url.pathname === "/rest/v1/chat_messages") {
          anomalyMessageSelect = url.searchParams.get("select") ?? "";
        }
      },
    }),
    nowMs: NOW_MS,
  });
  assert.ok(!standardMessageSelect.includes("content"));
  assert.ok(anomalyMessageSelect.includes("content"));
  assert.equal(snapshot.mode, "anomalies");
  assert.equal(snapshot.anomalies.candidateCount, 4);
  assert.equal(snapshot.anomalies.missingAssistantCount, 3);
  assert.equal(snapshot.anomalies.answeredElsewhereCount, 1);
  assert.equal(snapshot.anomalies.nearDuplicateCandidateCount, 1);
  const answered = snapshot.anomalies.candidates.find(
    (candidate) => candidate.classification === "answered_elsewhere",
  );
  assert.equal(answered.nearDuplicateFollowedByAssistant, true);
  assert.equal(answered.candidateFingerprint.length, 24);
  assert.equal(answered.nearDuplicateThreadFingerprint.length, 24);
  assert.ok(answered.nearDuplicateSimilarityBasisPoints >= 8_500);
  assert.match(answered.lastUserAt, /^2026-08-28T/u);

  const forbidden = [
    ...threads.flatMap((thread) => [thread.id, thread.user_email, thread.title]),
    ...messages.flatMap((message) => [message.id, message.content]),
    ENVIRONMENT.jwtSecret,
    ENVIRONMENT.automationToken,
    ENVIRONMENT.supabaseServiceRoleKey,
  ];
  const serialized = JSON.stringify(snapshot);
  const stdout = JSON.stringify(countOnlySummary(snapshot));
  for (const marker of forbidden) {
    assert.ok(!serialized.includes(marker));
    assert.ok(!stdout.includes(marker));
  }
  assert.ok(Object.values(countOnlySummary(snapshot)).every(Number.isSafeInteger));
});

test("normalized bigram Dice rule is deterministic and rejects generic short text", () => {
  assert.equal(
    diceSimilarityBasisPoints(
      "ログイン用の認証メールが届きません",
      "ログイン用の認証メールが届きません！",
    ),
    10_000,
  );
  assert.equal(diceSimilarityBasisPoints("短い質問", "短い質問"), 0);
  assert.ok(
    diceSimilarityBasisPoints(
      "ログイン用の認証メールが届きません",
      "ログイン用認証メールが届きません",
    ) >= 8_500,
  );
});

test("snapshot output is a new regular 0600 file", () => {
  const directory = tempDirectory();
  const outputPath = path.join(directory, "snapshot.json");
  const snapshot = {
    schemaVersion: 1,
    observedAt: new Date(NOW_MS).toISOString(),
    windows: { recentHours: 24, userLastGraceMinutes: 20 },
    supportApi: { pendingTickets: 0 },
    database: {
      support: { tickets: 0, messages: 0, attachments: 0, workLogs: 0 },
      otp: { total: 0, used: 0, unused: 0, nullUsed: 0 },
      chat: {},
    },
  };
  try {
    writeSnapshotFile(outputPath, snapshot);
    const stats = fs.lstatSync(outputPath);
    assert.equal(stats.isFile(), true);
    assert.equal(stats.isSymbolicLink(), false);
    assert.equal(stats.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), snapshot);
    assert.throws(
      () => writeSnapshotFile(outputPath, snapshot),
      (error) => error instanceof SnapshotError && error.code === "output_write_failed",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI requires separate env and output files in one 0700 run directory", () => {
  const directory = tempDirectory();
  const otherDirectory = tempDirectory();
  fs.chmodSync(directory, 0o700);
  fs.chmodSync(otherDirectory, 0o700);
  const envPath = path.join(directory, "production.env");
  const outputPath = path.join(directory, "snapshot.json");
  try {
    assert.deepEqual(validateCliFileLayout(envPath, outputPath), {
      resolvedEnvPath: envPath,
      resolvedOutputPath: outputPath,
    });
    assert.throws(
      () => validateCliFileLayout(envPath, envPath),
      (error) => error instanceof SnapshotError && error.code === "cli_files_must_differ",
    );
    assert.throws(
      () => validateCliFileLayout(envPath, path.join(otherDirectory, "snapshot.json")),
      (error) =>
        error instanceof SnapshotError && error.code === "cli_files_must_share_parent",
    );
    fs.writeFileSync(outputPath, "existing", { mode: 0o600 });
    assert.throws(
      () => validateCliFileLayout(envPath, outputPath),
      (error) =>
        error instanceof SnapshotError && error.code === "cli_output_must_be_new",
    );
    fs.unlinkSync(outputPath);
    fs.chmodSync(directory, 0o755);
    assert.throws(
      () => validateCliFileLayout(envPath, outputPath),
      (error) =>
        error instanceof SnapshotError &&
        error.code === "cli_parent_must_be_0700_directory",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(otherDirectory, { recursive: true, force: true });
  }
});

test("OpenAPI validator accepts components.schemas and rejects absent tables", () => {
  const definitions = openApiDocument().definitions;
  assert.equal(validateSupabaseSchema({ components: { schemas: definitions } }), true);
  const missing = { ...definitions };
  delete missing.otp_codes;
  assert.throws(
    () => validateSupabaseSchema({ definitions: missing }),
    (error) =>
      error instanceof SnapshotError &&
      error.code === "supabase_schema_missing_table_otp_codes",
  );
  const missingSupportLock = openApiDocument({
    support_tickets: {
      properties: {
        id: {},
        status: {},
        automation_status: {},
        decision_required: {},
      },
    },
  });
  assert.throws(
    () => validateSupabaseSchema(missingSupportLock),
    (error) =>
      error instanceof SnapshotError &&
      error.code ===
        "supabase_schema_missing_column_support_tickets_automation_locked_at",
  );
  const missingContent = openApiDocument({
    chat_messages: { properties: { id: {}, thread_id: {}, role: {}, created_at: {} } },
  });
  assert.throws(
    () => validateSupabaseSchema(missingContent, { includeMessageContent: true }),
    (error) =>
      error instanceof SnapshotError &&
      error.code === "supabase_schema_missing_column_chat_messages_content",
  );
});

test("dotenv parser rejects malformed quoted input without echoing its value", () => {
  const secret = "do-not-echo-this-secret";
  let caught;
  try {
    parseDotEnv(`JWT_SECRET="${secret}`);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SnapshotError);
  assert.equal(caught.code, "env_parse_failed");
  assert.ok(!String(caught).includes(secret));
});
