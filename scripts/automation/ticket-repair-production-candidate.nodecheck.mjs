import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProductionCandidateError, checkInputs, checkRegressionArtifact,
  checkScenarioSourceBinding, checkReleaseBinding, checkProductionSmoke,
  runProductionCandidate,
} from "./ticket-repair-production-candidate.mjs";

const workId = "d56b080a-a505-491a-9569-5ce865e803d7";
const ticketId = "b3d64c95-199d-4e3e-a6dd-f683f9f1aec5";
const messageId = "9f88bc61-67c3-45ed-a20b-7bda6e960297";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const deploymentId = "dpl_1234567890abcdef";
const scenarioKey = "chat_send_reload_persistence";
const testPath = "src/app/chat/page.test.tsx";
const testSource = "it('synthetic regression', () => expect(saved).toEqual(reloaded));\n";
const scenarioSha256 = createHash("sha256").update(testSource).digest("hex");
const sourceFile = { type: "file", encoding: "base64", path: testPath,
  size: Buffer.byteLength(testSource), content: Buffer.from(testSource).toString("base64") };
const env = { WORK_ID: workId, PR_NUMBER: "78", SCENARIO_KEY: scenarioKey,
  BEFORE_AFTER_RUN_ID: "450", GITHUB_RUN_ID: "451",
  GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach",
  GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: mergeSha, GITHUB_TOKEN: "x".repeat(30),
  SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(30),
  VERCEL_TOKEN: "x".repeat(30), JWT_SECRET: "x".repeat(40) };
const input = checkInputs(env);
const artifact = { schema: "yutakasa-ticket-regression-v1", workId,
  prNumber: 78, baseSha, headSha, scenarioKey, scenarioSha256,
  beforeFailureSha256: "e".repeat(64), afterSuccessSha256: "f".repeat(64),
  beforeAfterRunId: 450, tests: 2, productionVerified: false,
  ticketCompletionProofRecorded: false };
const run = { id: 450, event: "workflow_dispatch", status: "completed",
  conclusion: "success", run_attempt: 1, head_branch: "main", head_sha: baseSha,
  path: ".github/workflows/ticket-repair-regression-evidence.yml",
  repository: { full_name: env.GITHUB_REPOSITORY } };
const artifactList = { total_count: 1, artifacts: [{ id: 800, name: "ticket-regression-evidence",
  expired: false, size_in_bytes: 1234, digest: `sha256:${"9".repeat(64)}`,
  workflow_run: { id: 450, head_sha: baseSha } }] };
const pr = { number: 78, state: "closed", merged: true,
  merged_at: "2026-09-17T00:00:00Z", base: { ref: "main" },
  head: { sha: headSha, repo: { full_name: env.GITHUB_REPOSITORY } },
  merge_commit_sha: mergeSha };
const mergeCommit = { sha: mergeSha, parents: [{ sha: baseSha }, { sha: headSha }] };
const job = { work_id: workId, ticket_id: ticketId, latest_user_message_id: messageId,
  status: "pr_open", pr_number: 78, head_sha: headSha };
const links = [{ pr_number: 78, ticket_id: ticketId, latest_user_message_id: messageId }];
const release = { pr_number: 78, head_sha: headSha, merge_sha: mergeSha,
  status: "observing", merge_recorded_at: "2026-09-17T00:01:00Z",
  deployment_id: deploymentId };
const ticket = { id: ticketId, category: "technical", status: "in_progress",
  automation_status: "awaiting_repair", decision_required: false,
  subject: "チャットの会話が消える" };
const attachments = [];
const latestMessages = [{ id: messageId,
  body: "チャットの会話を送信して再読み込みすると、回答が消えます。",
  created_at: "2026-09-17T00:00:00Z" }];
const newerAdminMessages = [];
const deployment = { ready: true, mainSha: mergeSha, deploymentId };
const smoke = { schemaVersion: 1, mergeSha, deploymentId,
  desktopBrowser: true, mobileBrowser: true, streamComplete: true,
  databaseSaved: true, reloadPersisted: true, testDataCleaned: true,
  clientErrors: 0, observedAt: new Date().toISOString() };
