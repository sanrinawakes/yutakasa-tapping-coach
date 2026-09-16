#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runRemoteMonitor } from "./remote-monitor.mjs";
import { fingerprint } from "./ai-repair-publish.mjs";
import { acquireMonitorLease, MonitorLedgerError } from "./monitor-ledger.mjs";

const REPAIRABLE_REASONS = new Set([
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
const MAX_INPUT_BYTES = 2_048;

export class AiRepairGateError extends Error {
  constructor(code) {
    super(code);
    this.name = "AiRepairGateError";
    this.code = code;
  }
}

function fail(code) {
  throw new AiRepairGateError(code);
}

export function parseDispatch(reasonCodesJson, deploymentId) {
  if (
    typeof reasonCodesJson !== "string" ||
    Buffer.byteLength(reasonCodesJson) > MAX_INPUT_BYTES ||
    typeof deploymentId !== "string" ||
    !/^dpl_[A-Za-z0-9]{12,80}$/u.test(deploymentId)
  ) {
    fail("dispatch_input_invalid");
  }
  let codes;
  try {
    codes = JSON.parse(reasonCodesJson);
  } catch {
    fail("dispatch_reason_codes_invalid");
  }
  if (
    !Array.isArray(codes) ||
    codes.length < 1 ||
    codes.length > 20 ||
    codes.some((code) => typeof code !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/u.test(code))
  ) {
    fail("dispatch_reason_codes_invalid");
  }
  return { reasonCodes: [...new Set(codes)].sort(), deploymentId };
}

export function validateCapAttestation({ projectId, verifiedProjectId, verifiedUsd }) {
  if (
    typeof projectId !== "string" ||
    !/^proj_[A-Za-z0-9]{8,80}$/u.test(projectId) ||
    projectId !== verifiedProjectId ||
    verifiedUsd !== "20"
  ) {
    fail("openai_hard_cap_attestation_missing_or_invalid");
  }
}

export function decideAiRepair(dispatch, live) {
  if (
    live?.ok !== true ||
    typeof live.deploymentId !== "string" ||
    typeof live.actionRequired !== "boolean" ||
    !Array.isArray(live.reasonCodes)
  ) {
    fail("live_monitor_result_invalid");
  }
  if (live.deploymentId !== dispatch.deploymentId) {
    return { shouldRun: false, code: "deployment_changed", reasonCodes: [] };
  }
  if (!live.actionRequired) {
    return { shouldRun: false, code: "anomaly_cleared", reasonCodes: [] };
  }
  const current = new Set(live.reasonCodes);
  const matching = dispatch.reasonCodes.filter(
    (reason) => REPAIRABLE_REASONS.has(reason) && current.has(reason),
  );
  return {
    shouldRun: matching.length > 0,
    code: matching.length > 0 ? "repairable_anomaly_confirmed" : "no_repairable_match",
    reasonCodes: matching,
  };
}

export async function existingIncident({ deploymentId, reasonCodes, token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== "string" || token.length < 20) {
    fail("github_read_credential_missing");
  }
  const incidentId = fingerprint(deploymentId, reasonCodes);
  // Include closed incidents: a rejected/closed PR must not trigger another paid
  // investigation for the same deployment and anomaly fingerprint.
  const query = `repo:sanrinawakes/yutakasa-tapping-coach in:title ${incidentId}`;
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "100");
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => fail("github_incident_search_failed"));
  if (response.status !== 200) fail("github_incident_search_failed");
  const data = await response.json().catch(() => fail("github_incident_search_invalid"));
  if (
    !Number.isSafeInteger(data?.total_count) ||
    data.total_count < 0 ||
    data.total_count > 100 ||
    !Array.isArray(data.items)
  ) {
    fail("github_incident_search_invalid");
  }
  return data.items.some(
    (item) => typeof item?.title === "string" &&
      item.title.startsWith(`Yutakasa anomaly ${incidentId}`),
  );
}

function appendGitHubOutputs(outputPath, values) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("github_output_missing");
  }
  const lines = [
    `should_run=${values.shouldRun ? "true" : "false"}`,
    `reason_codes=${JSON.stringify(values.reasonCodes)}`,
    `deployment_id=${values.deploymentId}`,
  ];
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`, { encoding: "utf8" });
}

export async function runAiRepairGate({
  env = process.env,
  monitor = runRemoteMonitor,
  leaseImpl = acquireMonitorLease,
  incidentSearch = existingIncident,
  writeOutputs = appendGitHubOutputs,
} = {}) {
  const dispatch = parseDispatch(env.DISPATCH_REASON_CODES, env.DISPATCH_DEPLOYMENT_ID);
  validateCapAttestation({
    projectId: env.YUTAKASA_OPENAI_PROJECT_ID,
    verifiedProjectId: env.YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID,
    verifiedUsd: env.YUTAKASA_OPENAI_CAP_CONFIRMED_USD,
  });
  let live;
  let lease;
  try {
    lease = await leaseImpl({ secrets: env, kind: "recheck" });
    try {
      live = await monitor({ secrets: env, leaseGuard: () => lease.assertActive() });
      await lease.finish({
        ...live,
        status: live.actionRequired ? "action_required" : "healthy",
        alertDispatched: false,
        repairDispatched: false,
      });
    } catch (error) {
      try {
        await lease.finish({
          status: "failed", reasonCodes: ["live_recheck_failed"],
          errorCode: "live_recheck_failed",
        });
      } catch {
        // Lease loss is a failed recheck; no AI job may start.
      }
      throw error;
    } finally {
      await lease.stop();
    }
  } catch (error) {
    if (error instanceof MonitorLedgerError) fail(error.code);
    fail("live_recheck_failed");
  }
  let decision = decideAiRepair(dispatch, live);
  if (decision.shouldRun && await incidentSearch({
    deploymentId: dispatch.deploymentId,
    reasonCodes: decision.reasonCodes,
    token: env.GITHUB_TOKEN,
  })) {
    decision = { shouldRun: false, code: "existing_incident", reasonCodes: [] };
  }
  writeOutputs(env.GITHUB_OUTPUT, { ...decision, deploymentId: dispatch.deploymentId });
  return { ...decision, deploymentId: dispatch.deploymentId };
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runAiRepairGate().then(
    (result) => {
      process.stdout.write(`${JSON.stringify({ ok: true, code: result.code })}\n`);
    },
    (error) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: error instanceof AiRepairGateError ? error.code : "ai_repair_gate_failed" })}\n`,
      );
      process.exitCode = 1;
    },
  );
}
