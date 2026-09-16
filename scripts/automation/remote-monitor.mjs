#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SnapshotError,
  collectProductionSnapshot,
  loadSnapshotEnvironment,
  writeSnapshotFile,
} from "./yutakasa-production-snapshot.mjs";
import { collectRemoteDeployment, collectRemoteLogs } from "./remote-production.mjs";
import { RepairDispatchError, dispatchAlert, dispatchRepair } from "./dispatch-repair.mjs";
import { DRIVE_INTAKE_FOLDER_ID, collectDriveIntakeMetadata } from "./drive-intake.mjs";
import { SupportWorkerError, processSupportTicketContextFile } from "./support-worker.mjs";
import { MonitorLedgerError, acquireMonitorLease } from "./monitor-ledger.mjs";

const RUN_DIRECTORY_PREFIX = "yutakasa-remote-monitor.";
const RUN_FILES = [
  "production.env",
  "start-snapshot.json",
  "ticket-context.json",
  "drive-intake.json",
  "final-drive-intake.json",
  "deployment-snapshot.json",
  "vercel-log-snapshot.json",
  "checkpoint.json",
  "final-snapshot.json",
];
const MAX_DETAIL_BYTES = 8 * 1024 * 1024;
const DETAIL_TIMEOUT_MS = 15_000;
const KNOWN_ALL_TIME_USER_LAST_BASELINE = 4;
const REPAIRABLE_REASON_CODES = new Set([
  "all_time_user_last_baseline_changed",
  "recent_user_last_over_20m",
  "recent_default_title_with_messages",
  "recent_duplicate_empty_threads",
  "orphan_messages",
  "production_log_fiveXx",
  "production_log_levelError",
  "production_log_timeout",
  "production_log_gemini",
]);
const SUPPORT_URL =
  "https://yutakasa-tapping-coach.vercel.app/api/internal/support-automation?limit=25";

export class RemoteMonitorError extends Error {
  constructor(code) {
    super(code);
    this.name = "RemoteMonitorError";
    this.code = code;
  }
}

function fail(code) {
  throw new RemoteMonitorError(code);
}

function assertPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    fail("run_directory_security_invalid");
  }
}

function assertPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    fail("run_file_security_invalid");
  }
}

function writePrivateText(filePath, contents) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } catch {
    fail("private_file_write_failed");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  assertPrivateFile(filePath);
}

function requiredSecret(source, name, minLength) {
  const value = source[name];
  if (typeof value !== "string" || value.length < minLength || /[\r\n]/u.test(value)) {
    fail(`missing_or_invalid_${name.toLowerCase()}`);
  }
  return value;
}

export function productionEnvText(source = process.env) {
  const supabaseUrl = requiredSecret(source, "SUPABASE_URL", 12);
  const serviceRoleKey = requiredSecret(source, "SUPABASE_SERVICE_ROLE_KEY", 20);
  const jwtSecret = source.JWT_SECRET;
  const cronSecret = source.CRON_SECRET;
  if (jwtSecret !== undefined && jwtSecret !== "") {
    requiredSecret(source, "JWT_SECRET", 32);
  } else {
    requiredSecret(source, "CRON_SECRET", 32);
  }
  return [
    `SUPABASE_URL=${JSON.stringify(supabaseUrl)}`,
    `SUPABASE_SERVICE_ROLE_KEY=${JSON.stringify(serviceRoleKey)}`,
    ...(jwtSecret ? [`JWT_SECRET=${JSON.stringify(jwtSecret)}`] : []),
    ...(cronSecret ? [`CRON_SECRET=${JSON.stringify(cronSecret)}`] : []),
    "",
  ].join("\n");
}

