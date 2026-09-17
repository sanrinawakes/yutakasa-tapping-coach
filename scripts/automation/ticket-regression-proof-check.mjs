import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SCENARIO = "chat_title_zero_width";
const TEST_PATH = "src/lib/chat-thread.test.ts";
const ARTIFACT_NAME = "ticket-regression-evidence";
const ARTIFACT_FILE = "ticket-regression-evidence.json";
const KEYS = ["afterSuccessSha256", "baseSha", "beforeAfterRunId", "beforeFailureSha256",
  "headSha", "prNumber", "productionVerified", "scenarioKey", "scenarioSha256",
  "schema", "tests", "ticketCompletionProofRecorded", "workId"].sort().join(",");

export class TicketRegressionProofError extends Error {
  constructor(code) { super(code); this.name = "TicketRegressionProofError"; this.code = code; }
}
function fail(code) { throw new TicketRegressionProofError(code); }
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function boundedResponse(response, limit, code) {
  const declared = response.headers?.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > limit) fail(code);
  const reader = response.body?.getReader?.();
  if (!reader) fail(code);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) fail(code);
      size += next.value.byteLength;
      if (size > limit) fail(code);
      chunks.push(Buffer.from(next.value));
    }
  } catch { fail(code); }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function githubJson(suffix, token, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/${suffix}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("regression_proof_github_unavailable"));
  if (response.status !== 200) fail("regression_proof_github_unavailable");
  const bytes = await boundedResponse(response, 512 * 1024, "regression_proof_github_response_large");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail("regression_proof_github_response_invalid"); }
}

export function validateRegressionEvidence({ run, listing, artifact, workId, prNumber,
  headSha, baseSha, testSource }) {
  if (!UUID.test(workId ?? "") || !Number.isSafeInteger(prNumber) || prNumber < 1 ||
      !SHA.test(headSha ?? "") || !SHA.test(baseSha ?? "") || baseSha === headSha ||
      run?.id !== artifact?.beforeAfterRunId || run?.status !== "completed" ||
      run?.conclusion !== "success" || run?.run_attempt !== 1 ||
      !["workflow_run", "workflow_dispatch"].includes(run?.event) ||
      run?.path !== ".github/workflows/ticket-repair-regression-evidence.yml" ||
      run?.head_branch !== "main" || run?.head_sha !== baseSha ||
      run?.repository?.full_name !== REPO ||
      listing?.total_count !== 1 || !Array.isArray(listing?.artifacts) ||
      listing.artifacts.length !== 1 ||
      listing.artifacts[0]?.name !== ARTIFACT_NAME || listing.artifacts[0]?.expired !== false ||
      listing.artifacts[0]?.workflow_run?.id !== run.id ||
      listing.artifacts[0]?.workflow_run?.head_sha !== baseSha ||
      !Number.isSafeInteger(listing.artifacts[0]?.id) || listing.artifacts[0].id < 1 ||
      !Number.isSafeInteger(listing.artifacts[0]?.size_in_bytes) ||
      listing.artifacts[0].size_in_bytes < 2 || listing.artifacts[0].size_in_bytes > 16 * 1024 ||
      !/^sha256:[a-f0-9]{64}$/u.test(listing.artifacts[0]?.digest ?? "") ||
      !artifact || Object.keys(artifact).sort().join(",") !== KEYS ||
      artifact.schema !== "yutakasa-ticket-regression-v1" ||
      artifact.workId !== workId || artifact.prNumber !== prNumber ||
      artifact.baseSha !== baseSha || artifact.headSha !== headSha ||
      artifact.scenarioKey !== SCENARIO ||
      artifact.beforeAfterRunId !== run.id ||
      artifact.productionVerified !== false || artifact.ticketCompletionProofRecorded !== false ||
      !SHA256.test(artifact.scenarioSha256 ?? "") ||
      !SHA256.test(artifact.beforeFailureSha256 ?? "") ||
      !SHA256.test(artifact.afterSuccessSha256 ?? "") ||
      artifact.beforeFailureSha256 === artifact.afterSuccessSha256 ||
      !Number.isSafeInteger(artifact.tests) || artifact.tests < 1 || artifact.tests > 200 ||
      typeof testSource !== "string" || digest(testSource) !== artifact.scenarioSha256 ||
      !testSource.includes(`repair-regression:${digest(workId).slice(0, 16)}:${SCENARIO}`)) {
    fail("regression_proof_untrusted");
  }
  return { workId, prNumber, headSha, baseSha, scenarioKey: SCENARIO,
    scenarioSha256: artifact.scenarioSha256,
    beforeFailureSha256: artifact.beforeFailureSha256,
    afterSuccessSha256: artifact.afterSuccessSha256,
    beforeAfterRunId: run.id, artifactSha256: digest(JSON.stringify(artifact)) };
}

