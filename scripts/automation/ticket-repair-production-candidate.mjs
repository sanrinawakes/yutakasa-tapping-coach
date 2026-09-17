#!/usr/bin/env node

// Trusted, main-only production measurement for the two fixed chat scenarios.
// Free-text support symptoms have no server-attested replay parameters. Only
// the exact zero-width title condition can record a completion proof.
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectRemoteDeployment } from "./remote-production.mjs";
import { runProductionFunctionalSmoke } from "./ai-repair-functional-smoke.mjs";
import { checkRecordedZeroWidthCondition, checkUiCondition,
  checkZeroWidthProductionEvidence, TicketConditionError,
  ZERO_WIDTH_CONDITION } from "./ticket-customer-condition-proof.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DEPLOYMENT = /^dpl_[A-Za-z0-9]{8,160}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SCENARIOS = new Set(["chat_send_reload_persistence", "chat_stream_completion",
  ZERO_WIDTH_CONDITION.scenarioKey]);
const TEST_PATHS = Object.freeze({
  chat_send_reload_persistence: "src/app/chat/page.test.tsx",
  chat_stream_completion: "src/app/api/chat/route.test.ts",
  chat_title_zero_width: "src/lib/chat-thread.test.ts",
});
const OWNER_TERMS = /(返金|払い戻し|解約|契約|請求|決済|課金|料金|支払|領収|法律|訴訟|補償|個人情報|削除|refund|billing|payment|cancel|contract|legal)/iu;
const CANDIDATE_KEYS = [
  "afterSuccessSha256", "baseSha", "beforeAfterRunId", "beforeFailureSha256",
  "headSha", "prNumber", "productionVerified", "scenarioKey", "scenarioSha256",
  "schema", "tests", "ticketCompletionProofRecorded", "workId",
].sort();

export class ProductionCandidateError extends Error {
  constructor(code) { super(code); this.name = "ProductionCandidateError"; this.code = code; }
}
function fail(code) { throw new ProductionCandidateError(code); }
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function checkInputs(env) {
  const prNumber = Number(env.PR_NUMBER);
  const beforeAfterRunId = Number(env.BEFORE_AFTER_RUN_ID);
  const productionRunId = Number(env.GITHUB_RUN_ID);
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      !["workflow_dispatch", "workflow_run"].includes(env.GITHUB_EVENT_NAME) ||
      !SHA.test(env.GITHUB_SHA ?? "") ||
      !UUID.test(env.WORK_ID ?? "") || !SCENARIOS.has(env.SCENARIO_KEY) ||
      !Number.isSafeInteger(prNumber) || prNumber < 1 ||
      !Number.isSafeInteger(beforeAfterRunId) || beforeAfterRunId < 1 ||
      !Number.isSafeInteger(productionRunId) || productionRunId < 1 ||
      beforeAfterRunId === productionRunId) fail("production_candidate_inputs_invalid");
  return { workId: env.WORK_ID, prNumber, beforeAfterRunId,
    productionRunId, scenarioKey: env.SCENARIO_KEY, mainSha: env.GITHUB_SHA };
}