function requireCount(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

export function validateRemoteSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 2 || snapshot.mode !== "snapshot") {
    fail("snapshot_schema_invalid");
  }
  const support = snapshot.database?.support;
  const api = snapshot.supportApi;
  const chat = snapshot.database?.chat;
  if (!support || !api || !chat) fail("snapshot_schema_invalid");
  const queue = requireCount(
    support.pendingTicketsExactAfterRecovery,
    "snapshot_queue_invalid",
  );
  const batch = requireCount(api.pendingTicketBatchCount, "snapshot_batch_invalid");
  const expected = Math.min(queue, 25);
  if (
    api.pendingTicketBatchCountMismatch !== false ||
    api.expectedPendingTicketBatchCount !== expected ||
    batch !== expected ||
    api.batchLimit !== 25 ||
    api.intentionalStaleRecoveryCheck !== true ||
    api.getMayUpdateStaleLocksAndInsertRecoveryLogs !== true
  ) {
    fail("snapshot_queue_batch_mismatch");
  }
  for (const key of [
    "userLastOver20mAll",
    "userLastOver20mLast24h",
    "defaultTitleWithMessagesActiveLast24h",
    "duplicateEmptyThreadExcessCreatedLast24h",
    "orphanMessagesAll",
  ]) {
    requireCount(chat[key], `snapshot_metric_invalid_${key}`);
  }
  return { queue, chat };
}

function snapshotReasons(start, final) {
  const reasons = new Set();
  if (start.queue > 0 || final.queue > 0) reasons.add("pending_tickets");
  for (const observed of [start, final]) {
    if (observed.chat.userLastOver20mAll !== KNOWN_ALL_TIME_USER_LAST_BASELINE) {
      reasons.add("all_time_user_last_baseline_changed");
    }
    if (observed.chat.userLastOver20mLast24h > 0) {
      reasons.add("recent_user_last_over_20m");
    }
    if (observed.chat.defaultTitleWithMessagesActiveLast24h > 0) {
      reasons.add("recent_default_title_with_messages");
    }
    if (observed.chat.duplicateEmptyThreadExcessCreatedLast24h > 0) {
      reasons.add("recent_duplicate_empty_threads");
    }
    if (observed.chat.orphanMessagesAll > 0) reasons.add("orphan_messages");
  }
  return [...reasons].sort();
}

function validateDriveIntake(snapshot) {
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.trust !== "untrusted_drive_metadata" ||
    snapshot.folderId !== DRIVE_INTAKE_FOLDER_ID ||
    !Number.isFinite(Date.parse(snapshot.observedAt)) ||
    !Array.isArray(snapshot.files) ||
    snapshot.files.length > 100_000
  ) {
    fail("drive_intake_schema_invalid");
  }
  return snapshot.files.length;
}

async function readLimitedResponse(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_DETAIL_BYTES) {
    fail("detail_response_too_large");
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail("detail_response_invalid");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail("detail_response_invalid");
      length += part.value.byteLength;
      if (length > MAX_DETAIL_BYTES) {
        await reader.cancel().catch(() => {});
        fail("detail_response_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("detail_response_invalid_json");
  }
}

export async function fetchTicketContext({
  automationToken,
  expectedCount,
  fetchImpl = globalThis.fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS);
  try {
    const response = await fetchImpl(SUPPORT_URL, {
      method: "GET",
      headers: { "x-automation-token": automationToken },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) fail("detail_api_http_failure_possible_recovery_side_effect");
    const payload = await readLimitedResponse(response);
    if (!Array.isArray(payload?.tickets)) fail("detail_api_schema_invalid");
    if (payload.tickets.length !== Math.min(expectedCount, 25)) {
      fail("detail_api_queue_mismatch");
    }
    return payload.tickets;
  } catch (error) {
    if (error instanceof RemoteMonitorError) throw error;
    fail("detail_api_failed_possible_recovery_side_effect");
  } finally {
    clearTimeout(timer);
  }
}

function unlinkOwnedFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("run_cleanup_failed");
  }
}

function assertRunId(runId) {
  if (
    typeof runId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(runId)
  ) {
    fail("run_id_invalid");
  }
  return runId;
}

