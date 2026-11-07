import { createHash } from "node:crypto";

const REPOSITORY = "sanrinawakes/yutakasa-tapping-coach";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DEPLOYMENT = /^dpl_[A-Za-z0-9]{8,160}$/u;
const CASE_ID = /^case_[a-f0-9]{32}$/u;
const WORK_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const BEFORE_HEAD_ARTIFACT = "external-support-before-head";
const PRODUCTION_ARTIFACT = "external-support-production";
const BEFORE_HEAD_KEYS = [
  "baseSha", "beforeSha256", "beforeStatus", "headSha", "headSha256",
  "headStatus", "prNumber", "runId", "schema", "tests", "workId", "workflowPath",
].sort().join(",");
const PRODUCTION_KEYS = [
  "cleanupVerified", "clientErrorCount", "dbVerified", "deploymentId", "observedAt",
  "productionSha", "reloadVerified", "resultSha256", "runId", "schema", "success",
  "workId", "workflowPath",
].sort().join(",");

export class ExternalSupportEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "ExternalSupportEvidenceError";
    this.code = code;
  }
}
function fail(code) {
  throw new ExternalSupportEvidenceError(code);
}

function canonical(value, depth = 0) {
  if (depth > 12) fail("external_evidence_artifact_invalid");
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonical(value[key], depth + 1)]));
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null ||
      Number.isSafeInteger(value)) return value;
  fail("external_evidence_artifact_invalid");
}

export function externalEvidenceDigest(value) {
  let serialized;
  try { serialized = JSON.stringify(canonical(value)); }
  catch { fail("external_evidence_artifact_invalid"); }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 128 * 1024) {
    fail("external_evidence_artifact_invalid");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function time(value, code) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) fail(code);
  const parsed = Date.parse(value);
  const canonical = new Date(parsed).toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) fail(code);
  return parsed;
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys;
}

function checkedSite(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        url.toString() !== value) fail("external_evidence_binding_invalid");
  } catch {
    fail("external_evidence_binding_invalid");
  }
  return value;
}

function checkedBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      !WORK_UUID.test(binding.workId ?? "") ||
      !CASE_ID.test(binding.caseId ?? "") ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 1 ||
      !SHA256.test(binding.conditionDigest ?? "")) {
    fail("external_evidence_binding_invalid");
  }
  return {
    workId: binding.workId,
    caseId: binding.caseId,
    revision: binding.revision,
    siteUrl: checkedSite(binding.siteUrl),
    conditionDigest: binding.conditionDigest,
  };
}
function sameBinding(payload, binding) {
  return samePublicBinding(payload, binding) && payload?.caseId === binding.caseId &&
    payload?.revision === binding.revision &&
    payload?.siteUrl === binding.siteUrl &&
    payload?.conditionDigest === binding.conditionDigest;
}
function checkedPublicBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      !WORK_UUID.test(binding.workId ?? "")) fail("external_evidence_binding_invalid");
  return { workId: binding.workId };
}
function samePublicBinding(payload, binding) {
  return payload?.workId === binding.workId;
}

function checkedWorkflowProducer({ workflowPath, runId }) {
  if (!WORKFLOW_PATH.test(workflowPath ?? "") ||
      !Number.isSafeInteger(runId) || runId < 1) {
    fail("external_evidence_producer_invalid");
  }
}

function checkedWitnessReceipt(receipt, binding, sha, status, nowMs) {
  if (!receipt || !samePublicBinding(receipt, binding) || receipt.gitSha !== sha ||
      receipt.status !== status || !Number.isSafeInteger(receipt.exitCode) ||
      (status === "failed" ? receipt.exitCode === 0 : receipt.exitCode !== 0) ||
      !Number.isSafeInteger(receipt.tests) || receipt.tests < 1 || receipt.tests > 500 ||
      !Number.isSafeInteger(receipt.clientErrorCount) || receipt.clientErrorCount < 0 ||
      (status === "passed" && receipt.clientErrorCount !== 0) ||
      !receipt.result || typeof receipt.result !== "object" || Array.isArray(receipt.result) ||
      receipt.result.conditionObserved !== true ||
      receipt.result.unexpectedErrorCount !== 0 ||
      receipt.result.expectedOutcome !== (status === "failed" ? "failure" : "success")) {
    fail("external_evidence_runner_receipt_invalid");
  }
  const started = time(receipt.startedAt, "external_evidence_runner_receipt_invalid");
  const finished = time(receipt.finishedAt, "external_evidence_runner_receipt_invalid");
  if (started > finished || finished > nowMs + 30_000) {
    fail("external_evidence_runner_receipt_invalid");
  }
  // Hash only this public technical witness. Private fields or their hashes must
  // not become part of a GitHub artifact, even if present in a local receipt.
  const witness = {
    workId: binding.workId, gitSha: sha, status, exitCode: receipt.exitCode,
    tests: receipt.tests, clientErrorCount: receipt.clientErrorCount,
    startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
    result: { conditionObserved: true, expectedOutcome: receipt.result.expectedOutcome,
      unexpectedErrorCount: 0 },
  };
  return { receipt, started, finished, digest: externalEvidenceDigest(witness) };
}

