import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RemoteMonitorError,
  completeRemoteMonitor,
  monitorResultExitCode,
  planMonitorDispatches,
  preflightRemoteMonitor,
  productionEnvText,
  runDirectory,
  runRemoteMonitor,
  runRemoteMonitorWithTickets,
} from "./remote-monitor.mjs";

const SECRETS = Object.freeze({
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-private-test-key-123456",
  JWT_SECRET: "automation-private-test-token-1234567890",
  VERCEL_TOKEN: "vercel-private-test-token-1234567890",
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-monitor-test-"));
  fs.chmodSync(root, 0o700);
  return root;
}

function snapshot(queue = 0, observedAt = "2026-09-16T12:00:00.000Z", overrides = {}) {
  return {
    schemaVersion: 2,
    mode: "snapshot",
    observedAt,
    supportApi: {
      pendingTicketBatchCount: Math.min(queue, 25),
      expectedPendingTicketBatchCount: Math.min(queue, 25),
      pendingTicketBatchCountMismatch: false,
      batchLimit: 25,
      intentionalStaleRecoveryCheck: true,
      getMayUpdateStaleLocksAndInsertRecoveryLogs: true,
    },
    database: {
      support: { pendingTicketsExactAfterRecovery: queue },
      chat: {
        userLastOver20mAll: 4,
        userLastOver20mLast24h: 0,
        defaultTitleWithMessagesActiveLast24h: 0,
        duplicateEmptyThreadExcessCreatedLast24h: 0,
        orphanMessagesAll: 0,
      },
    },
    ...overrides,
  };
}

function evidence(logCount = 0, historicalLogCount = 0) {
  return {
    driveImpl: async () => ({
      schemaVersion: 1,
      trust: "untrusted_drive_metadata",
      folderId: "16q1toSGCWB0WyI7zH2KAKNzvENL9FfLT",
      observedAt: "2026-09-16T12:00:00.000Z",
      files: [],
    }),
    deploymentImpl: async () => ({
      observedAt: "2026-09-16T12:00:05.000Z",
      mainSha: "a".repeat(40),
      deploymentId: "dpl_testdeployment123",
      ready: true,
    }),
    logsImpl: async ({ deploymentId }) => ({
      observedAt: "2026-09-16T12:00:10.000Z",
      deploymentId,
      logScope: "project_production_split_by_current_deployment",
      queries: {
        fiveXx: { count: logCount, truncated: false },
        levelError: { count: 0, truncated: false },
        timeout: { count: 0, truncated: false },
        gemini: { count: 0, truncated: false },
      },
      historicalQueries: {
        fiveXx: { count: historicalLogCount, truncated: false },
        levelError: { count: 0, truncated: false },
        timeout: { count: 0, truncated: false },
        gemini: { count: 0, truncated: false },
      },
    }),
  };
}

function regularMode(filePath) {
  const stat = fs.lstatSync(filePath);
  assert.ok(stat.isFile());
  assert.equal(stat.isSymbolicLink(), false);
  return stat.mode & 0o777;
}

test("preflight and complete keep secrets private, produce anonymous no-op, and clean up", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const options = {
      secrets: SECRETS,
      tempRoot: root,
      snapshotImpl: async ({ environment }) => {
        calls.push("snapshot");
        assert.equal(environment.automationToken, SECRETS.JWT_SECRET);
        return snapshot(0, calls.length === 1
          ? "2026-09-16T12:00:00.000Z"
          : "2026-09-16T12:01:00.000Z");
      },
      fetchImpl: async () => assert.fail("no extra support GET for empty queue"),
      ...evidence(),
    };
    const beforeUmask = process.umask();
    const preflight = await preflightRemoteMonitor(options);
    assert.equal(preflight.actionRequired, false);
    assert.equal(preflight.contextReady, false);
    assert.deepEqual(preflight.reasonCodes, []);
    const directory = runDirectory(preflight.runId, root);
    assert.equal(fs.lstatSync(directory).mode & 0o777, 0o700);
    for (const name of [
      "production.env", "start-snapshot.json", "drive-intake.json", "deployment-snapshot.json",
      "vercel-log-snapshot.json", "checkpoint.json",
    ]) assert.equal(regularMode(path.join(directory, name)), 0o600);
    assert.ok(!fs.existsSync(path.join(directory, "ticket-context.json")));
    const complete = await completeRemoteMonitor(preflight.runId, options);
    assert.deepEqual(complete.reasonCodes, []);
    assert.equal(complete.actionRequired, false);
    assert.equal(complete.queueStartExact, 0);
    assert.equal(complete.queueFinalExact, 0);
    assert.equal(complete.driveStartCount, 0);
    assert.equal(complete.driveFinalCount, 0);
    assert.deepEqual(calls, ["snapshot", "snapshot"]);
    assert.equal(process.umask(), beforeUmask);
    assert.ok(!fs.existsSync(directory));
    assert.ok(!JSON.stringify(complete).includes(SECRETS.JWT_SECRET));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pending ticket context is 0600, treated as untrusted, and never enters result", async () => {
  const root = tempRoot();
  const customerText = "private customer consultation test text";
  const options = {
    secrets: SECRETS,
    tempRoot: root,
    snapshotImpl: async () => snapshot(1),
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).hostname, "yutakasa-tapping-coach.vercel.app");
      assert.equal(init.headers["x-automation-token"], SECRETS.JWT_SECRET);
      assert.equal(init.redirect, "error");
      return new Response(JSON.stringify({ tickets: [{ id: "ticket-1", body: customerText }] }));
    },
    ...evidence(),
  };
  try {
    const preflight = await preflightRemoteMonitor(options);
    const directory = runDirectory(preflight.runId, root);
    const contextPath = path.join(directory, "ticket-context.json");
    assert.equal(regularMode(contextPath), 0o600);
    const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
    assert.equal(context.trust, "untrusted_customer_input");
    assert.equal(context.tickets[0].body, customerText);
    assert.equal(preflight.contextReady, true);
    assert.deepEqual(preflight.reasonCodes, ["pending_tickets"]);
    assert.ok(!JSON.stringify(preflight).includes(customerText));
    const complete = await completeRemoteMonitor(preflight.runId, options);
    assert.equal(complete.actionRequired, true);
    assert.deepEqual(complete.reasonCodes, ["pending_tickets"]);
    assert.equal(complete.queueStartExact, 1);
    assert.equal(complete.queueFinalExact, 1);
    assert.ok(!JSON.stringify(complete).includes(customerText));
    assert.ok(!fs.existsSync(directory));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled run processes private ticket context before its final snapshot and alerts on uncertainty", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const result = await runRemoteMonitorWithTickets({
      secrets: SECRETS,
      tempRoot: root,
      snapshotImpl: async () => {
        calls.push("snapshot");
        return snapshot(1);
      },
      fetchImpl: async () => new Response(JSON.stringify({ tickets: [{ ticket: {
        id: "2e4710db-9274-4e4c-96c4-59dc97e21c8d",
      } }] })),
      supportImpl: async ({ contextPath, automationToken }) => {
        calls.push("support");
        assert.equal(regularMode(contextPath), 0o600);
        assert.equal(automationToken, SECRETS.JWT_SECRET);
        return { ok: false, examined: 1, lostLocks: 0, uncertain: 1, deferred: 0 };
      },
      ...evidence(),
    });
    assert.deepEqual(calls, ["snapshot", "support", "snapshot"]);
    assert.ok(result.reasonCodes.includes("pending_tickets"));
    assert.ok(result.reasonCodes.includes("support_worker_uncertain"));
    assert.equal(result.actionRequired, true);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("technical and owner-decision handoffs have distinct metadata-only reasons", async () => {
  const root = tempRoot();
  try {
    const result = await runRemoteMonitorWithTickets({
      secrets: SECRETS,
      tempRoot: root,
      snapshotImpl: async () => snapshot(1),
      fetchImpl: async () => new Response(JSON.stringify({ tickets: [{ ticket: {
        id: "2e4710db-9274-4e4c-96c4-59dc97e21c8d",
      } }] })),
      supportImpl: async () => ({
        ok: true, examined: 1, technicalHandoffs: 1, decisionsRequired: 0,
        lostLocks: 0, uncertain: 0, deferred: 0,
      }),
      ...evidence(),
    });
    assert.ok(result.reasonCodes.includes("support_technical_review_required"));
    assert.deepEqual(planMonitorDispatches(result.reasonCodes).repairReasons, []);
    assert.equal(JSON.stringify(result).includes("private customer text"), false);
    const decision = await runRemoteMonitorWithTickets({
      secrets: SECRETS,
      tempRoot: root,
      snapshotImpl: async () => snapshot(1),
      fetchImpl: async () => new Response(JSON.stringify({ tickets: [{ ticket: {
        id: "2e4710db-9274-4e4c-96c4-59dc97e21c8d",
      } }] })),
      supportImpl: async () => ({
        ok: true, examined: 1, technicalHandoffs: 0, decisionsRequired: 1,
        lostLocks: 0, uncertain: 0, deferred: 0,
      }),
      ...evidence(),
    });
    assert.ok(decision.reasonCodes.includes("support_owner_decision_required"));
    assert.deepEqual(planMonitorDispatches(decision.reasonCodes).repairReasons, []);
    const stale = await runRemoteMonitorWithTickets({
      secrets: SECRETS,
      tempRoot: root,
      snapshotImpl: async () => snapshot(1),
      fetchImpl: async () => new Response(JSON.stringify({ tickets: [{ ticket: {
        id: "2e4710db-9274-4e4c-96c4-59dc97e21c8d",
      } }] })),
      supportImpl: async () => ({
        ok: false, examined: 1, technicalHandoffs: 0, decisionsRequired: 0,
        lostLocks: 0, staleContexts: 1, uncertain: 0, deferred: 0,
      }),
      ...evidence(),
    });
    assert.ok(stale.reasonCodes.includes("support_context_stale"));
    assert.equal(stale.reasonCodes.includes("support_worker_nonhealthy"), false);
    assert.deepEqual(planMonitorDispatches(stale.reasonCodes).repairReasons, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ticket and Drive findings alert the owner while technical anomalies also request AI investigation", () => {
  assert.deepEqual(planMonitorDispatches(["pending_tickets", "drive_intake_items"]), {
    alertReasons: ["drive_intake_items", "pending_tickets"],
    repairReasons: [],
  });
  assert.deepEqual(planMonitorDispatches(["pending_tickets", "production_log_timeout"]), {
    alertReasons: ["pending_tickets", "production_log_timeout"],
    repairReasons: ["production_log_timeout"],
  });
  assert.deepEqual(planMonitorDispatches(["historical_production_log_fiveXx"]), {
    alertReasons: ["historical_production_log_fiveXx"],
    repairReasons: [],
  });
});

test("Drive intake metadata triggers action without leaking filenames", async () => {
  const root = tempRoot();
  const secretFilename = "顧客の相談_秘密.pdf";
  try {
    const result = await runRemoteMonitor({
      secrets: SECRETS,
      tempRoot: root,
      snapshotImpl: async () => snapshot(0),
      ...evidence(),
      driveImpl: async () => ({
        schemaVersion: 1,
        trust: "untrusted_drive_metadata",
        folderId: "16q1toSGCWB0WyI7zH2KAKNzvENL9FfLT",
        observedAt: "2026-09-16T12:00:00.000Z",
        files: [{ id: "file-1", name: secretFilename, mimeType: "application/pdf", modifiedTime: "2026-09-16T12:00:00.000Z" }],
      }),
    });
    assert.equal(result.actionRequired, true);
    assert.deepEqual(result.reasonCodes, ["drive_intake_items"]);
    assert.equal(result.driveFinalCount, 1);
    assert.ok(!JSON.stringify(result).includes(secretFilename));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Drive authentication failure prevents a healthy verdict and support GET", async () => {
  const root = tempRoot();
  let detailCalls = 0;
  try {
    await assert.rejects(
      preflightRemoteMonitor({
        secrets: SECRETS,
        tempRoot: root,
        snapshotImpl: async () => snapshot(1),
        fetchImpl: async () => { detailCalls += 1; },
        ...evidence(),
        driveImpl: async () => { throw new Error("private OAuth failure"); },
      }),
      (error) => error instanceof RemoteMonitorError && error.code === "drive_intake_snapshot_failed",
    );
    assert.equal(detailCalls, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("queue mismatch stops before detail GET, deployment, and final snapshot", async () => {
  const root = tempRoot();
  let detailCalls = 0;
  let deploymentCalls = 0;
  try {
    await assert.rejects(
      preflightRemoteMonitor({
        secrets: SECRETS,
        tempRoot: root,
        snapshotImpl: async () => snapshot(1, undefined, {
          supportApi: {
            ...snapshot(1).supportApi,
            pendingTicketBatchCountMismatch: true,
          },
        }),
        fetchImpl: async () => { detailCalls += 1; },
        deploymentImpl: async () => { deploymentCalls += 1; },
      }),
      (error) => error instanceof RemoteMonitorError &&
        error.code === "snapshot_queue_batch_mismatch",
    );
    assert.equal(detailCalls, 0);
    assert.equal(deploymentCalls, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detail API error remains fixed-code and cleans private artifacts", async () => {
  const root = tempRoot();
  try {
    await assert.rejects(
      preflightRemoteMonitor({
        secrets: SECRETS,
        tempRoot: root,
        snapshotImpl: async () => snapshot(1),
        fetchImpl: async () => new Response("private upstream response", { status: 500 }),
        ...evidence(),
      }),
      (error) => error instanceof RemoteMonitorError &&
        error.code === "detail_api_http_failure_possible_recovery_side_effect" &&
        !error.message.includes("private upstream response"),
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final snapshot mismatch fails closed and removes saved context", async () => {
  const root = tempRoot();
  let snapshots = 0;
  const options = {
    secrets: SECRETS,
    tempRoot: root,
    snapshotImpl: async () => {
      snapshots += 1;
      return snapshots === 1
        ? snapshot(0)
        : snapshot(0, "2026-09-16T12:01:00.000Z", {
          supportApi: { ...snapshot(0).supportApi, pendingTicketBatchCount: 1 },
        });
    },
    ...evidence(),
  };
  try {
    const preflight = await preflightRemoteMonitor(options);
    await assert.rejects(
      completeRemoteMonitor(preflight.runId, options),
      (error) => error instanceof RemoteMonitorError &&
        error.code === "snapshot_queue_batch_mismatch",
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nonzero production logs force action; missing secret fails before network", async () => {
  const root = tempRoot();
  try {
    const result = await runRemoteMonitor({
      secrets: SECRETS,
      tempRoot: root,
      snapshotImpl: async () => snapshot(0),
      ...evidence(1),
    });
    assert.equal(result.actionRequired, true);
    assert.deepEqual(result.reasonCodes, ["production_log_fiveXx"]);
    assert.deepEqual(fs.readdirSync(root), []);
    let snapshotCalls = 0;
    await assert.rejects(
      preflightRemoteMonitor({
        secrets: { ...SECRETS, JWT_SECRET: "short" },
        tempRoot: root,
        snapshotImpl: async () => { snapshotCalls += 1; },
      }),
      (error) => error instanceof RemoteMonitorError &&
        error.code === "missing_or_invalid_jwt_secret",
    );
    assert.equal(snapshotCalls, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("old deployment errors alert without requesting AI repair for the current deployment", async () => {
  const root = tempRoot();
  try {
    const result = await runRemoteMonitor({
      secrets: SECRETS, tempRoot: root,
      snapshotImpl: async () => snapshot(0),
      ...evidence(0, 1),
    });
    assert.deepEqual(result.reasonCodes, ["historical_production_log_fiveXx"]);
    assert.equal(result.actionRequired, true);
    assert.deepEqual(planMonitorDispatches(result.reasonCodes).repairReasons, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dotenv text preserves quoted secret characters and rejects newline injection", () => {
  const text = productionEnvText({
    ...SECRETS,
    JWT_SECRET: `secret-with-quote-\"-and-more-than-32-characters`,
  });
  assert.ok(text.includes("JWT_SECRET="));
  assert.ok(!text.includes("\nSUPABASE_SERVICE_ROLE_KEY=malicious\n"));
  assert.throws(
    () => productionEnvText({ ...SECRETS, JWT_SECRET: `${SECRETS.JWT_SECRET}\nMALICIOUS=1` }),
    (error) => error instanceof RemoteMonitorError &&
      error.code === "missing_or_invalid_jwt_secret",
  );
});

test("Railway cron run fails on actionable findings while two-phase preflight can continue", () => {
  const actionable = { ok: true, actionRequired: true };
  assert.equal(monitorResultExitCode(actionable, "run"), 2);
  assert.equal(monitorResultExitCode(actionable, "complete"), 2);
  assert.equal(monitorResultExitCode(actionable, "preflight"), 0);
  assert.equal(monitorResultExitCode({ ok: true, actionRequired: false }, "run"), 0);
});

test("all-time user-last baseline drift requires action without exposing anomaly data", async () => {
  const root = tempRoot();
  try {
    const result = await runRemoteMonitor({
      secrets: SECRETS,
      tempRoot: root,
      snapshotImpl: async () => snapshot(0, "2026-09-16T12:00:00.000Z", {
        database: {
          support: { pendingTicketsExactAfterRecovery: 0 },
          chat: { ...snapshot().database.chat, userLastOver20mAll: 5 },
        },
      }),
      ...evidence(),
    });
    assert.equal(result.actionRequired, true);
    assert.deepEqual(result.reasonCodes, ["all_time_user_last_baseline_changed"]);
    assert.equal(monitorResultExitCode(result, "run"), 2);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