export function runDirectory(runId, tempRoot = os.tmpdir()) {
  assertRunId(runId);
  const resolvedRoot = path.resolve(tempRoot);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("temp_root_invalid");
  return path.join(resolvedRoot, `${RUN_DIRECTORY_PREFIX}${runId}`);
}

function readPrivateJson(filePath, code) {
  assertPrivateFile(filePath);
  const stat = fs.lstatSync(filePath);
  if (stat.size > 8 * 1024 * 1024) fail(`${code}_too_large`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(`${code}_invalid`);
  }
}

export function cleanupRemoteRun(runId, tempRoot = os.tmpdir()) {
  const directory = runDirectory(runId, tempRoot);
  assertPrivateDirectory(directory);
  for (const name of RUN_FILES) unlinkOwnedFile(path.join(directory, name));
  fs.rmdirSync(directory);
}

function checkedProductionEvidence(deployment, logs) {
  if (
    deployment?.ready !== true ||
    typeof deployment.mainSha !== "string" ||
    typeof deployment.deploymentId !== "string" ||
    logs?.deploymentId !== deployment.deploymentId ||
    !logs.queries ||
    typeof logs.queries !== "object"
  ) {
    fail("production_evidence_invalid");
  }
  const counts = {};
  for (const name of ["fiveXx", "levelError", "timeout", "gemini"]) {
    const query = logs.queries[name];
    counts[name] = requireCount(query?.count, `log_${name}_count_invalid`);
    if (query.truncated !== false) fail(`log_${name}_truncated`);
  }
  return counts;
}

function evidenceReasons(logCounts) {
  return Object.entries(logCounts)
    .filter(([, count]) => count > 0)
    .map(([name]) => `production_log_${name}`)
    .sort();
}

export async function preflightRemoteMonitor({
  secrets = process.env,
  tempRoot = os.tmpdir(),
  snapshotImpl = collectProductionSnapshot,
  fetchImpl = globalThis.fetch,
  deploymentImpl = collectRemoteDeployment,
  logsImpl = collectRemoteLogs,
  driveImpl = collectDriveIntakeMetadata,
  leaseGuard = async () => {},
} = {}) {
  const oldUmask = process.umask(0o077);
  const runId = crypto.randomUUID();
  let directory;
  let directoryCreated = false;
  let succeeded = false;
  try {
    directory = runDirectory(runId, tempRoot);
    fs.mkdirSync(directory, { mode: 0o700 });
    directoryCreated = true;
    assertPrivateDirectory(directory);
    const envPath = path.join(directory, "production.env");
    writePrivateText(envPath, productionEnvText(secrets));
    const environment = loadSnapshotEnvironment(envPath);

    await leaseGuard();
    const startSnapshot = await snapshotImpl({ environment });
    const start = validateRemoteSnapshot(startSnapshot);
    const startPath = path.join(directory, "start-snapshot.json");
    writeSnapshotFile(startPath, startSnapshot);
    assertPrivateFile(startPath);

    let drive;
    try {
      await leaseGuard();
      drive = await driveImpl({ credentials: secrets });
    } catch (error) {
      if (error instanceof MonitorLedgerError) throw error;
      fail("drive_intake_snapshot_failed");
    }
    const driveCount = validateDriveIntake(drive);
    const drivePath = path.join(directory, "drive-intake.json");
    writeSnapshotFile(drivePath, drive);
    assertPrivateFile(drivePath);

    if (start.queue > 0) {
      await leaseGuard();
      const tickets = await fetchTicketContext({
        automationToken: environment.automationToken,
        expectedCount: start.queue,
        fetchImpl,
      });
      const contextPath = path.join(directory, "ticket-context.json");
      writeSnapshotFile(contextPath, {
        schemaVersion: 1,
        trust: "untrusted_customer_input",
        obtainedAt: new Date().toISOString(),
        tickets,
      });
      assertPrivateFile(contextPath);
    }

    let deployment;
    try {
      await leaseGuard();
      deployment = await deploymentImpl({ token: secrets.VERCEL_TOKEN });
    } catch (error) {
      if (error instanceof MonitorLedgerError) throw error;
      fail("deployment_snapshot_failed");
    }
    let logs;
    try {
      await leaseGuard();
      logs = await logsImpl({
        deploymentId: deployment.deploymentId,
        token: secrets.VERCEL_TOKEN,
      });
    } catch (error) {
      if (error instanceof MonitorLedgerError) throw error;
      fail("vercel_log_snapshot_failed");
    }
    const logCounts = checkedProductionEvidence(deployment, logs);
    const deploymentPath = path.join(directory, "deployment-snapshot.json");
    const logPath = path.join(directory, "vercel-log-snapshot.json");
    writeSnapshotFile(deploymentPath, deployment);
    writeSnapshotFile(logPath, logs);
    assertPrivateFile(deploymentPath);
    assertPrivateFile(logPath);

    const checkpointPath = path.join(directory, "checkpoint.json");
    writeSnapshotFile(checkpointPath, {
      schemaVersion: 1,
      runId,
      startObservedAt: startSnapshot.observedAt,
      deploymentId: deployment.deploymentId,
      mainSha: deployment.mainSha,
      logCounts,
    });
    assertPrivateFile(checkpointPath);
    const reasonCodes = [
      ...new Set([...snapshotReasons(start, start), ...evidenceReasons(logCounts)]),
    ].sort();
    if (driveCount > 0) reasonCodes.push("drive_intake_items");
    reasonCodes.sort();
    succeeded = true;
    return {
      ok: true,
      runId,
      actionRequired: reasonCodes.length > 0,
      reasonCodes,
      queueStartExact: start.queue,
      driveStartCount: driveCount,
      contextReady: start.queue > 0,
      deploymentId: deployment.deploymentId,
    };
  } finally {
    process.umask(oldUmask);
    if (!succeeded && directoryCreated) cleanupRemoteRun(runId, tempRoot);
  }
}

