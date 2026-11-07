import assert from "node:assert/strict";
import test from "node:test";

import {
  ExternalSupportEvidenceError,
  buildExternalSupportEvidence,
  buildProductionArtifact,
  buildRegressionArtifact,
  externalEvidenceDigest,
} from "./external-support-evidence.mjs";

const REPO_URL = "https://github.com/sanrinawakes/yutakasa-tapping-coach";
const now = new Date("2026-11-07T13:00:00.000Z");
const caseId = `case_${"a".repeat(32)}`;
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
const productionSha = "d".repeat(40);
const conditionDigest = "e".repeat(64);
const otherWorkId = "22222222-2222-4222-8222-222222222222";
const binding = {
  workId: "11111111-1111-4111-8111-111111111111",
  caseId,
  revision: 4,
  siteUrl: "https://yutakasa-tapping-coach.vercel.app/chat",
  conditionDigest,
};
const pullRequest = {
  number: 148,
  html_url: `${REPO_URL}/pull/148`,
  state: "closed",
  merged: true,
  merged_at: "2026-11-07T12:03:30.000Z",
  merge_commit_sha: productionSha,
  head: { sha: headSha, repo: { full_name: "sanrinawakes/yutakasa-tapping-coach" } },
  base: { ref: "main", sha: baseSha,
    repo: { full_name: "sanrinawakes/yutakasa-tapping-coach" } },
};

function run(id, sha, path, overrides = {}) {
  return {
    id,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    repository: { full_name: "sanrinawakes/yutakasa-tapping-coach" },
    path,
    html_url: `${REPO_URL}/actions/runs/${id}`,
    head_sha: sha,
    head_branch: "main",
    event: "workflow_dispatch",
    created_at: "2026-11-07T12:01:00.000Z",
    updated_at: "2026-11-07T12:03:00.000Z",
    ...overrides,
  };
}

function receipt(name, runValue, payload, archive = "f".repeat(64)) {
  return {
    run: runValue,
    listing: {
      total_count: 1,
      artifacts: [{
        id: runValue.id + 100,
        name,
        expired: false,
        size_in_bytes: 4096,
        digest: `sha256:${archive}`,
        workflow_run: { id: runValue.id, head_sha: runValue.head_sha },
      }],
    },
    archiveSha256: archive,
    payloadCanonicalSha256: externalEvidenceDigest(payload),
    payload,
  };
}

const beforeRun = run(5001, baseSha, ".github/workflows/external-support-condition.yml", {
  event: "workflow_run",
});
const beforeReceipt = {
  ...binding,
  gitSha: baseSha,
  status: "failed",
  exitCode: 1,
  tests: 3,
  clientErrorCount: 0,
  startedAt: "2026-11-07T11:50:00.000Z",
  finishedAt: "2026-11-07T11:51:00.000Z",
  result: {
    conditionDigest,
    conditionObserved: true,
    expectedOutcome: "failure",
    unexpectedErrorCount: 0,
  },
};
const headReceipt = {
  ...binding,
  gitSha: headSha,
  status: "passed",
  exitCode: 0,
  tests: 3,
  clientErrorCount: 0,
  startedAt: "2026-11-07T11:52:00.000Z",
  finishedAt: "2026-11-07T11:53:00.000Z",
  result: {
    conditionDigest,
    conditionObserved: true,
    expectedOutcome: "success",
    unexpectedErrorCount: 0,
  },
};
const beforePayload = buildRegressionArtifact({
  binding,
  workflowPath: beforeRun.path,
  runId: beforeRun.id,
  prNumber: pullRequest.number,
  baseSha,
  headSha,
  beforeReceipt,
  headReceipt,
  now,
});
const productionRun = run(5002, productionSha,
  ".github/workflows/external-support-production.yml", {
    created_at: "2026-11-07T12:04:00.000Z",
    updated_at: "2026-11-07T12:06:00.000Z",
  });