export function checkRegressionArtifact(artifact, input, run, artifactList) {
  const stored = artifactList?.artifacts?.[0];
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
      Object.keys(artifact).sort().join(",") !== CANDIDATE_KEYS.join(",") ||
      artifact.schema !== "yutakasa-ticket-regression-v1" ||
      artifact.workId !== input.workId || artifact.prNumber !== input.prNumber ||
      artifact.scenarioKey !== input.scenarioKey ||
      artifact.beforeAfterRunId !== input.beforeAfterRunId ||
      !SHA.test(artifact.baseSha ?? "") || !SHA.test(artifact.headSha ?? "") ||
      artifact.baseSha === artifact.headSha ||
      !SHA256.test(artifact.scenarioSha256 ?? "") ||
      !SHA256.test(artifact.beforeFailureSha256 ?? "") ||
      !SHA256.test(artifact.afterSuccessSha256 ?? "") ||
      artifact.beforeFailureSha256 === artifact.afterSuccessSha256 ||
      !Number.isSafeInteger(artifact.tests) || artifact.tests < 1 || artifact.tests > 200 ||
      artifact.productionVerified !== false || artifact.ticketCompletionProofRecorded !== false ||
      run?.id !== input.beforeAfterRunId ||
      !["workflow_dispatch", "workflow_run"].includes(run?.event) ||
      run?.status !== "completed" || run?.conclusion !== "success" ||
      run?.run_attempt !== 1 || run?.head_branch !== "main" ||
      run?.head_sha !== artifact.baseSha ||
      run?.path !== ".github/workflows/ticket-repair-regression-evidence.yml" ||
      run?.repository?.full_name !== REPO ||
      artifactList?.total_count !== 1 || !Array.isArray(artifactList.artifacts) ||
      artifactList.artifacts.length !== 1 ||
      stored?.name !== "ticket-regression-evidence" || stored?.expired !== false ||
      !Number.isSafeInteger(stored?.id) || stored.id < 1 ||
      !Number.isSafeInteger(stored?.size_in_bytes) || stored.size_in_bytes < 2 ||
      stored.size_in_bytes > 16 * 1024 ||
      !/^sha256:[a-f0-9]{64}$/u.test(stored?.digest ?? "") ||
      stored?.workflow_run?.id !== input.beforeAfterRunId ||
      stored.workflow_run.head_sha !== artifact.baseSha) fail("regression_artifact_untrusted");
  return digest(JSON.stringify(artifact));
}

function githubFileText(file) {
  if (file?.type !== "file" || file?.encoding !== "base64" ||
      typeof file.content !== "string" || file.content.length > 256 * 1024 ||
      !/^[A-Za-z0-9+/=\n]+$/u.test(file.content) ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 180 * 1024) {
    fail("production_scenario_source_invalid");
  }
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length !== file.size) fail("production_scenario_source_invalid");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("production_scenario_source_invalid"); }
}

export function checkScenarioSourceBinding(artifact, headFile, mergeFile) {
  const testPath = TEST_PATHS[artifact.scenarioKey];
  if (!testPath || headFile?.path !== testPath || mergeFile?.path !== testPath ||
      digest(githubFileText(headFile)) !== artifact.scenarioSha256 ||
      digest(githubFileText(mergeFile)) !== artifact.scenarioSha256) {
    fail("production_scenario_source_changed");
  }
  return true;
}