export async function completeRemoteMonitor(runId, {
  tempRoot = os.tmpdir(),
  snapshotImpl = collectProductionSnapshot,
  secrets = process.env,
  driveImpl = collectDriveIntakeMetadata,
  leaseGuard = async () => {},
} = {}) {
  const oldUmask = process.umask(0o077);
  let directory;
  let directoryVerified = false;
  try {
    directory = runDirectory(runId, tempRoot);
    assertPrivateDirectory(directory);
    directoryVerified = true;
    const checkpoint = readPrivateJson(path.join(directory, "checkpoint.json"), "checkpoint");
    if (checkpoint?.schemaVersion !== 1 || checkpoint.runId !== runId) {
      fail("checkpoint_schema_invalid");
    }
    const startSnapshot = readPrivateJson(
      path.join(directory, "start-snapshot.json"),
      "start_snapshot",
    );
    const start = validateRemoteSnapshot(startSnapshot);
    const startDrive = readPrivateJson(path.join(directory, "drive-intake.json"), "drive_intake");
    const driveStartCount = validateDriveIntake(startDrive);
    const deployment = readPrivateJson(
      path.join(directory, "deployment-snapshot.json"),
      "deployment_snapshot",
    );
    const logs = readPrivateJson(
      path.join(directory, "vercel-log-snapshot.json"),
      "vercel_log_snapshot",
    );
    const logCounts = checkedProductionEvidence(deployment, logs);
    if (
      checkpoint.startObservedAt !== startSnapshot.observedAt ||
      checkpoint.deploymentId !== deployment.deploymentId ||
      checkpoint.mainSha !== deployment.mainSha ||
      JSON.stringify(checkpoint.logCounts) !== JSON.stringify(logCounts)
    ) {
      fail("checkpoint_evidence_mismatch");
    }
    const environment = loadSnapshotEnvironment(path.join(directory, "production.env"));
    await leaseGuard();
    const finalSnapshot = await snapshotImpl({ environment });
    const final = validateRemoteSnapshot(finalSnapshot);
    const finalPath = path.join(directory, "final-snapshot.json");
    writeSnapshotFile(finalPath, finalSnapshot);
    assertPrivateFile(finalPath);
    let finalDrive;
    try {
      await leaseGuard();
      finalDrive = await driveImpl({ credentials: secrets });
    } catch (error) {
      if (error instanceof MonitorLedgerError) throw error;
      fail("final_drive_intake_snapshot_failed");
    }
    const driveFinalCount = validateDriveIntake(finalDrive);
    const finalDrivePath = path.join(directory, "final-drive-intake.json");
    writeSnapshotFile(finalDrivePath, finalDrive);
    assertPrivateFile(finalDrivePath);
    if (
      !Number.isFinite(Date.parse(finalSnapshot.observedAt)) ||
      Date.parse(finalSnapshot.observedAt) < Date.parse(startSnapshot.observedAt)
    ) {
      fail("snapshot_observation_order_invalid");
    }
    const reasonCodes = [
      ...new Set([...snapshotReasons(start, final), ...evidenceReasons(logCounts)]),
    ].sort();
    if (driveStartCount > 0 || driveFinalCount > 0) reasonCodes.push("drive_intake_items");
    reasonCodes.sort();
    return {
      ok: true,
      actionRequired: reasonCodes.length > 0,
      reasonCodes,
      queueStartExact: start.queue,
      queueFinalExact: final.queue,
      driveStartCount,
      driveFinalCount,
      deploymentId: deployment.deploymentId,
    };
  } finally {
    process.umask(oldUmask);
    if (directoryVerified) cleanupRemoteRun(runId, tempRoot);
  }
}