const rejected = (code) => (error) => error instanceof ProductionCandidateError && error.code === code;

test("only a dispatch from exact deployed main may measure a fixed scenario", () => {
  assert.equal(input.scenarioKey, scenarioKey);
  assert.throws(() => checkInputs({ ...env, SCENARIO_KEY: "generic_smoke" }),
    rejected("production_candidate_inputs_invalid"));
  assert.throws(() => checkInputs({ ...env, GITHUB_SHA: headSha, GITHUB_REF: "refs/pull/78/head" }),
    rejected("production_candidate_inputs_invalid"));
  assert.throws(() => checkInputs({ ...env, BEFORE_AFTER_RUN_ID: "451" }),
    rejected("production_candidate_inputs_invalid"));
});

test("candidate artifact is tied to the exact successful trusted workflow run", () => {
  assert.match(checkRegressionArtifact(artifact, input, run, artifactList), /^[a-f0-9]{64}$/);
  assert.throws(() => checkRegressionArtifact({ ...artifact, productionVerified: true }, input, run, artifactList),
    rejected("regression_artifact_untrusted"));
  assert.throws(() => checkRegressionArtifact({ ...artifact, extra: "forged" }, input, run, artifactList),
    rejected("regression_artifact_untrusted"));
  assert.throws(() => checkRegressionArtifact(artifact, input, { ...run, head_sha: mergeSha }, artifactList),
    rejected("regression_artifact_untrusted"));
  assert.throws(() => checkRegressionArtifact(artifact, input, { ...run, run_attempt: 2 }, artifactList),
    rejected("regression_artifact_untrusted"));
  assert.throws(() => checkRegressionArtifact(artifact, input, run,
    { ...artifactList, artifacts: [{ ...artifactList.artifacts[0], expired: true }] }),
    rejected("regression_artifact_untrusted"));
});

test("the exact scenario test file survives from PR head into deployed merge", () => {
  assert.equal(checkScenarioSourceBinding(artifact, sourceFile, sourceFile), true);
  assert.throws(() => checkScenarioSourceBinding(artifact, sourceFile,
    { ...sourceFile, content: Buffer.from(testSource + "// changed").toString("base64"),
      size: Buffer.byteLength(testSource + "// changed") }),
  rejected("production_scenario_source_changed"));
  assert.throws(() => checkScenarioSourceBinding(artifact, sourceFile,
    { ...sourceFile, path: "src/app/chat/page.tsx" }),
  rejected("production_scenario_source_changed"));
});

test("release binding rejects stale PR, deployment, linked ticket, or latest message", () => {
  const args = { input, artifact, pr, mergeCommit, job, links, release,
    ticket, attachments, latestMessages, newerAdminMessages, deployment };
  assert.equal(checkReleaseBinding(args).deploymentId, deploymentId);
  assert.throws(() => checkReleaseBinding({ ...args,
    mergeCommit: { ...mergeCommit, parents: [{ sha: headSha }] } }),
  rejected("production_release_binding_invalid"));
  assert.throws(() => checkReleaseBinding({ ...args,
    links: [...links, { ...links[0], ticket_id: workId }] }),
  rejected("production_release_binding_invalid"));
  assert.throws(() => checkReleaseBinding({ ...args,
    latestMessages: [{ id: workId }, { id: messageId }] }),
  rejected("production_release_binding_invalid"));
  assert.throws(() => checkReleaseBinding({ ...args,
    attachments: [{ id: workId }] }), rejected("production_release_binding_invalid"));
  assert.throws(() => checkReleaseBinding({ ...args,
    latestMessages: [{ id: messageId, body: "再読み込みで会話が消え、回答も途中で止まる" }] }),
  rejected("production_release_binding_invalid"));
  assert.throws(() => checkReleaseBinding({ ...args,
    latestMessages: [{ id: messageId, body: "返金して。再読み込みで会話が消える" }] }),
  rejected("production_release_binding_invalid"));
  assert.throws(() => checkReleaseBinding({ ...args,
    newerAdminMessages: [{ id: workId, created_at: "2026-09-17T00:01:00Z" }] }),
  rejected("production_release_binding_invalid"));
  assert.throws(() => checkReleaseBinding({ ...args,
    deployment: { ...deployment, mainSha: headSha } }),
  rejected("production_release_binding_invalid"));
});

