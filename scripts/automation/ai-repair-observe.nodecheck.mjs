import assert from "node:assert/strict";
import test from "node:test";

import { AiRepairObserveError, evaluateRepairObservation, runRepairObservation } from "./ai-repair-observe.mjs";

const NOW = "2026-09-16T20:00:00.000Z";
const SCHEDULE_ENV = { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "123456" };
const SHA = "a".repeat(40);
const DEPLOYMENT = "dpl_Abcdefghijklmnop";
const release = { pr_number: 42, status: "observing", merge_sha: SHA,
  merge_recorded_at: NOW };
const deployment = { observedAt: NOW, mainSha: SHA, deploymentId: DEPLOYMENT, ready: true };
const logs = {
  observedAt: NOW, deploymentId: DEPLOYMENT,
  logScope: "deployment_post_merge", since: NOW,
  queries: Object.fromEntries(["fiveXx", "levelError", "timeout", "gemini"].map((name) => [name, { count: 0, truncated: false }])),
};
const snapshot = {
  schemaVersion: 2, mode: "snapshot", observedAt: NOW,
  supportApi: {
    pendingTicketBatchCount: 0, expectedPendingTicketBatchCount: 0,
    pendingTicketBatchCountMismatch: false, batchLimit: 25,
    intentionalStaleRecoveryCheck: true,
    getMayUpdateStaleLocksAndInsertRecoveryLogs: true,
  },
  database: {
    support: { pendingTicketsExactAfterRecovery: 0 },
    chat: {
      userLastOver20mAll: 4, userLastOver20mLast24h: 0,
      defaultTitleWithMessagesActiveLast24h: 0,
      duplicateEmptyThreadExcessCreatedLast24h: 0,
      orphanMessagesAll: 0,
    },
  },
};
const functionalEvidence = {
  schemaVersion: 1, observedAt: NOW, mergeSha: SHA, deploymentId: DEPLOYMENT,
  desktopBrowser: true, mobileBrowser: true, streamComplete: true,
  databaseSaved: true, reloadPersisted: true, testDataCleaned: true,
  clientErrors: 0,
};

test("observation requires exact production SHA, bounded zero logs, DB parity, and fresh evidence", () => {
  const input = { release, deployment, logs, snapshot, functionalEvidence, observedAt: NOW };
  assert.deepEqual(evaluateRepairObservation(input), { healthy: true, code: null, deploymentId: DEPLOYMENT });
  assert.equal(evaluateRepairObservation({ ...input, functionalEvidence: null }).code, "functional_smoke_missing");
  assert.equal(evaluateRepairObservation({ ...input, deployment: { ...deployment, mainSha: "b".repeat(40) } }).code, "main_sha_changed");
  assert.equal(evaluateRepairObservation({ ...input, logs: { ...logs, queries: { ...logs.queries, fiveXx: { count: 1, truncated: false } } } }).code, "production_logs_not_clear");
  assert.equal(evaluateRepairObservation({ ...input, snapshot: { ...snapshot, database: { ...snapshot.database, chat: { ...snapshot.database.chat, orphanMessagesAll: 1 } } } }).code, "production_db_anomaly_present");
  assert.throws(() => evaluateRepairObservation({ ...input, logs: { ...logs, queries: { ...logs.queries, fiveXx: { count: 100, truncated: true } } } }), AiRepairObserveError);
  assert.throws(() => evaluateRepairObservation({ ...input, observedAt: "2026-09-16T20:07:00.000Z" }), AiRepairObserveError);
});

test("probe failure records an unhealthy observation instead of preserving a healthy streak", async () => {
  const calls = [];
  await assert.rejects(() => runRepairObservation({
    env: { ...SCHEDULE_ENV, SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.includes("yutakasa_repair_releases?")) return new Response(JSON.stringify([{
        ...release, head_sha: "c".repeat(40), created_at: NOW,
      }]));
      if (url.includes("record_yutakasa_repair_observation")) {
        return new Response(JSON.stringify([{ status: "observing", healthy_count: 0 }]));
      }
      throw new Error("unexpected");
    },
    deploymentImpl: async () => { throw new Error("provider unavailable"); },
  }), (error) => error instanceof AiRepairObserveError && error.code === "repair_observation_failed");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.p_healthy, false);
  assert.equal(calls[1].body.p_error_code, "production_probe_failed");
  assert.equal(calls[1].body.p_deployment_id, null);
});