export async function runRemoteMonitor(options = {}) {
  const preflight = await preflightRemoteMonitor(options);
  return completeRemoteMonitor(preflight.runId, options);
}

export async function runRemoteMonitorWithTickets(options = {}) {
  const preflight = await preflightRemoteMonitor(options);
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const secrets = options.secrets ?? process.env;
  try {
    let support;
    if (preflight.contextReady) {
      const automationToken = secrets.JWT_SECRET || secrets.CRON_SECRET;
      support = await (options.supportImpl ?? processSupportTicketContextFile)({
        contextPath: path.join(runDirectory(preflight.runId, tempRoot), "ticket-context.json"),
        automationToken,
        fetchImpl: options.supportFetchImpl ?? globalThis.fetch,
        beforeMutation: options.leaseGuard ?? (async () => {}),
      });
    }
    const result = await completeRemoteMonitor(preflight.runId, options);
    if (support) {
      result.support = support;
      if (support.technicalHandoffs > 0) result.reasonCodes.push("support_technical_review_required");
      if (support.decisionsRequired > 0) result.reasonCodes.push("support_owner_decision_required");
      if (support.lostLocks > 0) result.reasonCodes.push("support_lock_lost");
      if (support.uncertain > 0) result.reasonCodes.push("support_worker_uncertain");
      if (support.deferred > 0) result.reasonCodes.push("support_deferred");
      if (support.ok === false &&
        support.lostLocks === 0 && support.uncertain === 0 && support.deferred === 0) {
        result.reasonCodes.push("support_worker_nonhealthy");
      }
      result.reasonCodes = [...new Set(result.reasonCodes)].sort();
      result.actionRequired = result.reasonCodes.length > 0;
    }
    return result;
  } catch (error) {
    const directory = runDirectory(preflight.runId, tempRoot);
    if (fs.existsSync(directory)) cleanupRemoteRun(preflight.runId, tempRoot);
    throw error;
  }
}

function safeErrorCode(error) {
  if (error instanceof RemoteMonitorError || error instanceof SnapshotError || error instanceof RepairDispatchError || error instanceof SupportWorkerError || error instanceof MonitorLedgerError) {
    return error.code;
  }
  return "remote_monitor_unexpected_failure";
}

export function monitorResultExitCode(result, phase) {
  return phase === "preflight" || !result.actionRequired ? 0 : 2;
}