export function checkReleaseBinding({ input, artifact, regressionArtifactSha256, pr, mergeCommit, job, links,
  release, ticket, attachments, latestMessages, newerAdminMessages, deployment }) {
  const body = latestMessages?.[0]?.body;
  const latestAt = Date.parse(latestMessages?.[0]?.created_at ?? "");
  const persistence = typeof body === "string" &&
    /(再読み込み|リロード|更新)/u.test(body) &&
    /(会話|メッセージ|返信|回答)/u.test(body) &&
    /(消え|保存され|残ら|表示され)/u.test(body);
  const stream = typeof body === "string" &&
    /(回答|返信)/u.test(body) && /(途中|止ま|切れ|完了しな)/u.test(body);
  if (input.scenarioKey === ZERO_WIDTH_CONDITION.scenarioKey) {
    try { checkRecordedZeroWidthCondition({ ticket, latestMessages, attachments,
      newerAdminMessages }); }
    catch (error) {
      if (error instanceof TicketConditionError) fail(error.code);
      throw error;
    }
  }
  if (pr?.number !== input.prNumber || pr?.state !== "closed" || pr?.merged !== true ||
      !Number.isFinite(Date.parse(pr?.merged_at ?? "")) ||
      pr?.base?.ref !== "main" || pr?.head?.repo?.full_name !== REPO ||
      pr?.head?.sha !== artifact.headSha || pr?.merge_commit_sha !== input.mainSha ||
      mergeCommit?.sha !== input.mainSha || !Array.isArray(mergeCommit?.parents) ||
      mergeCommit.parents.length < 1 ||
      mergeCommit.parents[0]?.sha !== artifact.baseSha ||
      job?.work_id !== input.workId || job?.status !== "pr_open" ||
      job?.pr_number !== input.prNumber || job?.head_sha !== artifact.headSha ||
      !UUID.test(job?.ticket_id ?? "") || !UUID.test(job?.latest_user_message_id ?? "") ||
      !Array.isArray(links) || links.length !== 1 ||
      links[0]?.pr_number !== input.prNumber ||
      links[0]?.ticket_id !== job.ticket_id ||
      links[0]?.latest_user_message_id !== job.latest_user_message_id ||
      ticket?.id !== job.ticket_id || ticket?.category !== "technical" ||
      ticket?.status !== "in_progress" ||
      ticket?.automation_status !== "awaiting_repair" ||
      ticket?.decision_required !== false ||
      typeof ticket?.subject !== "string" || OWNER_TERMS.test(ticket.subject) ||
      !Array.isArray(attachments) || attachments.length !== 0 ||
      !Array.isArray(latestMessages) || latestMessages.length < 1 ||
      latestMessages.length > 2 || latestMessages[0]?.id !== job.latest_user_message_id ||
      !Number.isFinite(latestAt) ||
      typeof body !== "string" || body.length < 1 || body.length > 10_000 ||
      OWNER_TERMS.test(body) ||
      !Array.isArray(newerAdminMessages) ||
      newerAdminMessages.some((message) => !Number.isFinite(Date.parse(message?.created_at ?? "")) ||
        Date.parse(message.created_at) >= latestAt) ||
      (input.scenarioKey === "chat_send_reload_persistence" && (!persistence || stream)) ||
      (input.scenarioKey === "chat_stream_completion" && (!stream || persistence)) ||
      (input.scenarioKey === ZERO_WIDTH_CONDITION.scenarioKey && (persistence || stream)) ||
      release?.pr_number !== input.prNumber || release?.head_sha !== artifact.headSha ||
      release?.merge_sha !== input.mainSha ||
      Number(release?.ticket_before_after_run_id) !== input.beforeAfterRunId ||
      release?.ticket_regression_artifact_sha256 !==
        (regressionArtifactSha256 ?? digest(JSON.stringify(artifact))) ||
      !["observing", "verified"].includes(release?.status) ||
      !Number.isFinite(Date.parse(release?.merge_recorded_at ?? "")) ||
      (release.deployment_id !== null && release.deployment_id !== deployment?.deploymentId) ||
      deployment?.ready !== true || deployment?.mainSha !== input.mainSha ||
      !DEPLOYMENT.test(deployment?.deploymentId ?? "")) {
    fail("production_release_binding_invalid");
  }
  return { ticketId: job.ticket_id, latestUserMessageId: job.latest_user_message_id,
    latestBodySha256: digest(body), subjectSha256: digest(ticket.subject),
    headSha: artifact.headSha, mergeSha: input.mainSha,
    deploymentId: deployment.deploymentId };
}

export function checkProductionSmoke(evidence, binding, scenarioKey) {
  if (!SCENARIOS.has(scenarioKey) || evidence?.schemaVersion !== 1 ||
      evidence?.mergeSha !== binding.mergeSha ||
      evidence?.deploymentId !== binding.deploymentId ||
      evidence?.desktopBrowser !== true || evidence?.mobileBrowser !== true ||
      evidence?.streamComplete !== true || evidence?.databaseSaved !== true ||
      evidence?.reloadPersisted !== true || evidence?.testDataCleaned !== true ||
      evidence?.clientErrors !== 0 || evidence?.support !== undefined ||
      !Number.isFinite(Date.parse(evidence?.observedAt ?? "")) ||
      Math.abs(Date.now() - Date.parse(evidence.observedAt)) > 5 * 60 * 1000) {
    fail("production_scenario_measurement_invalid");
  }
  if (scenarioKey === ZERO_WIDTH_CONDITION.scenarioKey) {
    try { checkZeroWidthProductionEvidence(evidence, binding); }
    catch (error) {
      if (error instanceof TicketConditionError) fail(error.code);
      throw error;
    }
  }
  return digest(JSON.stringify({ scenarioKey, evidence }));
}