const exactProductionReceipt = {
  ...binding,
  productionSha,
  deploymentId: "dpl_Abcdefghijklmnop",
  status: "passed",
  success: true,
  dbVerified: true,
  reloadVerified: true,
  cleanupVerified: true,
  clientErrorCount: 0,
  startedAt: "2026-11-07T12:04:00.000Z",
  finishedAt: "2026-11-07T12:05:00.000Z",
  result: {
    conditionDigest,
    conditionObserved: true,
    unexpectedErrorCount: 0,
    databaseRowsAfterCleanup: 0,
  },
};
const productionPayload = buildProductionArtifact({
  binding,
  workflowPath: productionRun.path,
  runId: productionRun.id,
  productionSha,
  deploymentId: exactProductionReceipt.deploymentId,
  productionReceipt: exactProductionReceipt,
  now,
});
const observations = ["2026-11-07T12:10:00.000Z", "2026-11-07T12:20:00.000Z",
  "2026-11-07T12:30:00.000Z"].map((at) => ({
    at,
    success: true,
    ...binding,
    productionSha,
    deploymentId: productionPayload.deploymentId,
    clientErrorCount: 0,
  }));

function valid(overrides = {}) {
  return {
    binding,
    pullRequest,
    beforeHeadReceipt: receipt("external-support-before-head", beforeRun, beforePayload),
    productionReceipt: receipt("external-support-production", productionRun, productionPayload,
      "3".repeat(64)),
    observations,
    verifiedAt: "2026-11-07T12:31:00.000Z",
    now,
    ...overrides,
  };
}

function fails(input, code) {
  assert.throws(() => buildExternalSupportEvidence(input), (error) =>
    error instanceof ExternalSupportEvidenceError && error.code === code);
}

test("builds the ledger completion shape only after distinct bound witnesses", () => {
  const evidence = buildExternalSupportEvidence(valid());
  assert.deepEqual(evidence, {
    ...binding,
    productionSha,
    deploymentId: productionPayload.deploymentId,
    prUrl: pullRequest.html_url,
    prMergeSha: productionSha,
    ciRunUrl: productionRun.html_url,
    ciStatus: "success",
    ciSha: productionSha,
    verifiedAt: "2026-11-07T12:31:00.000Z",
    dbVerified: true,
    reloadVerified: true,
    cleanupVerified: true,
    clientErrorCount: 0,
    observations,
  });
});

test("trusted runner helpers bind private receipts without copying their raw results", () => {
  for (const payload of [beforePayload, productionPayload]) {
    const publicJSON = JSON.stringify(payload);
    for (const privateValue of [caseId, binding.siteUrl, conditionDigest,
      'caseId', 'revision', 'siteUrl', 'conditionDigest', 'expectedOutcome',
      'databaseRowsAfterCleanup']) assert.equal(publicJSON.includes(privateValue), false);
    assert.equal(payload.workId, binding.workId);
  }
  const publicOnly = { workId: binding.workId };
  const privateFields = { caseId: 'private-case-secret', body: 'private customer original',
    recipient: 'private@example.invalid', conditionDigest: 'private-condition-secret' };
  assert.deepEqual(buildRegressionArtifact({
    binding: publicOnly, workflowPath: beforeRun.path, runId: beforeRun.id,
    prNumber: pullRequest.number, baseSha, headSha,
    beforeReceipt: { ...beforeReceipt, ...privateFields,
      result: { ...beforeReceipt.result, ...privateFields } },
    headReceipt: { ...headReceipt, ...privateFields,
      result: { ...headReceipt.result, ...privateFields } }, now,
  }), beforePayload);
  assert.deepEqual(buildProductionArtifact({
    binding: publicOnly, workflowPath: productionRun.path, runId: productionRun.id,
    productionSha, deploymentId: exactProductionReceipt.deploymentId,
    productionReceipt: { ...exactProductionReceipt, ...privateFields,
      result: { ...exactProductionReceipt.result, ...privateFields } }, now,
  }), productionPayload);
  assert.notEqual(beforePayload.beforeSha256, externalEvidenceDigest(beforeReceipt));
  assert.notEqual(productionPayload.resultSha256, externalEvidenceDigest(exactProductionReceipt));
});