export function planMonitorDispatches(reasonCodes) {
  if (!Array.isArray(reasonCodes) || reasonCodes.length === 0) {
    return { alertReasons: [], repairReasons: [] };
  }
  return {
    alertReasons: [...new Set(reasonCodes)].sort(),
    repairReasons: [...new Set(reasonCodes.filter((code) => REPAIRABLE_REASON_CODES.has(code)))].sort(),
  };
}

export async function runLeasedMonitor({
  secrets = process.env,
  leaseImpl = acquireMonitorLease,
  monitorImpl = runRemoteMonitorWithTickets,
  alertImpl = dispatchAlert,
  repairImpl = dispatchRepair,
  ...options
} = {}) {
  const lease = await leaseImpl({ secrets, kind: "scheduled" });
  let result;
  let observationError;
  try {
    result = await monitorImpl({ ...options, secrets, leaseGuard: () => lease.assertActive() });
    await lease.finish({
      ...result,
      status: result.actionRequired ? "action_required" : "healthy",
      alertDispatched: false,
      repairDispatched: false,
    });
  } catch (error) {
    observationError = error;
    const code = safeErrorCode(error);
    try {
      await lease.finish({
        ...(result ?? {}),
        status: "failed",
        reasonCodes: [code],
        errorCode: code,
        alertDispatched: false,
        repairDispatched: false,
      });
    } catch {
      // A lost lease must never be treated as a successful observation.
    }
  } finally {
    await lease.stop();
  }

  // Dispatch only after the monitor lease is released. The GitHub recheck
  // acquires the same lease before its own support snapshot.
  if (observationError) {
    try {
      await alertImpl({
        token: secrets.GITHUB_DISPATCH_TOKEN,
        reasonCodes: [safeErrorCode(observationError)],
        deploymentId: result?.deploymentId ?? "unknown",
      });
      await lease.recordDispatch({ alertDispatched: true });
    } catch {
      // Railway also retains the failed cron result if the alert is unavailable.
    }
    throw observationError;
  }

  let alertDispatched = false;
  let repairDispatched = false;
  if (result.actionRequired) {
    const { alertReasons, repairReasons } = planMonitorDispatches(result.reasonCodes);
    await alertImpl({
      token: secrets.GITHUB_DISPATCH_TOKEN,
      reasonCodes: alertReasons,
      deploymentId: result.deploymentId,
    });
    alertDispatched = true;
    await lease.recordDispatch({ alertDispatched });
    if (repairReasons.length > 0) {
      await repairImpl({
        token: secrets.GITHUB_DISPATCH_TOKEN,
        reasonCodes: repairReasons,
        deploymentId: result.deploymentId,
      });
      repairDispatched = true;
      await lease.recordDispatch({ repairDispatched });
    }
  }
  return { ...result, alertDispatched, repairDispatched };
}

export async function runRemoteMonitorCli(argv = process.argv.slice(2)) {
  let result;
  if (argv.length === 2 && argv[0] === "cleanup-run") {
    cleanupRemoteRun(argv[1]);
    result = { ok: true, runCleaned: true };
  } else if (argv.length === 2 && argv[0] === "context-path") {
    const directory = runDirectory(argv[1]);
    assertPrivateDirectory(directory);
    const contextPath = path.join(directory, "ticket-context.json");
    assertPrivateFile(contextPath);
    result = { ok: true, contextPath };
  } else if (argv.length === 0 || (argv.length === 1 && argv[0] === "run")) {
    result = await runLeasedMonitor();
  } else {
    fail("usage_remote_monitor");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = monitorResultExitCode(result, "run");
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runRemoteMonitorCli().catch(async (error) => {
    const reasonCode = safeErrorCode(error);
    process.stdout.write(`${JSON.stringify({
      ok: false,
      actionRequired: true,
      reasonCodes: [reasonCode],
    })}\n`);
    process.exitCode = 1;
  });
}
