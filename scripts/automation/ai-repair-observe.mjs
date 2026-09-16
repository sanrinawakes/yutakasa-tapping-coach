#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectRemoteDeployment, collectRemoteLogs } from "./remote-production.mjs";
import { collectProductionSnapshot } from "./yutakasa-production-snapshot.mjs";
import { validateRemoteSnapshot } from "./remote-monitor.mjs";
import { reapStaleSyntheticIdentities, runProductionFunctionalSmoke } from "./ai-repair-functional-smoke.mjs";

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

export function evaluateRepairObservation({ release, deployment, logs, snapshot, functionalEvidence, observedAt = new Date().toISOString() }) {
  if (
    !Number.isSafeInteger(release?.pr_number) || release.pr_number < 1 ||
    release?.status !== "observing" || !SHA.test(release?.merge_sha ?? "") ||
    !Number.isFinite(Date.parse(release?.merge_recorded_at ?? "")) ||
    !Number.isFinite(Date.parse(observedAt)) ||
    deployment?.ready !== true || !DEPLOYMENT.test(deployment?.deploymentId ?? "") ||
    !SHA.test(deployment?.mainSha ?? "") ||
    logs?.deploymentId !== deployment.deploymentId ||
    logs?.logScope !== "deployment_post_merge" ||
    logs?.since !== release.merge_recorded_at
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
  if (
    functionalEvidence?.schemaVersion !== 1 ||
    functionalEvidence?.mergeSha !== release.merge_sha ||
    functionalEvidence?.deploymentId !== deployment.deploymentId ||
    functionalEvidence?.desktopBrowser !== true ||
    functionalEvidence?.mobileBrowser !== true ||
    functionalEvidence?.streamComplete !== true ||
    functionalEvidence?.databaseSaved !== true ||
    functionalEvidence?.reloadPersisted !== true ||
    functionalEvidence?.testDataCleaned !== true ||
    functionalEvidence?.clientErrors !== 0 ||
    !Number.isFinite(Date.parse(functionalEvidence?.observedAt)) ||
    Math.abs(Date.parse(observedAt) - Date.parse(functionalEvidence.observedAt)) > 5 * 60 * 1000
  ) {
    return { healthy: false, code: "functional_smoke_missing", deploymentId: deployment.deploymentId };
  }
  return { healthy: true, code: null, deploymentId: deployment.deploymentId };
}

async function supabaseRequest(env, fetchImpl, pathSuffix, body, method = body ? "POST" : "GET") {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof base !== "string" || !/^https:\/\/[^/]+$/u.test(base) ||
      typeof key !== "string" || key.length < 20) fail("repair_observe_configuration_invalid");
  const response = await fetchImpl(`${base}${pathSuffix}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body ? { "content-type": "application/json", Prefer: "return=representation" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("repair_observe_db_request_failed"));
  if (![200, 201].includes(response.status)) fail(`repair_observe_db_http_${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 64 * 1024) fail("repair_observe_db_response_too_large");
  try { return JSON.parse(text); } catch { fail("repair_observe_db_response_invalid"); }
}

async function reconcilePendingRelease(env, fetchImpl, release) {
  if (!Number.isSafeInteger(release?.pr_number) || release.pr_number < 1 ||
      !SHA.test(release?.head_sha ?? "") || release?.status !== "pending_merge" ||
      release?.merge_sha !== null) fail("pending_release_invalid");
  const token = env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length < 20) fail("github_read_credential_missing");
  const response = await fetchImpl(
    `https://api.github.com/repos/sanrinawakes/yutakasa-tapping-coach/pulls/${release.pr_number}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => fail("pending_release_github_failed"));
  if (response.status !== 200) fail("pending_release_github_failed");
  const text = await response.text();
  if (Buffer.byteLength(text) > 128 * 1024) fail("pending_release_github_response_large");
  let pr;
  try { pr = JSON.parse(text); } catch { fail("pending_release_github_invalid"); }
  if (pr?.number !== release.pr_number || pr?.head?.sha !== release.head_sha ||
      pr?.head?.repo?.full_name !== "sanrinawakes/yutakasa-tapping-coach") {
    fail("pending_release_pr_mismatch");
  }
  if (pr.merged !== true) {
    const created = Date.parse(release.created_at);
    if (!Number.isFinite(created)) fail("pending_release_unresolved");
    if (pr.state === "open" && Date.now() - created <= 30 * 60 * 1000) {
      return null;
    }
    const abandoned = await supabaseRequest(
      env, fetchImpl,
      `/rest/v1/yutakasa_repair_releases?pr_number=eq.${release.pr_number}&head_sha=eq.${release.head_sha}&status=eq.pending_merge`,
      { status: "abandoned", error_code: "pending_merge_abandoned" }, "PATCH",
    );
    if (!Array.isArray(abandoned) || abandoned.length !== 1 ||
        abandoned[0]?.status !== "abandoned") fail("pending_release_abandon_unconfirmed");
    return { status: "abandoned" };
  }
  if (!SHA.test(pr.merge_commit_sha ?? "")) fail("pending_release_merge_sha_invalid");
  const rows = await supabaseRequest(
    env, fetchImpl,
    `/rest/v1/yutakasa_repair_releases?pr_number=eq.${release.pr_number}&head_sha=eq.${release.head_sha}&status=eq.pending_merge`,
    { merge_sha: pr.merge_commit_sha, status: "observing", merge_recorded_at: pr.merged_at },
    "PATCH",
  );
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.merge_sha !== pr.merge_commit_sha ||
      rows[0]?.status !== "observing") fail("pending_release_reconcile_unconfirmed");
  return { pr_number: release.pr_number, merge_sha: pr.merge_commit_sha,
    merge_recorded_at: pr.merged_at, status: "observing" };
}

export async function runRepairObservation({
  env = process.env,
  fetchImpl = globalThis.fetch,
  deploymentImpl = collectRemoteDeployment,
  logsImpl = collectRemoteLogs,
  snapshotImpl = collectProductionSnapshot,
  functionalSmokeImpl = async (args) => args.env.AI_REPAIR_FUNCTIONAL_SMOKE_ENABLED === "true"
    ? runProductionFunctionalSmoke(args) : null,
  staleCleanupImpl = reapStaleSyntheticIdentities,
} = {}) {
  if (env.GITHUB_EVENT_NAME !== "schedule" ||
      typeof env.GITHUB_RUN_ID !== "string" ||
      !/^[1-9][0-9]{0,17}$/u.test(env.GITHUB_RUN_ID) ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))) {
    fail("repair_observation_not_scheduled");
  }
  // Run cleanup even when no release remains observing. A failed observation
  // can leave an isolated test identity after an uncertain cleanup or job kill.
  if (env.AI_REPAIR_FUNCTIONAL_SMOKE_ENABLED === "true") {
    await staleCleanupImpl(env, fetchImpl);
  }
  const rows = await supabaseRequest(
    env, fetchImpl,
    "/rest/v1/yutakasa_repair_releases?status=in.(pending_merge,observing)&select=pr_number,head_sha,merge_sha,status,created_at,merge_recorded_at&order=pr_number.desc&limit=5",
    null,
  );
  if (!Array.isArray(rows) || rows.length > 5) fail("repair_observe_release_rows_invalid");
  const releases = [];
  let abandoned = 0;
  for (const row of rows) {
    if (row?.status === "pending_merge") {
      const recovered = await reconcilePendingRelease(env, fetchImpl, row);
      if (recovered?.status === "abandoned") abandoned += 1;
      else if (recovered) releases.push(recovered);
    } else if (row?.status === "observing") {
      releases.push(row);
    } else fail("repair_observe_release_rows_invalid");
  }
  if (releases.length === 0) {
    if (abandoned > 0) fail("pending_release_abandoned");
    return { examined: 0, verified: 0, failed: 0 };
  }
  const environment = {
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    automationToken: env.CRON_SECRET,
  };
  let deployment;
  let collectionFailed = false;
  try {
    deployment = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  } catch {
    collectionFailed = true;
  }
  const summary = { examined: 0, verified: 0, failed: 0 };
  for (const release of releases) {
    let observedAt = new Date().toISOString();
    let observation;
    if (collectionFailed) {
      observation = {
        healthy: false, code: "production_probe_failed",
        deploymentId: DEPLOYMENT.test(deployment?.deploymentId ?? "") ? deployment.deploymentId : null,
      };
    } else if (release.merge_sha !== deployment.mainSha) {
      observation = { healthy: false, code: "main_sha_changed", deploymentId: deployment.deploymentId };
    } else {
      try {
        const functionalEvidence = await functionalSmokeImpl({ release, deployment, env, fetchImpl });
        const deploymentAfterSmoke = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
        if (deploymentAfterSmoke.mainSha !== deployment.mainSha ||
            deploymentAfterSmoke.deploymentId !== deployment.deploymentId ||
            deploymentAfterSmoke.ready !== true) {
          observation = { healthy: false, code: "production_changed_during_smoke",
            deploymentId: DEPLOYMENT.test(deploymentAfterSmoke.deploymentId ?? "")
              ? deploymentAfterSmoke.deploymentId : null };
        } else {
          const logs = await logsImpl({
            deploymentId: deployment.deploymentId,
            token: env.VERCEL_TOKEN,
            deploymentOnly: true,
            since: release.merge_recorded_at,
          });
          const snapshot = await snapshotImpl({ environment, fetchImpl });
          observedAt = new Date().toISOString();
          const deploymentAtReceipt = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
          if (deploymentAtReceipt.mainSha !== deployment.mainSha ||
              deploymentAtReceipt.deploymentId !== deployment.deploymentId ||
              deploymentAtReceipt.ready !== true) {
            observation = { healthy: false, code: "production_changed_during_observation",
              deploymentId: DEPLOYMENT.test(deploymentAtReceipt.deploymentId ?? "")
                ? deploymentAtReceipt.deploymentId : null };
          } else {
            observation = evaluateRepairObservation({ release, deployment: deploymentAtReceipt,
              logs, snapshot, functionalEvidence, observedAt });
          }
        }
      } catch {
        observation = { healthy: false, code: "functional_probe_failed", deploymentId: deployment.deploymentId };
      }
    }
    const result = await supabaseRequest(env, fetchImpl, "/rest/v1/rpc/record_yutakasa_repair_observation", {
      p_pr_number: release.pr_number,
      p_merge_sha: release.merge_sha,
      p_deployment_id: observation.deploymentId,
      p_observed_at: observedAt,
      p_healthy: observation.healthy,
      p_error_code: observation.code,
      p_workflow_run_id: Number(env.GITHUB_RUN_ID),
    });
    if (!Array.isArray(result) || result.length !== 1 ||
        !["observing", "verified", "failed"].includes(result[0]?.status) ||
        !Number.isSafeInteger(result[0]?.healthy_count)) fail("repair_observe_receipt_invalid");
    summary.examined += 1;
    if (result[0].status === "verified") summary.verified += 1;
    if (!observation.healthy || result[0].status === "failed") summary.failed += 1;
  }
  if (summary.failed > 0 || abandoned > 0) fail("repair_observation_failed");
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