/**
 * Called by a trusted condition runner after it has executed the same bounded
 * bounded synthetic condition against the exact PR base and head. The runner
 * receives only the random work ID. The case, revision, site and customer condition
 * mapping remains local; raw or privately derived hashes are never published.
 */
export function buildRegressionArtifact({
  binding, workflowPath, runId, prNumber, baseSha, headSha,
  beforeReceipt, headReceipt, now = new Date(),
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("external_evidence_time_invalid");
  }
  const checked = checkedPublicBinding(binding);
  checkedWorkflowProducer({ workflowPath, runId });
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 ||
      !SHA.test(baseSha ?? "") || !SHA.test(headSha ?? "") || baseSha === headSha) {
    fail("external_evidence_producer_invalid");
  }
  const before = checkedWitnessReceipt(
    beforeReceipt, checked, baseSha, "failed", now.getTime(),
  );
  const head = checkedWitnessReceipt(
    headReceipt, checked, headSha, "passed", now.getTime(),
  );
  if (before.receipt.tests !== head.receipt.tests ||
      before.finished > head.started || before.digest === head.digest) {
    fail("external_evidence_runner_receipt_invalid");
  }
  return {
    schema: "yutakasa-external-support-before-head-v2",
    workflowPath,
    runId,
    ...checked,
    prNumber,
    baseSha,
    headSha,
    beforeStatus: "failed",
    headStatus: "passed",
    beforeSha256: before.digest,
    headSha256: head.digest,
    tests: head.receipt.tests,
  };
}

/**
 * Called only after an exact-condition production runner has persisted and
 * reloaded its synthetic data, removed it, and observed zero client errors.
 */
export function buildProductionArtifact({
  binding, workflowPath, runId, productionSha, deploymentId,
  productionReceipt, now = new Date(),
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("external_evidence_time_invalid");
  }
  const checked = checkedPublicBinding(binding);
  checkedWorkflowProducer({ workflowPath, runId });
  if (!SHA.test(productionSha ?? "") || !DEPLOYMENT.test(deploymentId ?? "") ||
      !productionReceipt || !samePublicBinding(productionReceipt, checked) ||
      productionReceipt.productionSha !== productionSha ||
      productionReceipt.deploymentId !== deploymentId ||
      productionReceipt.status !== "passed" || productionReceipt.success !== true ||
      productionReceipt.dbVerified !== true || productionReceipt.reloadVerified !== true ||
      productionReceipt.cleanupVerified !== true || productionReceipt.clientErrorCount !== 0 ||
      !productionReceipt.result || typeof productionReceipt.result !== "object" ||
      Array.isArray(productionReceipt.result) ||
      productionReceipt.result.conditionObserved !== true ||
      productionReceipt.result.unexpectedErrorCount !== 0 ||
      productionReceipt.result.databaseRowsAfterCleanup !== 0) {
    fail("external_evidence_runner_receipt_invalid");
  }
  const started = time(
    productionReceipt.startedAt, "external_evidence_runner_receipt_invalid",
  );
  const finished = time(
    productionReceipt.finishedAt, "external_evidence_runner_receipt_invalid",
  );
  if (started > finished || finished > now.getTime() + 30_000) {
    fail("external_evidence_runner_receipt_invalid");
  }
  return {
    schema: "yutakasa-external-support-production-v2",
    workflowPath,
    runId,
    ...checked,
    productionSha,
    deploymentId,
    observedAt: productionReceipt.finishedAt,
    success: true,
    dbVerified: true,
    reloadVerified: true,
    cleanupVerified: true,
    clientErrorCount: 0,
    resultSha256: externalEvidenceDigest({
      workId: checked.workId, productionSha, deploymentId, status: "passed", success: true,
      dbVerified: true, reloadVerified: true, cleanupVerified: true, clientErrorCount: 0,
      startedAt: productionReceipt.startedAt, finishedAt: productionReceipt.finishedAt,
      result: { conditionObserved: true, unexpectedErrorCount: 0, databaseRowsAfterCleanup: 0 },
    }),
  };
}