async function recordCompletionProof(input, artifact, binding, productionSuccessSha256,
  env, fetchImpl) {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/record_yutakasa_ticket_completion_proof`, {
    method: "POST", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ p_work_id: input.workId,
      p_latest_user_message_id: binding.latestUserMessageId,
      p_pr_number: input.prNumber, p_head_sha: artifact.headSha,
      p_merge_sha: binding.mergeSha, p_deployment_id: binding.deploymentId,
      p_scenario_key: input.scenarioKey, p_scenario_sha256: artifact.scenarioSha256,
      p_before_failure_sha256: artifact.beforeFailureSha256,
      p_after_success_sha256: artifact.afterSuccessSha256,
      p_production_success_sha256: productionSuccessSha256,
      p_before_after_run_id: input.beforeAfterRunId,
      p_production_run_id: input.productionRunId }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("production_proof_record_request_failed"));
  if (response.status !== 200) fail("production_proof_record_http_invalid");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 4_096) fail("production_proof_record_response_large");
  let rows;
  try { rows = JSON.parse(raw); } catch { fail("production_proof_record_response_invalid"); }
  if (!Array.isArray(rows) || rows.length !== 1 ||
      typeof rows[0]?.created !== "boolean") fail("production_proof_record_unconfirmed");
  return rows[0].created;
}

async function readArtifact(file) {
  if (typeof file !== "string" || !file) fail("regression_artifact_path_invalid");
  const stat = await lstat(file).catch(() => fail("regression_artifact_missing"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 8 * 1024) {
    fail("regression_artifact_file_invalid");
  }
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { fail("regression_artifact_json_invalid"); }
}

async function githubJson(env, fetchImpl, suffix) {
  const token = env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length < 20) fail("production_github_token_missing");
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/${suffix}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
      "User-Agent": "yutakasa-production-candidate" },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("production_github_request_failed"));
  if (response.status !== 200) fail("production_github_http_invalid");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 512 * 1024) fail("production_github_response_large");
  try { return JSON.parse(raw); } catch { fail("production_github_json_invalid"); }
}

async function rows(env, fetchImpl, table, query) {
  if (typeof env.SUPABASE_URL !== "string" ||
      !/^https:\/\/[a-z0-9-]+\.supabase\.co$/u.test(env.SUPABASE_URL) ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
      env.SUPABASE_SERVICE_ROLE_KEY.length < 20) fail("production_database_config_invalid");
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
  }, redirect: "error", signal: AbortSignal.timeout(15_000) })
    .catch(() => fail("production_database_request_failed"));
  if (response.status !== 200) fail("production_database_http_invalid");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 16 * 1024) fail("production_database_response_large");
  let data;
  try { data = JSON.parse(raw); } catch { fail("production_database_json_invalid"); }
  if (!Array.isArray(data) || data.length > 2) fail("production_database_rows_invalid");
  return data;
}

async function one(rowsValue, code) {
  if (rowsValue.length !== 1) fail(code);
  return rowsValue[0];
}

async function releaseRows(input, artifact, env, fetchImpl) {
  const [jobs, links, releases] = await Promise.all([
    rows(env, fetchImpl, "yutakasa_ticket_repair_jobs", {
      work_id: `eq.${input.workId}`,
      select: "work_id,ticket_id,latest_user_message_id,pr_number,head_sha,status", limit: "2",
    }),
    rows(env, fetchImpl, "yutakasa_repair_ticket_links", {
      pr_number: `eq.${input.prNumber}`, select: "pr_number,ticket_id,latest_user_message_id", limit: "2",
    }),
    rows(env, fetchImpl, "yutakasa_repair_releases", {
      pr_number: `eq.${input.prNumber}`,
      select: "pr_number,head_sha,merge_sha,status,merge_recorded_at,deployment_id,ticket_before_after_run_id,ticket_regression_artifact_sha256", limit: "2",
    }),
  ]);
  const job = await one(jobs, "production_work_missing_or_ambiguous");
  const [tickets, attachments, latestMessages, adminMessages] = await Promise.all([
    rows(env, fetchImpl, "support_tickets", {
      id: `eq.${job.ticket_id}`,
      select: "id,category,status,automation_status,decision_required,subject", limit: "2",
    }),
    rows(env, fetchImpl, "support_attachments", {
      ticket_id: `eq.${job.ticket_id}`, select: "id", limit: "2",
    }),
    rows(env, fetchImpl, "support_messages", {
      ticket_id: `eq.${job.ticket_id}`, sender_type: "eq.user",
      select: "id,body,created_at", order: "created_at.desc,id.desc", limit: "2",
    }),
    rows(env, fetchImpl, "support_messages", {
      ticket_id: `eq.${job.ticket_id}`, sender_type: "eq.admin",
      select: "id,created_at", order: "created_at.desc,id.desc", limit: "2",
    }),
  ]);
  return { job, links, release: await one(releases, "production_release_missing_or_ambiguous"),
    ticket: await one(tickets, "production_ticket_missing_or_ambiguous"),
    attachments, latestMessages, newerAdminMessages: adminMessages, artifact };
}

export async function runProductionCandidate({
  env = process.env, fetchImpl = globalThis.fetch,
  deploymentImpl = collectRemoteDeployment, smokeImpl = runProductionFunctionalSmoke,
  root = process.cwd(),
} = {}) {
  const input = checkInputs(env);
  const artifact = await readArtifact(env.CANDIDATE_PATH);
  const [run, artifactList, pr, mergeCommit, deployment] = await Promise.all([
    githubJson(env, fetchImpl, `actions/runs/${input.beforeAfterRunId}`),
    githubJson(env, fetchImpl, `actions/runs/${input.beforeAfterRunId}/artifacts?name=ticket-regression-evidence`),
    githubJson(env, fetchImpl, `pulls/${input.prNumber}`),
    githubJson(env, fetchImpl, `commits/${input.mainSha}`),
    deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl }),
  ]);
  const regressionArtifactSha256 = checkRegressionArtifact(artifact, input, run, artifactList);
  const testPath = TEST_PATHS[input.scenarioKey];
  const [headFile, mergeFile] = await Promise.all([
    githubJson(env, fetchImpl, `contents/${testPath}?ref=${artifact.headSha}`),
    githubJson(env, fetchImpl, `contents/${testPath}?ref=${input.mainSha}`),
  ]);
  checkScenarioSourceBinding(artifact, headFile, mergeFile);
  const beforeRows = await releaseRows(input, artifact, env, fetchImpl);
  const binding = checkReleaseBinding({ input, artifact, regressionArtifactSha256, pr, mergeCommit,
    ...beforeRows, deployment });
  if (input.scenarioKey === ZERO_WIDTH_CONDITION.scenarioKey) {
    const ui = JSON.parse(await readFile(path.join(root,
      "src/lib/support-technical-scenarios.json"), "utf8"));
    try { checkUiCondition(ui); }
    catch (error) {
      if (error instanceof TicketConditionError) fail(error.code);
      throw error;
    }
  }
  // This existing isolated E2E creates a no-payment user, sends on desktop and
  // mobile, confirms stream completion, DB save and reload, then verifies cleanup.
  // It measures the selected symptom's invariant but cannot reconstruct the
  // customer's free-text environmental conditions.
  const smoke = await smokeImpl({ release: { merge_sha: binding.mergeSha },
    deployment, env, fetchImpl, includeSupportTicket: false,
    titleScenario: input.scenarioKey === ZERO_WIDTH_CONDITION.scenarioKey });
  const productionSuccessSha256 = checkProductionSmoke(smoke, binding, input.scenarioKey);
  const [afterDeployment, afterRows, afterPr] = await Promise.all([
    deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl }),
    releaseRows(input, artifact, env, fetchImpl),
    githubJson(env, fetchImpl, `pulls/${input.prNumber}`),
  ]);
  checkReleaseBinding({ input, artifact, regressionArtifactSha256, pr: afterPr, mergeCommit,
    ...afterRows, deployment: afterDeployment });
  if (afterDeployment.deploymentId !== binding.deploymentId ||
      afterDeployment.mainSha !== binding.mergeSha ||
      afterRows.job.ticket_id !== binding.ticketId ||
      afterRows.job.latest_user_message_id !== binding.latestUserMessageId ||
      digest(afterRows.latestMessages[0].body) !== binding.latestBodySha256 ||
      digest(afterRows.ticket.subject) !== binding.subjectSha256) {
    fail("production_changed_during_measurement");
  }
  let proofRecorded = false;
  if (input.scenarioKey === ZERO_WIDTH_CONDITION.scenarioKey) {
    await recordCompletionProof(input, artifact, binding, productionSuccessSha256,
      env, fetchImpl);
    const recorded = await rows(env, fetchImpl, "yutakasa_ticket_completion_proofs", {
      work_id: `eq.${input.workId}`,
      select: "work_id,ticket_id,latest_user_message_id,pr_number,head_sha,merge_sha,deployment_id,scenario_key,scenario_sha256,before_failure_sha256,after_success_sha256,production_success_sha256,before_after_run_id,production_run_id",
      limit: "2",
    });
    if (recorded.length !== 1 || recorded[0].work_id !== input.workId ||
        recorded[0].ticket_id !== binding.ticketId ||
        recorded[0].latest_user_message_id !== binding.latestUserMessageId ||
        recorded[0].pr_number !== input.prNumber ||
        recorded[0].head_sha !== artifact.headSha ||
        recorded[0].merge_sha !== binding.mergeSha ||
        recorded[0].deployment_id !== binding.deploymentId ||
        recorded[0].scenario_key !== input.scenarioKey ||
        recorded[0].scenario_sha256 !== artifact.scenarioSha256 ||
        recorded[0].before_failure_sha256 !== artifact.beforeFailureSha256 ||
        recorded[0].after_success_sha256 !== artifact.afterSuccessSha256 ||
        recorded[0].production_success_sha256 !== productionSuccessSha256 ||
        Number(recorded[0].before_after_run_id) !== input.beforeAfterRunId ||
        Number(recorded[0].production_run_id) !== input.productionRunId) {
      fail("production_proof_readback_mismatch");
    }
    proofRecorded = true;
  }
  const result = {
    schema: "yutakasa-ticket-production-candidate-v1", workId: input.workId,
    prNumber: input.prNumber, scenarioKey: input.scenarioKey,
    regressionArtifactSha256, scenarioSha256: artifact.scenarioSha256,
    beforeFailureSha256: artifact.beforeFailureSha256,
    afterSuccessSha256: artifact.afterSuccessSha256,
    productionSuccessSha256, beforeAfterRunId: input.beforeAfterRunId,
    productionRunId: input.productionRunId, headSha: binding.headSha,
    mergeSha: binding.mergeSha, deploymentId: binding.deploymentId,
    syntheticDataCleaned: true,
    customerConditionMatched: proofRecorded,
    ticketCompletionProofRecorded: proofRecorded,
    missingProof: proofRecorded ? null : "server_attested_ticket_replay_conditions_missing",
  };
  if (typeof env.EVIDENCE_PATH === "string" && env.EVIDENCE_PATH) {
    await writeFile(env.EVIDENCE_PATH, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
  }
  return result;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runProductionCandidate().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true,
      prNumber: result.prNumber, scenarioKey: result.scenarioKey,
      syntheticDataCleaned: result.syntheticDataCleaned,
      customerConditionMatched: result.customerConditionMatched,
      ticketCompletionProofRecorded: result.ticketCompletionProofRecorded })}\n`),
    (error) => { process.stdout.write(`${JSON.stringify({ ok: false,
      code: error instanceof ProductionCandidateError ? error.code : "production_candidate_failed" })}\n`);
      process.exitCode = 1; },
  );
}