test("production E2E requires browser, stream, saved/reloaded DB, and cleanup", () => {
  const binding = checkReleaseBinding({ input, artifact, pr, mergeCommit,
    job, links, release, ticket, attachments, latestMessages, newerAdminMessages,
    deployment });
  assert.match(checkProductionSmoke(smoke, binding, scenarioKey), /^[a-f0-9]{64}$/);
  assert.match(checkProductionSmoke(smoke, binding, "chat_stream_completion"), /^[a-f0-9]{64}$/);
  assert.throws(() => checkProductionSmoke({ ...smoke, testDataCleaned: false }, binding, scenarioKey),
    rejected("production_scenario_measurement_invalid"));
  assert.throws(() => checkProductionSmoke({ ...smoke, support: { ticketCreated: true } }, binding, scenarioKey),
    rejected("production_scenario_measurement_invalid"));
  assert.throws(() => checkProductionSmoke({ ...smoke, reloadPersisted: false }, binding, scenarioKey),
    rejected("production_scenario_measurement_invalid"));
});

test("full candidate flow is read-only for real tickets and never calls completion RPC", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "yutakasa-candidate-test-"));
  const candidatePath = path.join(temp, "input.json");
  const evidencePath = path.join(temp, "output.json");
  await writeFile(candidatePath, JSON.stringify(artifact));
  const calls = [];
  const fetchImpl = async (value, options = {}) => {
    const url = new URL(value);
    calls.push({ path: url.pathname, method: options.method ?? "GET" });
    let valueOut;
    if (url.pathname.endsWith(`/actions/runs/${input.beforeAfterRunId}`)) valueOut = run;
    else if (url.pathname.endsWith(`/actions/runs/${input.beforeAfterRunId}/artifacts`)) valueOut = artifactList;
    else if (url.pathname.endsWith(`/pulls/${input.prNumber}`)) valueOut = pr;
    else if (url.pathname.endsWith(`/commits/${input.mainSha}`)) valueOut = mergeCommit;
    else if (url.pathname.endsWith(`/contents/${testPath}`)) valueOut = sourceFile;
    else if (url.pathname.endsWith("/yutakasa_ticket_repair_jobs")) valueOut = [job];
    else if (url.pathname.endsWith("/yutakasa_repair_ticket_links")) valueOut = links;
    else if (url.pathname.endsWith("/yutakasa_repair_releases")) valueOut = [release];
    else if (url.pathname.endsWith("/support_tickets")) valueOut = [ticket];
    else if (url.pathname.endsWith("/support_attachments")) valueOut = attachments;
    else if (url.pathname.endsWith("/support_messages")) valueOut =
      url.searchParams.get("sender_type") === "eq.user" ? latestMessages : newerAdminMessages;
    else throw Error("unexpected fetch");
    return new Response(JSON.stringify(valueOut), { status: 200 });
  };
  let smokeCalls = 0;
  try {
    const result = await runProductionCandidate({
      env: { ...env, CANDIDATE_PATH: candidatePath, EVIDENCE_PATH: evidencePath },
      fetchImpl,
      deploymentImpl: async () => deployment,
      smokeImpl: async ({ includeSupportTicket }) => {
        assert.equal(includeSupportTicket, false);
        smokeCalls += 1;
        return smoke;
      },
    });
    assert.equal(smokeCalls, 1);
    assert.equal(result.syntheticDataCleaned, true);
    assert.equal(result.customerConditionMatched, false);
    assert.equal(result.ticketCompletionProofRecorded, false);
    assert.equal(result.missingProof, "server_attested_ticket_replay_conditions_missing");
    assert.equal(JSON.parse(await readFile(evidencePath, "utf8")).productionSuccessSha256,
      result.productionSuccessSha256);
    assert.equal(calls.some((call) => call.method !== "GET" || call.path.includes("/rpc/")), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