test("a merge acknowledged by GitHub recovers a failed ledger update before observation", async () => {
  const calls = [];
  await assert.rejects(() => runRepairObservation({
    env: {
      ...SCHEDULE_ENV,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32),
      GITHUB_TOKEN: "g".repeat(32),
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (url.includes("yutakasa_repair_releases?") && options.method === "GET") {
        return new Response(JSON.stringify([{
          pr_number: 42, head_sha: "c".repeat(40), merge_sha: null,
          status: "pending_merge", created_at: NOW,
        }]));
      }
      if (url.includes("api.github.com") && options.method === "GET") {
        return new Response(JSON.stringify({
          number: 42, head: { sha: "c".repeat(40), repo: { full_name: "sanrinawakes/yutakasa-tapping-coach" } },
          merged: true, merge_commit_sha: SHA, merged_at: NOW,
        }));
      }
      if (url.includes("yutakasa_repair_releases?") && options.method === "PATCH") {
        return new Response(JSON.stringify([{ pr_number: 42, merge_sha: SHA, status: "observing" }]));
      }
      if (url.includes("record_yutakasa_repair_observation")) {
        return new Response(JSON.stringify([{ status: "observing", healthy_count: 0 }]));
      }
      throw new Error("unexpected");
    },
    deploymentImpl: async () => { throw new Error("provider unavailable"); },
  }), AiRepairObserveError);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "PATCH", "POST"]);
  assert.equal(calls[2].body.merge_sha, SHA);
});

test("a closed unmerged PR leaves the pending observer queue", async () => {
  const calls = [];
  await assert.rejects(() => runRepairObservation({
    env: { ...SCHEDULE_ENV, SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32), GITHUB_TOKEN: "g".repeat(32) },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (url.includes("yutakasa_repair_releases?") && options.method === "GET") {
        return new Response(JSON.stringify([{
          pr_number: 42, head_sha: "c".repeat(40), merge_sha: null,
          status: "pending_merge", created_at: NOW,
        }]));
      }
      if (url.includes("api.github.com")) return new Response(JSON.stringify({
        number: 42, head: { sha: "c".repeat(40), repo: { full_name: "sanrinawakes/yutakasa-tapping-coach" } },
        merged: false, state: "closed",
      }));
      if (url.includes("yutakasa_repair_releases?") && options.method === "PATCH") {
        return new Response(JSON.stringify([{ status: "abandoned" }]));
      }
      throw new Error("unexpected");
    },
    deploymentImpl: async () => { throw new Error("must not query production"); },
  }), (error) => error instanceof AiRepairObserveError &&
    error.code === "pending_release_abandoned");
  assert.equal(calls[2].body.status, "abandoned");
});

test("no observing release avoids production and provider calls", async () => {
  let calls = 0;
  const result = await runRepairObservation({
    env: { ...SCHEDULE_ENV, SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) },
    fetchImpl: async () => { calls += 1; return new Response("[]", { status: 200 }); },
    deploymentImpl: async () => { throw new Error("unexpected"); },
    logsImpl: async () => { throw new Error("unexpected"); },
    snapshotImpl: async () => { throw new Error("unexpected"); },
  });
  assert.deepEqual(result, { examined: 0, verified: 0, failed: 0 });
  assert.equal(calls, 1);
});

test("scheduled cleanup still runs after a failed release leaves the observation queue", async () => {
  let cleanupCalls = 0;
  let databaseCalls = 0;
  const result = await runRepairObservation({
    env: { ...SCHEDULE_ENV, SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32),
      AI_REPAIR_FUNCTIONAL_SMOKE_ENABLED: "true" },
    fetchImpl: async () => { databaseCalls += 1; return new Response("[]"); },
    staleCleanupImpl: async () => { cleanupCalls += 1; },
    deploymentImpl: async () => { throw new Error("no release must avoid deployment"); },
  });
  assert.deepEqual(result, { examined: 0, verified: 0, failed: 0 });
  assert.equal(cleanupCalls, 1);
  assert.equal(databaseCalls, 1);
});

test("manual dispatch cannot certify a scheduled production observation", async () => {
  let calls = 0;
  await assert.rejects(() => runRepairObservation({
    env: { ...SCHEDULE_ENV, GITHUB_EVENT_NAME: "workflow_dispatch" },
    fetchImpl: async () => { calls += 1; throw new Error("must not read"); },
  }), (error) => error instanceof AiRepairObserveError &&
    error.code === "repair_observation_not_scheduled");
  assert.equal(calls, 0);
});