test("regression producer rejects a passing base or failing PR head receipt", () => {
  for (const [before, head] of [
    [{ ...beforeReceipt, status: "passed", exitCode: 0 }, headReceipt],
    [beforeReceipt, { ...headReceipt, status: "failed", exitCode: 1 }],
    [beforeReceipt, { ...headReceipt, clientErrorCount: 1 }],
    [{ ...beforeReceipt, workId: otherWorkId }, headReceipt],
    [{ ...beforeReceipt, result: { ...beforeReceipt.result,
      expectedOutcome: "success" } }, headReceipt],
  ]) {
    assert.throws(() => buildRegressionArtifact({
      binding, workflowPath: beforeRun.path, runId: beforeRun.id,
      prNumber: pullRequest.number, baseSha, headSha,
      beforeReceipt: before, headReceipt: head, now,
    }), (error) => error instanceof ExternalSupportEvidenceError &&
      error.code === "external_evidence_runner_receipt_invalid");
  }
});

test("production producer rejects generic or incomplete functional receipts", () => {
  for (const patch of [
    { workId: otherWorkId },
    { productionSha: "9".repeat(40) },
    { status: "failed", success: false },
    { dbVerified: false },
    { reloadVerified: false },
    { cleanupVerified: false },
    { clientErrorCount: 1 },
    { result: null },
    { result: { ...exactProductionReceipt.result, conditionObserved: false } },
    { result: { ...exactProductionReceipt.result, databaseRowsAfterCleanup: 1 } },
  ]) {
    assert.throws(() => buildProductionArtifact({
      binding, workflowPath: productionRun.path, runId: productionRun.id,
      productionSha, deploymentId: exactProductionReceipt.deploymentId,
      productionReceipt: { ...exactProductionReceipt, ...patch }, now,
    }), (error) => error instanceof ExternalSupportEvidenceError &&
      error.code === "external_evidence_runner_receipt_invalid");
  }
});

test("a generic one-shot receipt cannot replace condition-bound before and head proof", () => {
  const generic = {
    ok: true,
    mainSha: productionSha,
    deploymentId: productionPayload.deploymentId,
    desktopBrowser: true,
    mobileBrowser: true,
    supportTicketCreated: true,
    supportQueueIsolated: true,
    testDataCleaned: true,
  };
  fails(valid({ beforeHeadReceipt: generic }), "external_evidence_before_head_invalid");
  fails(valid({ productionReceipt: { run: productionRun, payload: generic } }),
    "external_evidence_production_invalid");
});

test("public artifacts reject private case, revision, site and condition fields", () => {
  for (const patch of [
    { caseId: `case_${"9".repeat(32)}` },
    { revision: binding.revision + 1 },
    { siteUrl: "https://example.invalid/chat" },
    { conditionDigest: "9".repeat(64) },
  ]) {
    const payload = { ...beforePayload, ...patch };
    fails(valid({ beforeHeadReceipt: receipt("external-support-before-head", beforeRun, payload) }),
      "external_evidence_before_head_invalid");
    const production = { ...productionPayload, ...patch };
    fails(valid({ productionReceipt: receipt("external-support-production", productionRun,
      production, "3".repeat(64)) }), "external_evidence_production_invalid");
  }
});

