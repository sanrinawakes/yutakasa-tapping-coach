import assert from "node:assert/strict";
import test from "node:test";

import { AiRepairObserveError, evaluateRepairObservation, runRepairObservation } from "./ai-repair-observe.mjs";

const NOW = "2026-09-16T20:00:00.000Z";
const SHA = "a".repeat(40);
const DEPLOYMENT = "dpl_Abcdefghijklmnop";
const release = { pr_number: 42, status: "observing", merge_sha: SHA };
const deployment = { observedAt: NOW, mainSha: SHA, deploymentId: DEPLOYMENT, ready: true };
const logs = {
  observedAt: NOW, deploymentId: DEPLOYMENT,
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

test("observation requires exact production SHA, bounded zero logs, DB parity, and fresh evidence", () => {
  const input = { release, deployment, logs, snapshot, observedAt: NOW };
  assert.deepEqual(evaluateRepairObservation(input), { healthy: true, code: null, deploymentId: DEPLOYMENT });
  assert.equal(evaluateRepairObservation({ ...input, deployment: { ...deployment, mainSha: "b".repeat(40) } }).code, "main_sha_changed");
  assert.equal(evaluateRepairObservation({ ...input, logs: { ...logs, queries: { ...logs.queries, fiveXx: { count: 1, truncated: false } } } }).code, "production_logs_not_clear");
  assert.equal(evaluateRepairObservation({ ...input, snapshot: { ...snapshot, database: { ...snapshot.database, chat: { ...snapshot.database.chat, orphanMessagesAll: 1 } } } }).code, "production_db_anomaly_present");
  assert.throws(() => evaluateRepairObservation({ ...input, logs: { ...logs, queries: { ...logs.queries, fiveXx: { count: 100, truncated: true } } } }), AiRepairObserveError);
  assert.throws(() => evaluateRepairObservation({ ...input, observedAt: "2026-09-16T20:07:00.000Z" }), AiRepairObserveError);
});

test("no observing release avoids production and provider calls", async () => {
  let calls = 0;
  const result = await runRepairObservation({
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) },
    fetchImpl: async () => { calls += 1; return new Response("[]", { status: 200 }); },
    deploymentImpl: async () => { throw new Error("unexpected"); },
    logsImpl: async () => { throw new Error("unexpected"); },
    snapshotImpl: async () => { throw new Error("unexpected"); },
  });
  assert.deepEqual(result, { examined: 0, verified: 0, failed: 0 });
  assert.equal(calls, 1);
});
