import assert from "node:assert/strict";
import test from "node:test";
import { ProductionPrepareError, selectProductionCandidate } from
  "./ticket-repair-production-prepare.mjs";

const sha = "a".repeat(40);
const workId = "d56b080a-a505-491a-9569-5ce865e803d7";
const observedAt = "2026-09-17T00:20:00Z";
const env = { GITHUB_EVENT_NAME: "workflow_run",
  GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach",
  GITHUB_SHA: sha, OBSERVED_RUN_ID: "401",
  OBSERVED_RUN_SHA: sha, OBSERVED_RUN_CONCLUSION: "success",
  OBSERVED_RUN_HEAD_BRANCH: "main", SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "x".repeat(30) };
const observation = { pr_number: 89, observed_at: observedAt };
const release = { pr_number: 89, merge_sha: sha, status: "verified",
  verified_at: observedAt, last_healthy_at: observedAt,
  ticket_before_after_run_id: 301, ticket_regression_artifact_sha256: "b".repeat(64) };
const job = { work_id: workId, status: "pr_open" };
const rejected = (code) => (error) => error instanceof ProductionPrepareError &&
  error.code === code;

function fetchFor({ observations = [observation], releases = [release],
  jobs = [job], proofs = [] } = {}) {
  return async (url) => {
    const pathname = new URL(url).pathname;
    let rows;
    if (pathname.endsWith("/yutakasa_repair_observations")) rows = observations;
    else if (pathname.endsWith("/yutakasa_repair_releases")) rows = releases;
    else if (pathname.endsWith("/yutakasa_ticket_repair_jobs")) rows = jobs;
    else if (pathname.endsWith("/yutakasa_ticket_completion_proofs")) rows = proofs;
    else throw Error("unexpected_query");
    return new Response(JSON.stringify(rows), { status: 200 });
  };
}

test("exact successful observer run selects its newly verified release", async () => {
  assert.deepEqual(await selectProductionCandidate({ env, fetchImpl: fetchFor() }), {
    eligible: true, workId, prNumber: 89,
    scenarioKey: "chat_title_zero_width", beforeAfterRunId: 301 });
});

test("unrelated observer runs and completed proofs do not repeat production measurement", async () => {
  assert.deepEqual(await selectProductionCandidate({ env,
    fetchImpl: fetchFor({ observations: [] }) }), { eligible: false });
  assert.deepEqual(await selectProductionCandidate({ env,
    fetchImpl: fetchFor({ proofs: [{ work_id: workId }] }) }), { eligible: false });
  assert.deepEqual(await selectProductionCandidate({ env,
    fetchImpl: fetchFor({ releases: [{ ...release, verified_at: "2026-09-17T00:10:00Z" }] }) }),
  { eligible: false });
});

test("ambiguous observation or stale job fails closed", async () => {
  await assert.rejects(selectProductionCandidate({ env,
    fetchImpl: fetchFor({ observations: [observation, { ...observation, pr_number: 90 }] }) }),
  rejected("production_prepare_observation_ambiguous"));
  await assert.rejects(selectProductionCandidate({ env,
    fetchImpl: fetchFor({ jobs: [{ ...job, status: "failed" }] }) }),
  rejected("production_prepare_job_invalid"));
  await assert.rejects(selectProductionCandidate({ env: { ...env, OBSERVED_RUN_SHA: "c".repeat(40) },
    fetchImpl: fetchFor() }), rejected("production_prepare_observer_invalid"));
});