test("browser smoke stays disabled until the audited production switch is set", async () => {
  const timestamp = new Date().toISOString();
  let receipt = null;
  await assert.rejects(() => runRepairObservation({
    env: { ...SCHEDULE_ENV, SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) },
    fetchImpl: async (url, options) => {
      if (url.includes("yutakasa_repair_releases?")) {
        return new Response(JSON.stringify([{ ...release, merge_recorded_at: timestamp }]));
      }
      receipt = JSON.parse(options.body);
      return new Response(JSON.stringify([{ status: "observing", healthy_count: 0 }]));
    },
    deploymentImpl: async () => ({ ...deployment, observedAt: timestamp }),
    logsImpl: async () => ({ ...logs, observedAt: timestamp, since: timestamp }),
    snapshotImpl: async () => ({ ...snapshot, observedAt: timestamp }),
  }), AiRepairObserveError);
  assert.equal(receipt.p_healthy, false);
  assert.equal(receipt.p_error_code, "functional_smoke_missing");
});

test("production alias movement during browser smoke fails before log or DB health verdict", async () => {
  let deploymentCalls = 0;
  let receipt = null;
  await assert.rejects(() => runRepairObservation({
    env: { ...SCHEDULE_ENV, SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) },
    fetchImpl: async (url, options) => {
      if (url.includes("yutakasa_repair_releases?")) {
        return new Response(JSON.stringify([release]));
      }
      receipt = JSON.parse(options.body);
      return new Response(JSON.stringify([{ status: "failed", healthy_count: 0 }]));
    },
    deploymentImpl: async () => (++deploymentCalls === 1) ? deployment :
      { ...deployment, mainSha: "b".repeat(40), deploymentId: "dpl_Changed123456789" },
    functionalSmokeImpl: async () => functionalEvidence,
    logsImpl: async () => { throw new Error("logs must not certify changed production"); },
    snapshotImpl: async () => { throw new Error("snapshot must not certify changed production"); },
  }), AiRepairObserveError);
  assert.equal(deploymentCalls, 2);
  assert.equal(receipt.p_healthy, false);
  assert.equal(receipt.p_error_code, "production_changed_during_smoke");
});

test("production alias movement after log and DB probes cannot verify a release", async () => {
  let deploymentCalls = 0;
  let receipt = null;
  await assert.rejects(() => runRepairObservation({
    env: { ...SCHEDULE_ENV, SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) },
    fetchImpl: async (url, options) => {
      if (url.includes("yutakasa_repair_releases?")) return new Response(JSON.stringify([release]));
      receipt = JSON.parse(options.body);
      return new Response(JSON.stringify([{ status: "failed", healthy_count: 0 }]));
    },
    deploymentImpl: async () => (++deploymentCalls < 3) ? deployment :
      { ...deployment, deploymentId: "dpl_Changed123456789" },
    functionalSmokeImpl: async () => functionalEvidence,
    logsImpl: async () => logs,
    snapshotImpl: async () => snapshot,
  }), AiRepairObserveError);
  assert.equal(deploymentCalls, 3);
  assert.equal(receipt.p_healthy, false);
  assert.equal(receipt.p_error_code, "production_changed_during_observation");
});

test("six superseded releases are terminalized without starving the newest or oldest", async () => {
  const states = new Map(Array.from({ length: 6 }, (_, index) => [index + 1, "observing"]));
  const observed = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("yutakasa_repair_releases?")) {
      assert.match(url, /order=pr_number\.desc&limit=5/u);
      return new Response(JSON.stringify([...states]
        .filter(([, status]) => status === "observing")
        .sort((a, b) => b[0] - a[0]).slice(0, 5)
        .map(([pr_number]) => ({ pr_number, status: "observing",
          merge_sha: "b".repeat(40), head_sha: "c".repeat(40),
          created_at: NOW, merge_recorded_at: NOW }))));
    }
    const body = JSON.parse(options.body);
    observed.push(body.p_pr_number);
    states.set(body.p_pr_number, "failed");
    return new Response(JSON.stringify([{ status: "failed", healthy_count: 0 }]));
  };
  for (let run = 0; run < 2; run += 1) {
    await assert.rejects(() => runRepairObservation({
      env: { ...SCHEDULE_ENV, SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) },
      fetchImpl,
      deploymentImpl: async () => deployment,
      snapshotImpl: async () => snapshot,
      logsImpl: async () => { throw new Error("logs are irrelevant after a newer main SHA"); },
    }), AiRepairObserveError);
  }
  assert.deepEqual(observed, [6, 5, 4, 3, 2, 1]);
});