function checkedRun(run, nowMs, code) {
  if (!run || !Number.isSafeInteger(run.id) || run.id < 1 ||
      run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== 1 ||
      run.repository?.full_name !== REPOSITORY ||
      !WORKFLOW_PATH.test(run.path ?? "") ||
      run.html_url !== `${REPOSITORY_URL}/actions/runs/${run.id}` ||
      !SHA.test(run.head_sha ?? "") ||
      time(run.created_at, code) > time(run.updated_at, code) ||
      time(run.updated_at, code) > nowMs + 30_000) fail(code);
  return run;
}

function checkedArtifactReceipt(receipt, expectedName, nowMs, code) {
  const run = checkedRun(receipt?.run, nowMs, code);
  const listing = receipt?.listing;
  const payload = receipt?.payload;
  const record = listing?.artifacts?.[0];
  if (listing?.total_count !== 1 || !Array.isArray(listing?.artifacts) ||
      listing.artifacts.length !== 1 || record?.name !== expectedName ||
      record?.expired !== false || !Number.isSafeInteger(record?.id) || record.id < 1 ||
      !Number.isSafeInteger(record?.size_in_bytes) || record.size_in_bytes < 2 ||
      record.size_in_bytes > 128 * 1024 ||
      record?.workflow_run?.id !== run.id || record.workflow_run?.head_sha !== run.head_sha ||
      !SHA256.test(receipt?.archiveSha256 ?? "") ||
      record.digest !== `sha256:${receipt.archiveSha256}` ||
      !SHA256.test(receipt?.payloadCanonicalSha256 ?? "") ||
      externalEvidenceDigest(payload) !== receipt.payloadCanonicalSha256) fail(code);
  return { run, payload };
}

function checkedPullRequest(pullRequest, nowMs) {
  if (!pullRequest || !Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 ||
      pullRequest.html_url !== `${REPOSITORY_URL}/pull/${pullRequest.number}` ||
      pullRequest.state !== "closed" || pullRequest.merged !== true ||
      !SHA.test(pullRequest.head?.sha ?? "") ||
      !SHA.test(pullRequest.base?.sha ?? "") ||
      !SHA.test(pullRequest.merge_commit_sha ?? "") ||
      pullRequest.head.sha === pullRequest.merge_commit_sha ||
      pullRequest.head?.repo?.full_name !== REPOSITORY ||
      pullRequest.base?.repo?.full_name !== REPOSITORY || pullRequest.base?.ref !== "main" ||
      time(pullRequest.merged_at, "external_evidence_pr_invalid") > nowMs + 30_000) {
    fail("external_evidence_pr_invalid");
  }
  return pullRequest;
}

function checkedBeforeHead(receipt, binding, pullRequest, nowMs) {
  const { run, payload } = checkedArtifactReceipt(
    receipt, BEFORE_HEAD_ARTIFACT, nowMs, "external_evidence_before_head_invalid",
  );
  if (!exactKeys(payload, BEFORE_HEAD_KEYS) ||
      payload.schema !== "yutakasa-external-support-before-head-v2" ||
      payload.workflowPath !== run.path || payload.runId !== run.id ||
      !["pull_request", "workflow_dispatch", "workflow_run"].includes(run.event) ||
      !samePublicBinding(payload, binding) || payload.prNumber !== pullRequest.number ||
      !SHA.test(payload.baseSha ?? "") || payload.baseSha !== pullRequest.base.sha ||
      payload.baseSha === payload.headSha ||
      payload.headSha !== pullRequest.head.sha ||
      ![payload.baseSha, payload.headSha].includes(run.head_sha) ||
      payload.beforeStatus !== "failed" || payload.headStatus !== "passed" ||
      !SHA256.test(payload.beforeSha256 ?? "") || !SHA256.test(payload.headSha256 ?? "") ||
      payload.beforeSha256 === payload.headSha256 ||
      !Number.isSafeInteger(payload.tests) || payload.tests < 1 || payload.tests > 500) {
    fail("external_evidence_before_head_invalid");
  }
  return payload;
}

function checkedProduction(receipt, binding, pullRequest, nowMs) {
  const { run, payload } = checkedArtifactReceipt(
    receipt, PRODUCTION_ARTIFACT, nowMs, "external_evidence_production_invalid",
  );
  const observedAt = time(payload?.observedAt, "external_evidence_production_invalid");
  if (!exactKeys(payload, PRODUCTION_KEYS) ||
      payload.schema !== "yutakasa-external-support-production-v2" ||
      payload.workflowPath !== run.path || payload.runId !== run.id ||
      !samePublicBinding(payload, binding) || payload.success !== true ||
      payload.productionSha !== pullRequest.merge_commit_sha ||
      run.head_branch !== "main" || run.head_sha !== payload.productionSha ||
      !["push", "workflow_dispatch", "workflow_run"].includes(run.event) ||
      !DEPLOYMENT.test(payload.deploymentId ?? "") ||
      !SHA256.test(payload.resultSha256 ?? "") ||
      payload.dbVerified !== true || payload.reloadVerified !== true ||
      payload.cleanupVerified !== true || payload.clientErrorCount !== 0 ||
      observedAt < time(pullRequest.merged_at, "external_evidence_pr_invalid") ||
      observedAt < time(run.created_at, "external_evidence_production_invalid") ||
      observedAt > time(run.updated_at, "external_evidence_production_invalid") + 30_000) {
    fail("external_evidence_production_invalid");
  }
  return { run, payload, observedAt };
}

