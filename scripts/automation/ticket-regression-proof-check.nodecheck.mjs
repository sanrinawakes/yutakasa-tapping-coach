import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { decodeRegressionArtifact, findTicketRegressionProof,
  readRegressionTriggerHead, TicketRegressionProofError,
  validateRegressionEvidence } from "./ticket-regression-proof-check.mjs";

const exec = promisify(execFile);
const REPO = "sanrinawakes/yutakasa-tapping-coach";
const workId = "e1aa3fb1-afae-43b8-b139-bc0fa4682255";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const prNumber = 82;
const runId = 1234567;
const source = `test("repair-regression:${createHash("sha256").update(workId).digest("hex").slice(0, 16)}:chat_title_zero_width",()=>{});`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const artifact = { schema: "yutakasa-ticket-regression-v1", workId, prNumber,
  baseSha, headSha, scenarioKey: "chat_title_zero_width", scenarioSha256: hash(source),
  beforeFailureSha256: "c".repeat(64), afterSuccessSha256: "d".repeat(64),
  beforeAfterRunId: runId, tests: 15, productionVerified: false,
  ticketCompletionProofRecorded: false };
const run = { id: runId, status: "completed", conclusion: "success", run_attempt: 1,
  event: "workflow_run", path: ".github/workflows/ticket-repair-regression-evidence.yml",
  head_branch: "main", head_sha: baseSha, repository: { full_name: REPO } };
const listing = { total_count: 1, artifacts: [{ id: 999, name: "ticket-regression-evidence",
  expired: false, workflow_run: { id: runId, head_sha: baseSha },
  size_in_bytes: 1000, digest: `sha256:${"e".repeat(64)}` }] };
const args = { run, listing, artifact, workId, prNumber, headSha, baseSha,
  testSource: source };

test("a completed exact regression run binds immutable test source and work", () => {
  assert.deepEqual(validateRegressionEvidence(args), {
    workId, prNumber, headSha, baseSha, scenarioKey: "chat_title_zero_width",
    scenarioSha256: hash(source), beforeFailureSha256: artifact.beforeFailureSha256,
    afterSuccessSha256: artifact.afterSuccessSha256, beforeAfterRunId: runId,
    artifactSha256: hash(JSON.stringify(artifact)),
  });
  for (const change of [
    { run: { ...run, status: "in_progress" } },
    { run: { ...run, conclusion: "failure" } },
    { run: { ...run, run_attempt: 2 } },
    { run: { ...run, event: "pull_request" } },
    { listing: { ...listing, total_count: 2 } },
    { artifact: { ...artifact, workId: "423e4567-e89b-42d3-a456-426614174000" } },
    { artifact: { ...artifact, headSha: "f".repeat(40) } },
    { artifact: { ...artifact, scenarioKey: "chat_send_reload_persistence" } },
    { testSource: `${source}\nchanged` },
  ]) {
    assert.throws(() => validateRegressionEvidence({ ...args, ...change }),
      TicketRegressionProofError);
  }
});

test("artifact ZIP must contain only the expected file and match GitHub digest", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ticket-regression-test-"));
  try {
    const json = path.join(dir, "ticket-regression-evidence.json");
    const archive = path.join(dir, "evidence.zip");
    await writeFile(json, `${JSON.stringify(artifact)}\n`);
    await exec("zip", ["-q", archive, path.basename(json)], { cwd: dir });
    const bytes = await import("node:fs/promises").then((fs) => fs.readFile(archive));
    assert.deepEqual(await decodeRegressionArtifact(bytes, `sha256:${hash(bytes)}`), artifact);
    await assert.rejects(() => decodeRegressionArtifact(bytes, `sha256:${"0".repeat(64)}`),
      TicketRegressionProofError);
    await writeFile(path.join(dir, "extra.json"), "{}\n");
    await exec("zip", ["-q", archive, "extra.json"], { cwd: dir });
    const twoFiles = await import("node:fs/promises").then((fs) => fs.readFile(archive));
    await assert.rejects(() => decodeRegressionArtifact(twoFiles, `sha256:${hash(twoFiles)}`),
      TicketRegressionProofError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a trusted evidence workflow recovers the PR head from its digest-checked artifact", async () => {
  const fetchImpl = async (url) => {
    if (url.includes(`/actions/runs/${runId}/artifacts`)) return Response.json(listing);
    if (url.includes(`/actions/runs/${runId}`)) return Response.json(run);
    assert.fail(`unexpected ${url}`);
  };
  assert.deepEqual(await readRegressionTriggerHead({ runId, token: "x".repeat(40),
    fetchImpl, archiveImpl: async () => Buffer.from("zip"),
    decodeImpl: async () => artifact }), { headSha, baseSha, workId, prNumber });
});

test("promotion sees pending evidence until exact successful run and test source exist", async () => {
  const token = "x".repeat(40);
  const fetchImpl = async (url) => {
    if (url.includes("/workflows/ticket-repair-regression-evidence.yml/runs?")) {
      return Response.json({ workflow_runs: [run] });
    }
    if (url.includes(`/actions/runs/${runId}/artifacts`)) return Response.json(listing);
    if (url.includes(`/actions/runs/${runId}`)) return Response.json(run);
    if (url.includes("/contents/src/lib/chat-thread.test.ts?")) return Response.json({
      type: "file", encoding: "base64", path: "src/lib/chat-thread.test.ts",
      size: Buffer.byteLength(source), content: Buffer.from(source).toString("base64"),
    });
    assert.fail(`unexpected ${url}`);
  };
  const proof = await findTicketRegressionProof({ workId, prNumber, headSha, baseSha,
    token, fetchImpl, archiveImpl: async () => Buffer.from("zip"),
    decodeImpl: async () => artifact });
  assert.equal(proof.artifactSha256, hash(JSON.stringify(artifact)));
  const notFound = await findTicketRegressionProof({ workId, prNumber, headSha, baseSha,
    token, fetchImpl: async () => Response.json({ workflow_runs: [] }) });
  assert.equal(notFound, null);
});