test("public work ID mismatch or legacy private artifact cannot complete a case", () => {
  for (const patch of [{ workId: otherWorkId }, { workId: 'not-a-uuid' },
    { schema: 'yutakasa-external-support-before-head-v1' }]) {
    fails(valid({ beforeHeadReceipt: receipt('external-support-before-head', beforeRun,
      { ...beforePayload, ...patch }) }), 'external_evidence_before_head_invalid');
  }
  for (const patch of [{ workId: otherWorkId }, { workId: 'not-a-uuid' },
    { schema: 'yutakasa-external-support-production-v1' }]) {
    fails(valid({ productionReceipt: receipt('external-support-production', productionRun,
      { ...productionPayload, ...patch }, '3'.repeat(64)) }),
    'external_evidence_production_invalid');
  }
  fails(valid({ binding: { ...binding, workId: otherWorkId } }),
    'external_evidence_before_head_invalid');
  fails(valid({ binding: { ...binding, workId: '11111111-1111-1111-8111-111111111111' } }),
    'external_evidence_binding_invalid');
  fails(valid({ observations: observations.map((row, index) => index === 2
    ? { ...row, workId: otherWorkId } : row) }), 'external_evidence_observations_invalid');
});

test("artifact listing digest and decoded canonical payload must agree", () => {
  const wrongArchive = valid().beforeHeadReceipt;
  wrongArchive.archiveSha256 = "8".repeat(64);
  fails(valid({ beforeHeadReceipt: wrongArchive }), "external_evidence_before_head_invalid");

  const wrongPayload = valid().beforeHeadReceipt;
  wrongPayload.payloadCanonicalSha256 = "7".repeat(64);
  fails(valid({ beforeHeadReceipt: wrongPayload }), "external_evidence_before_head_invalid");
});

test("before must fail and the exact PR head must pass with distinct witnesses", () => {
  for (const patch of [
    { beforeStatus: "passed" },
    { headStatus: "failed" },
    { headSha: "6".repeat(40) },
    { baseSha: "6".repeat(40) },
    { headSha256: beforePayload.beforeSha256 },
  ]) {
    const payload = { ...beforePayload, ...patch };
    fails(valid({ beforeHeadReceipt: receipt("external-support-before-head", beforeRun, payload) }),
      "external_evidence_before_head_invalid");
  }
});

test("production proof requires merge SHA, deployment, DB, reload, cleanup and zero errors", () => {
  for (const patch of [
    { productionSha: "7".repeat(40) },
    { deploymentId: "invalid" },
    { dbVerified: false },
    { reloadVerified: false },
    { cleanupVerified: false },
    { clientErrorCount: 1 },
  ]) {
    const payload = { ...productionPayload, ...patch };
    fails(valid({ productionReceipt: receipt("external-support-production", productionRun,
      payload, "3".repeat(64)) }), "external_evidence_production_invalid");
  }
});

test("the before/head and production witnesses must be separate GitHub runs", () => {
  const payload = { ...productionPayload, runId: beforeRun.id,
    workflowPath: beforeRun.path, productionSha: beforeRun.head_sha,
    observedAt: "2026-11-07T12:02:30.000Z" };
  const reused = receipt("external-support-production", beforeRun, payload, "3".repeat(64));
  const pr = { ...pullRequest, merge_commit_sha: beforeRun.head_sha,
    merged_at: "2026-11-07T12:00:00.000Z" };
  fails(valid({ pullRequest: pr, productionReceipt: reused }),
    "external_evidence_run_reuse_forbidden");
});

test("three exact observations must span twenty minutes in ten-minute steps", () => {
  fails(valid({ observations: observations.slice(0, 2) }),
    "external_evidence_observations_invalid");
  fails(valid({ observations: observations.map((row, index) => index === 1
    ? { ...row, at: "2026-11-07T12:19:59.999Z" } : row) }),
  "external_evidence_observations_invalid");
  fails(valid({ observations: observations.map((row, index) => index === 2
    ? { ...row, conditionDigest: "4".repeat(64) } : row) }),
  "external_evidence_observations_invalid");
});

test("verification time cannot precede the last observation or be in the future", () => {
  fails(valid({ verifiedAt: "2026-11-07T12:29:59.999Z" }),
    "external_evidence_time_invalid");
  fails(valid({ verifiedAt: "2026-11-07T13:00:31.000Z" }),
    "external_evidence_time_invalid");
});

test("impossible calendar timestamps are rejected", () => {
  fails(valid({ verifiedAt: "2026-02-30T12:31:00.000Z" }),
    "external_evidence_time_invalid");
});