function checkedObservations(observations, binding, production, nowMs) {
  if (!Array.isArray(observations) || observations.length !== 3) {
    fail("external_evidence_observations_invalid");
  }
  let previous = -Infinity;
  const normalized = observations.map((observation) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation) ||
        observation.success !== true || !sameBinding(observation, binding) ||
        observation.productionSha !== production.payload.productionSha ||
        observation.deploymentId !== production.payload.deploymentId ||
        observation.clientErrorCount !== 0) fail("external_evidence_observations_invalid");
    const at = time(observation.at, "external_evidence_observations_invalid");
    if (at < production.observedAt || at > nowMs + 30_000 || at - previous < 600_000) {
      fail("external_evidence_observations_invalid");
    }
    previous = at;
    return {
      at: observation.at, success: true, workId: binding.workId, caseId: binding.caseId,
      revision: binding.revision, siteUrl: binding.siteUrl,
      conditionDigest: binding.conditionDigest,
      productionSha: production.payload.productionSha,
      deploymentId: production.payload.deploymentId, clientErrorCount: 0,
    };
  });
  if (time(normalized[2].at, "external_evidence_observations_invalid") -
      time(normalized[0].at, "external_evidence_observations_invalid") < 1_200_000) {
    fail("external_evidence_observations_invalid");
  }
  return normalized;
}

/**
 * Build only from primary GitHub run metadata and digest-checked artifact receipts.
 * The caller that decodes each archive must provide the SHA-256 of the exact archive
 * and the canonical SHA-256 of its single JSON payload. A generic production smoke
 * has no before/head or work-bound artifact and therefore cannot satisfy this API.
 * `binding` must come from the local ledger's readWorkBinding(workId), not GitHub.
 * This pure consumer cannot authenticate claimed API data, archive bytes, runner
 * execution, or observation booleans. Its caller must fetch and attest those facts.
 */
export function buildExternalSupportEvidence({
  binding, pullRequest, beforeHeadReceipt, productionReceipt, observations,
  verifiedAt, now = new Date(),
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("external_evidence_time_invalid");
  }
  const nowMs = now.getTime();
  const checked = checkedBinding(binding);
  const pr = checkedPullRequest(pullRequest, nowMs);
  const beforeHead = checkedBeforeHead(beforeHeadReceipt, checked, pr, nowMs);
  const production = checkedProduction(productionReceipt, checked, pr, nowMs);
  if (beforeHeadReceipt.run.id === production.run.id) {
    fail("external_evidence_run_reuse_forbidden");
  }
  if (time(beforeHeadReceipt.run.updated_at, "external_evidence_before_head_invalid") >
      time(pr.merged_at, "external_evidence_pr_invalid") ||
      time(pr.merged_at, "external_evidence_pr_invalid") >
        time(production.run.created_at, "external_evidence_production_invalid") ||
      beforeHead.headSha !== pr.head.sha) {
    fail("external_evidence_release_order_invalid");
  }
  const normalizedObservations = checkedObservations(observations, checked, production, nowMs);
  const verifiedMs = time(verifiedAt, "external_evidence_time_invalid");
  if (verifiedMs < time(normalizedObservations[2].at, "external_evidence_time_invalid") ||
      verifiedMs > nowMs + 30_000) fail("external_evidence_time_invalid");

  return {
    workId: checked.workId,
    caseId: checked.caseId,
    revision: checked.revision,
    siteUrl: checked.siteUrl,
    conditionDigest: checked.conditionDigest,
    productionSha: production.payload.productionSha,
    deploymentId: production.payload.deploymentId,
    prUrl: pr.html_url,
    prMergeSha: pr.merge_commit_sha,
    ciRunUrl: production.run.html_url,
    ciStatus: "success",
    ciSha: production.run.head_sha,
    verifiedAt,
    dbVerified: true,
    reloadVerified: true,
    cleanupVerified: true,
    clientErrorCount: 0,
    observations: normalizedObservations,
  };
}
