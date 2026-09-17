#!/usr/bin/env node

// Select only the release verified by the observer run that triggered this
// workflow. The production candidate independently rechecks every binding.
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export class ProductionPrepareError extends Error {
  constructor(code) { super(code); this.name = "ProductionPrepareError"; this.code = code; }
}
const fail = (code) => { throw new ProductionPrepareError(code); };

async function query(env, fetchImpl, table, params) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/u.test(env.SUPABASE_URL ?? "") ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
      env.SUPABASE_SERVICE_ROLE_KEY.length < 20) fail("production_prepare_database_config_invalid");
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
  }, redirect: "error", signal: AbortSignal.timeout(15_000) })
    .catch(() => fail("production_prepare_database_request_failed"));
  if (response.status !== 200) fail("production_prepare_database_http_invalid");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 16 * 1024) fail("production_prepare_database_response_large");
  let data;
  try { data = JSON.parse(raw); } catch { fail("production_prepare_database_json_invalid"); }
  if (!Array.isArray(data) || data.length > 2) fail("production_prepare_database_rows_invalid");
  return data;
}

export async function selectProductionCandidate({ env = process.env,
  fetchImpl = globalThis.fetch } = {}) {
  const runId = Number(env.OBSERVED_RUN_ID);
  if (env.GITHUB_EVENT_NAME !== "workflow_run" || env.GITHUB_REPOSITORY !== REPO ||
      env.OBSERVED_RUN_CONCLUSION !== "success" ||
      env.OBSERVED_RUN_HEAD_BRANCH !== "main" ||
      !SHA.test(env.OBSERVED_RUN_SHA ?? "") ||
      env.OBSERVED_RUN_SHA !== env.GITHUB_SHA ||
      !Number.isSafeInteger(runId) || runId < 1) {
    fail("production_prepare_observer_invalid");
  }
  const observations = await query(env, fetchImpl, "yutakasa_repair_observations", {
    workflow_run_id: `eq.${runId}`, healthy: "eq.true",
    select: "pr_number,observed_at", limit: "2",
  });
  if (observations.length === 0) return { eligible: false };
  if (observations.length !== 1 || !Number.isSafeInteger(observations[0]?.pr_number) ||
      observations[0].pr_number < 1 ||
      !Number.isFinite(Date.parse(observations[0]?.observed_at ?? ""))) {
    fail("production_prepare_observation_ambiguous");
  }
  const prNumber = observations[0].pr_number;
  const releases = await query(env, fetchImpl, "yutakasa_repair_releases", {
    pr_number: `eq.${prNumber}`,
    select: "pr_number,merge_sha,status,verified_at,last_healthy_at,ticket_before_after_run_id,ticket_regression_artifact_sha256",
    limit: "2",
  });
  const release = releases[0];
  const beforeAfterRunId = Number(release?.ticket_before_after_run_id);
  if (releases.length !== 1 || release.pr_number !== prNumber ||
      release.merge_sha !== env.GITHUB_SHA || release.status !== "verified" ||
      Date.parse(release.verified_at ?? "") !== Date.parse(observations[0].observed_at) ||
      Date.parse(release.last_healthy_at ?? "") !== Date.parse(observations[0].observed_at) ||
      !Number.isSafeInteger(beforeAfterRunId) || beforeAfterRunId < 1 ||
      !DIGEST.test(release.ticket_regression_artifact_sha256 ?? "")) {
    return { eligible: false };
  }
  const jobs = await query(env, fetchImpl, "yutakasa_ticket_repair_jobs", {
    pr_number: `eq.${prNumber}`,
    select: "work_id,status", limit: "2",
  });
  if (jobs.length !== 1 || !UUID.test(jobs[0]?.work_id ?? "") ||
      jobs[0].status !== "pr_open") {
    fail("production_prepare_job_invalid");
  }
  const proofs = await query(env, fetchImpl, "yutakasa_ticket_completion_proofs", {
    work_id: `eq.${jobs[0].work_id}`, select: "work_id", limit: "2",
  });
  if (proofs.length > 0) return { eligible: false };
  return { eligible: true, workId: jobs[0].work_id, prNumber,
    scenarioKey: "chat_title_zero_width", beforeAfterRunId };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  selectProductionCandidate().then(async (result) => {
    if (typeof process.env.GITHUB_OUTPUT !== "string") fail("production_prepare_output_missing");
    const lines = [`eligible=${result.eligible}`];
    if (result.eligible) lines.push(`work_id=${result.workId}`, `pr_number=${result.prNumber}`,
      `scenario_key=${result.scenarioKey}`, `before_after_run_id=${result.beforeAfterRunId}`);
    await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
    process.stdout.write(`${JSON.stringify({ eligible: result.eligible })}\n`);
  }, (error) => {
    process.stderr.write(`${error instanceof ProductionPrepareError ? error.code : "production_prepare_failed"}\n`);
    process.exitCode = 1;
  });
}
