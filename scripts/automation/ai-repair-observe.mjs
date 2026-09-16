#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectRemoteDeployment, collectRemoteLogs } from "./remote-production.mjs";
import { collectProductionSnapshot } from "./yutakasa-production-snapshot.mjs";
import { validateRemoteSnapshot } from "./remote-monitor.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const DEPLOYMENT = /^dpl_[A-Za-z0-9]{8,160}$/u;

export class AiRepairObserveError extends Error {
  constructor(code) {
    super(code);
    this.name = "AiRepairObserveError";
    this.code = code;
  }
}

function fail(code) {
  throw new AiRepairObserveError(code);
}

export function evaluateRepairObservation({ release, deployment, logs, snapshot, observedAt = new Date().toISOString() }) {
  if (
    !Number.isSafeInteger(release?.pr_number) || release.pr_number < 1 ||
    release?.status !== "observing" || !SHA.test(release?.merge_sha ?? "") ||
    !Number.isFinite(Date.parse(observedAt)) ||
    deployment?.ready !== true || !DEPLOYMENT.test(deployment?.deploymentId ?? "") ||
    !SHA.test(deployment?.mainSha ?? "") ||
    logs?.deploymentId !== deployment.deploymentId
  ) fail("repair_observation_evidence_invalid");
  const snapshotSummary = validateRemoteSnapshot(snapshot);
  for (const stamp of [deployment.observedAt, logs.observedAt, snapshot.observedAt]) {
    const time = Date.parse(stamp);
    if (!Number.isFinite(time) || Math.abs(Date.parse(observedAt) - time) > 5 * 60 * 1000) {
      fail("repair_observation_stale_evidence");
    }
  }
  if (deployment.mainSha !== release.merge_sha) {
    return { healthy: false, code: "main_sha_changed", deploymentId: deployment.deploymentId };
  }
  const queries = logs.queries;
  if (!queries || Object.keys(queries).sort().join(",") !== "fiveXx,gemini,levelError,timeout") {
    fail("repair_log_evidence_invalid");
  }
  for (const query of Object.values(queries)) {
    if (!Number.isSafeInteger(query?.count) || query.count < 0 || query?.truncated !== false) {
      fail("repair_log_evidence_invalid");
    }
    if (query.count > 0) {
      return { healthy: false, code: "production_logs_not_clear", deploymentId: deployment.deploymentId };
    }
  }
  const chat = snapshotSummary.chat;
  if (
    chat.userLastOver20mAll !== 4 ||
    chat.userLastOver20mLast24h !== 0 ||
    chat.defaultTitleWithMessagesActiveLast24h !== 0 ||
    chat.duplicateEmptyThreadExcessCreatedLast24h !== 0 ||
    chat.orphanMessagesAll !== 0
  ) {
    return { healthy: false, code: "production_db_anomaly_present", deploymentId: deployment.deploymentId };
  }
  return { healthy: true, code: null, deploymentId: deployment.deploymentId };
}

async function supabaseRequest(env, fetchImpl, pathSuffix, body) {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof base !== "string" || !/^https:\/\/[^/]+$/u.test(base) ||
      typeof key !== "string" || key.length < 20) fail("repair_observe_configuration_invalid");
  const response = await fetchImpl(`${base}${pathSuffix}`, {
    method: body ? "POST" : "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("repair_observe_db_request_failed"));
  if (response.status !== 200) fail(`repair_observe_db_http_${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 64 * 1024) fail("repair_observe_db_response_too_large");
  try { return JSON.parse(text); } catch { fail("repair_observe_db_response_invalid"); }
}

export async function runRepairObservation({
  env = process.env,
  fetchImpl = globalThis.fetch,
  deploymentImpl = collectRemoteDeployment,
  logsImpl = collectRemoteLogs,
  snapshotImpl = collectProductionSnapshot,
} = {}) {
  const releases = await supabaseRequest(
    env, fetchImpl,
    "/rest/v1/yutakasa_repair_releases?status=eq.observing&select=pr_number,merge_sha,status&order=pr_number.asc&limit=5",
    null,
  );
  if (!Array.isArray(releases) || releases.length > 5) fail("repair_observe_release_rows_invalid");
  if (releases.length === 0) return { examined: 0, verified: 0, failed: 0 };
  const environment = {
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    automationToken: env.CRON_SECRET,
  };
  const deployment = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  const logs = await logsImpl({ deploymentId: deployment.deploymentId, token: env.VERCEL_TOKEN });
  const snapshot = await snapshotImpl({ environment, fetchImpl });
  const summary = { examined: 0, verified: 0, failed: 0 };
  for (const release of releases) {
    const observedAt = new Date().toISOString();
    const observation = evaluateRepairObservation({ release, deployment, logs, snapshot, observedAt });
    const result = await supabaseRequest(env, fetchImpl, "/rest/v1/rpc/record_yutakasa_repair_observation", {
      p_pr_number: release.pr_number,
      p_merge_sha: release.merge_sha,
      p_deployment_id: observation.deploymentId,
      p_observed_at: observedAt,
      p_healthy: observation.healthy,
      p_error_code: observation.code,
    });
    if (!Array.isArray(result) || result.length !== 1 ||
        !["observing", "verified", "failed"].includes(result[0]?.status) ||
        !Number.isSafeInteger(result[0]?.healthy_count)) fail("repair_observe_receipt_invalid");
    summary.examined += 1;
    if (result[0].status === "verified") summary.verified += 1;
    if (result[0].status === "failed") summary.failed += 1;
  }
  if (summary.failed > 0) fail("repair_observation_failed");
  return summary;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runRepairObservation().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof AiRepairObserveError ? error.code : "repair_observe_failed" })}\n`);
      process.exitCode = 1;
    },
  );
}