async function readArtifactArchive(id, token, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/actions/artifacts/${id}/zip`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    redirect: "manual", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("regression_proof_archive_unavailable"));
  if (response.status !== 302) fail("regression_proof_archive_redirect_invalid");
  let location;
  try { location = new URL(response.headers.get("location")); }
  catch { fail("regression_proof_archive_redirect_invalid"); }
  if (location.protocol !== "https:" ||
      !/^(?:[a-z0-9-]+\.)?(?:actions\.githubusercontent\.com|blob\.core\.windows\.net)$/u.test(location.hostname)) {
    fail("regression_proof_archive_redirect_invalid");
  }
  const archive = await fetchImpl(location, {
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("regression_proof_archive_unavailable"));
  if (archive.status !== 200) fail("regression_proof_archive_unavailable");
  return boundedResponse(archive, 16 * 1024, "regression_proof_archive_too_large");
}

export async function decodeRegressionArtifact(archive, expectedDigest) {
  if (!Buffer.isBuffer(archive) || archive.length < 2 || archive.length > 16 * 1024 ||
      expectedDigest !== `sha256:${digest(archive)}`) fail("regression_proof_archive_digest_invalid");
  const dir = await mkdtemp(path.join(tmpdir(), "ticket-regression-proof-"));
  try {
    const file = path.join(dir, "artifact.zip");
    await writeFile(file, archive, { mode: 0o600, flag: "wx" });
    const entries = await exec("unzip", ["-Z", "-1", file], { timeout: 10_000, maxBuffer: 1024 })
      .catch(() => fail("regression_proof_archive_invalid"));
    if (entries.stdout.trim() !== ARTIFACT_FILE) fail("regression_proof_archive_invalid");
    const content = await exec("unzip", ["-p", file, ARTIFACT_FILE], {
      timeout: 10_000, maxBuffer: 8 * 1024,
    }).catch(() => fail("regression_proof_archive_invalid"));
    try { return JSON.parse(content.stdout); }
    catch { fail("regression_proof_archive_invalid"); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// A regression workflow runs on main, so workflow_run.head_sha names main,
// not the tested PR. Recover the PR head only from that completed run's
// immutable, digest-checked artifact, then perform full private binding later.
export async function readRegressionTriggerHead({ runId, token,
  fetchImpl = globalThis.fetch, archiveImpl = readArtifactArchive,
  decodeImpl = decodeRegressionArtifact } = {}) {
  if (!Number.isSafeInteger(runId) || runId < 1 ||
      typeof token !== "string" || token.length < 20) fail("regression_trigger_inputs_invalid");
  const [run, listing] = await Promise.all([
    githubJson(`actions/runs/${runId}`, token, fetchImpl),
    githubJson(`actions/runs/${runId}/artifacts?name=${ARTIFACT_NAME}`, token, fetchImpl),
  ]);
  if (run?.id !== runId || run?.status !== "completed" || run?.conclusion !== "success" ||
      run?.run_attempt !== 1 ||
      !["workflow_run", "workflow_dispatch"].includes(run?.event) ||
      run?.path !== ".github/workflows/ticket-repair-regression-evidence.yml" ||
      run?.head_branch !== "main" || run?.repository?.full_name !== REPO ||
      !SHA.test(run?.head_sha ?? "") ||
      !Array.isArray(listing?.artifacts) ||
      (listing?.total_count === 0 && listing.artifacts.length !== 0)) {
    fail("regression_trigger_untrusted");
  }
  // The preparation job also succeeds for ordinary PRs, while its comparison
  // job is skipped. Such runs have no evidence artifact and must not be
  // interpreted as a failed support repair or as merge authorization.
  if (listing.total_count === 0) return null;
  if (listing.total_count !== 1 ||
      listing.artifacts.length !== 1 || listing.artifacts[0]?.name !== ARTIFACT_NAME ||
      listing.artifacts[0]?.expired !== false ||
      listing.artifacts[0]?.workflow_run?.id !== runId ||
      listing.artifacts[0]?.workflow_run?.head_sha !== run.head_sha ||
      !Number.isSafeInteger(listing.artifacts[0]?.id) || listing.artifacts[0].id < 1 ||
      !Number.isSafeInteger(listing.artifacts[0]?.size_in_bytes) ||
      listing.artifacts[0].size_in_bytes < 2 || listing.artifacts[0].size_in_bytes > 16 * 1024 ||
      !/^sha256:[a-f0-9]{64}$/u.test(listing.artifacts[0]?.digest ?? "")) {
    fail("regression_trigger_untrusted");
  }
  const bytes = await archiveImpl(listing.artifacts[0].id, token, fetchImpl);
  const artifact = await decodeImpl(bytes, listing.artifacts[0].digest);
  if (artifact?.schema !== "yutakasa-ticket-regression-v1" ||
      artifact?.beforeAfterRunId !== runId || artifact?.baseSha !== run.head_sha ||
      !SHA.test(artifact?.headSha ?? "") || artifact.headSha === artifact.baseSha ||
      artifact?.scenarioKey !== SCENARIO || !UUID.test(artifact?.workId ?? "") ||
      !Number.isSafeInteger(artifact?.prNumber) || artifact.prNumber < 1) {
    fail("regression_trigger_untrusted");
  }
  return { headSha: artifact.headSha, baseSha: artifact.baseSha,
    workId: artifact.workId, prNumber: artifact.prNumber };
}

function githubFileText(file) {
  if (file?.type !== "file" || file?.encoding !== "base64" ||
      file?.path !== TEST_PATH || typeof file?.content !== "string" ||
      file.content.length > 256 * 1024 || !/^[A-Za-z0-9+/=\n]+$/u.test(file.content) ||
      !Number.isSafeInteger(file?.size) || file.size < 1 || file.size > 180 * 1024) {
    fail("regression_proof_test_source_invalid");
  }
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length !== file.size) fail("regression_proof_test_source_invalid");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("regression_proof_test_source_invalid"); }
}

export async function findTicketRegressionProof({ workId, prNumber, headSha, baseSha,
  token, fetchImpl = globalThis.fetch, runId = null,
  archiveImpl = readArtifactArchive, decodeImpl = decodeRegressionArtifact } = {}) {
  if (!UUID.test(workId ?? "") || !Number.isSafeInteger(prNumber) || prNumber < 1 ||
      !SHA.test(headSha ?? "") || !SHA.test(baseSha ?? "") || headSha === baseSha ||
      typeof token !== "string" || token.length < 20 ||
      (runId !== null && (!Number.isSafeInteger(runId) || runId < 1))) {
    fail("regression_proof_inputs_invalid");
  }
  let runIds = runId === null ? null : [runId];
  if (runIds === null) {
    const runs = await githubJson("actions/workflows/ticket-repair-regression-evidence.yml/runs?per_page=100",
      token, fetchImpl);
    if (!Array.isArray(runs?.workflow_runs) || runs.workflow_runs.length > 100) {
      fail("regression_proof_run_list_invalid");
    }
    runIds = runs.workflow_runs.filter((run) => run?.head_sha === baseSha &&
      run?.head_branch === "main" && run?.status === "completed" &&
      run?.conclusion === "success" && run?.run_attempt === 1 &&
      ["workflow_run", "workflow_dispatch"].includes(run?.event) &&
      Number.isSafeInteger(run?.id) && run.id > 0)
      .slice(0, 10).map((run) => run.id);
    if (runIds.length === 10 && runs.workflow_runs.length === 100) {
      fail("regression_proof_run_list_ambiguous");
    }
  }
  for (const id of runIds) {
    const [run, listing] = await Promise.all([
      githubJson(`actions/runs/${id}`, token, fetchImpl),
      githubJson(`actions/runs/${id}/artifacts?name=${ARTIFACT_NAME}`, token, fetchImpl),
    ]);
    if (run?.head_sha !== baseSha || run?.status !== "completed" ||
        run?.conclusion !== "success" || !Array.isArray(listing?.artifacts) ||
        listing.artifacts.length === 0) continue;
    if (listing.total_count !== 1 || listing.artifacts.length !== 1) {
      fail("regression_proof_artifact_ambiguous");
    }
    const bytes = await archiveImpl(listing.artifacts[0].id, token, fetchImpl);
    const artifact = await decodeImpl(bytes, listing.artifacts[0].digest);
    if (artifact?.workId !== workId || artifact?.headSha !== headSha ||
        artifact?.prNumber !== prNumber) continue;
    const file = await githubJson(`contents/${TEST_PATH}?ref=${headSha}`, token, fetchImpl);
    return validateRegressionEvidence({ run, listing, artifact, workId, prNumber,
      headSha, baseSha, testSource: githubFileText(file) });
  }
  return null;
}
