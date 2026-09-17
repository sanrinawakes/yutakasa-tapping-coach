#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertNoCustomerLeak, runTicketRepairInvestigation } from "./ticket-repair-investigate.mjs";
import { parseProposal, validatePatch } from "./ai-repair-publish.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SOURCE = "src/lib/chat-thread.ts";
const TEST = "src/lib/chat-thread.test.ts";
const ORIGINAL = "if (characters.length <= AUTO_TITLE_VISIBLE_LENGTH) return normalized;";
const SEEDED = "if (characters.length < AUTO_TITLE_VISIBLE_LENGTH) return normalized;";
const SHA = /^[a-f0-9]{40}$/u;

export class TerraPatchStagingError extends Error {
  constructor(code) { super(code); this.name = "TerraPatchStagingError"; this.code = code; }
}
function fail(code) { throw new TerraPatchStagingError(code); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function command(binary, args, cwd, options = {}) {
  try {
    return execFileSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024,
      timeout: 180_000, stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
  } catch { fail("staging_command_failed"); }
}
function git(args, cwd) { return command("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd); }
function linkModules(from, to) {
  fs.mkdirSync(to);
  for (const name of fs.readdirSync(from)) {
    fs.symlinkSync(path.join(from, name), path.join(to, name));
  }
}

export function checkStagingGate(env, mainSha, branch, clean) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      env.YUTAKASA_TERRA_PATCH_STAGING_ENABLED !== "true" ||
      env.YUTAKASA_TICKET_REPAIR_ENABLED !== "false" ||
      env.YUTAKASA_AUTO_MERGE_ENABLED !== "false" ||
      !SHA.test(mainSha) || env.GITHUB_SHA !== mainSha ||
      !["main", ""].includes(branch) || !clean ||
      !/^[1-9][0-9]{0,17}$/u.test(env.GITHUB_RUN_ID ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))) {
    fail("staging_gate_closed");
  }
}

export function seedKnownDefect(source) {
  if (source.split(ORIGINAL).length !== 2 || source.includes(SEEDED)) {
    fail("staging_seed_source_changed");
  }
  return source.replace(ORIGINAL, SEEDED);
}

export function validateStagingPatch(proposal, stagingRoot, context) {
  const parsed = parseProposal(JSON.stringify(proposal));
  if (!parsed.patch.trim()) fail("staging_model_did_not_patch");
  const files = validatePatch(parsed.patch, stagingRoot).sort();
  if (JSON.stringify(files) !== JSON.stringify([SOURCE, TEST].sort())) {
    fail("staging_patch_scope_invalid");
  }
  assertNoCustomerLeak(parsed, context);
  return parsed;
}

function reportFrom(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > 512 * 1024) fail("staging_report_too_large");
  let result;
  try { result = JSON.parse(raw); } catch { fail("staging_report_invalid"); }
  if (!Array.isArray(result?.testResults) || result.testResults.length !== 1 ||
      !Array.isArray(result.testResults[0]?.assertionResults) ||
      result.testResults[0].assertionResults.length < 1 ||
      result.numPendingTests !== 0 || result.numTodoTests !== 0) fail("staging_report_invalid");
  return result;
}

export function checkBeforeAfter(before, after) {
  const assertions = (report) => report.testResults[0].assertionResults;
  const a = assertions(before);
  const b = assertions(after);
  const names = (items) => items.map((item) => item.fullName ?? item.title);
  if (before.success !== false || after.success !== true ||
      a.filter((item) => item.status === "failed").length !== 1 ||
      b.some((item) => item.status !== "passed") ||
      JSON.stringify(names(a)) !== JSON.stringify(names(b)) ||
      new Set(names(b)).size !== b.length ||
      names(b).some((name) => typeof name !== "string" || !name.trim()) ||
      b.length < 10) fail("staging_regression_not_reproduced_and_fixed");
  return { tests: b.length, failuresBefore: 1, failuresAfter: 0 };
}

function runVitest(root, reportFile, allowFailure) {
  const env = { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), CI: "true",
    NODE_ENV: "test", TZ: "UTC" };
  let failed = false;
  try {
    execFileSync(path.join(root, "node_modules/.bin/vitest"),
      ["run", TEST, "--reporter=json", `--outputFile=${reportFile}`, "--maxWorkers=2"],
      { cwd: root, env, maxBuffer: 512 * 1024, timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"] });
  } catch { failed = true; }
  if (failed !== allowFailure) fail("staging_vitest_exit_unexpected");
  return reportFrom(reportFile);
}

function runOracle(root, expectedCorrect) {
  const program = [
    `import { createChatTitle } from './${SOURCE}';`,
    "const actual = createChatTitle('あ'.repeat(21));",
    `if ((actual === 'あ'.repeat(21)) !== ${expectedCorrect}) process.exit(1);`,
  ].join("\n");
  command("node", ["--import", "tsx", "--input-type=module", "-e", program], root,
    { env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), NODE_ENV: "test" } });
}

function syntheticContext(workId) {
  return {
    work_id: workId, ticket_id: crypto.randomUUID(), latest_user_message_id: crypto.randomUUID(),
    category: "technical", subject: "二十一文字の表題",
    messages: [{ id: "", sender_type: "user", body: "入力が二十一文字のときだけ末尾に省略記号が付きます。",
      created_at: "2026-09-17T00:00:00Z" }],
  };
}

function mockPrivateApis(context, workId, mainSha, runId, realFetch) {
  const id = hash(workId).slice(0, 16);
  let lookupCount = 0;
  let openAiCalls = 0;
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target === "https://api.openai.com/v1/responses") {
      openAiCalls += 1;
      const response = await realFetch(url, init);
      if (response.status === 200) {
        const result = await response.clone().json().catch(() => null);
        if (!/^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/u.test(result?.model ?? "") ||
            result?.status !== "completed" ||
            !Number.isSafeInteger(result?.usage?.total_tokens)) fail("staging_terra_response_invalid");
      }
      return response;
    }
    if (target === "https://fixture.supabase.co/rest/v1/rpc/claim_yutakasa_ticket_repair_context") {
      assert.deepEqual(JSON.parse(init.body), { p_work_id: workId,
        p_run_id: Number(runId) });
      return new Response(JSON.stringify(context), { status: 200 });
    }
    if (target.startsWith(`https://api.github.com/repos/${REPO}/pulls?`)) {
      lookupCount += 1;
      const rows = lookupCount === 1 ? [] : [{ number: 1, state: "open",
        title: `Yutakasa support repair ${id}`,
        head: { ref: `codex/yutakasa-support-ai-${id}`, sha: mainSha,
          repo: { full_name: REPO } }, base: { ref: "main" } }];
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (target === "https://fixture.supabase.co/rest/v1/rpc/link_yutakasa_ticket_repair_pr") {
      assert.deepEqual(JSON.parse(init.body), { p_work_id: workId,
        p_run_id: Number(runId), p_pr_number: 1, p_head_sha: mainSha });
      return new Response(JSON.stringify([{ pr_number: 1, head_sha: mainSha }]), { status: 200 });
    }
    fail("staging_unexpected_network_target");
  };
  return { fetchImpl, metrics: () => ({ openAiCalls, lookupCount }) };
}

function trustedMain(env, root) {
  const mainSha = git(["rev-parse", "HEAD"], root);
  checkStagingGate(env, mainSha, git(["branch", "--show-current"], root),
    git(["status", "--porcelain"], root) === "");
  return mainSha;
}

async function withSeededStage(root, mainSha, needModules, run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yutakasa-terra-patch-"));
  fs.chmodSync(temp, 0o700);
  const stage = path.join(temp, "stage");
  let added = false;
  try {
    git(["worktree", "add", "--detach", stage, mainSha], root);
    added = true;
    if (needModules) linkModules(path.join(root, "node_modules"), path.join(stage, "node_modules"));
    const sourcePath = path.join(stage, SOURCE);
    fs.writeFileSync(sourcePath, seedKnownDefect(fs.readFileSync(sourcePath, "utf8")));
    git(["add", "--", SOURCE], stage);
    git(["-c", "user.name=synthetic-staging[bot]",
      "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit", "-m", "Seed isolated title-boundary defect"], stage);
    const seedSha = git(["rev-parse", "HEAD"], stage);
    if (git(["status", "--porcelain"], stage) !== "") fail("staging_seed_not_clean");
    return await run({ stage, temp, seedSha });
  } finally {
    if (added) git(["worktree", "remove", "--force", stage], root);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function artifactDirectory(env) {
  const value = env.PATCH_ARTIFACT_DIRECTORY;
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      value.length > 1024) fail("staging_artifact_path_invalid");
  return value;
}

export async function runTerraPatchProposal({ env = process.env, root = process.cwd(),
  realFetch = globalThis.fetch } = {}) {
  const mainSha = trustedMain(env, root);
  const outputDirectory = artifactDirectory(env);
  return withSeededStage(root, mainSha, false, async ({ stage, temp }) => {
    // No generated source or test code is executed in this key-bearing job.
    const workId = crypto.randomUUID();
    const context = syntheticContext(workId);
    context.messages[0].id = context.latest_user_message_id;
    const { fetchImpl, metrics } = mockPrivateApis(context, workId, mainSha,
      env.GITHUB_RUN_ID, realFetch);
    let proposal;
    const syntheticEnv = { ...env, WORK_ID: workId, TICKET_REPAIR_ENABLED: "true",
      SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s".repeat(40),
      GH_TOKEN: "g".repeat(40), GITHUB_REPOSITORY: REPO };
    const investigation = await runTicketRepairInvestigation({ env: syntheticEnv,
      root: stage, fetchImpl, publisher: (publisherEnv) => {
        proposal = validateStagingPatch(JSON.parse(publisherEnv.AI_REPAIR_PROPOSAL), stage, context);
        return { status: "draft_pr_created" };
      } });
    if (investigation.status !== "draft_pr_linked" || !proposal ||
        metrics().openAiCalls !== 2 || metrics().lookupCount !== 2) {
      fail("staging_investigator_path_incomplete");
    }
    const patchFile = path.join(temp, "terra-staging.patch");
    fs.writeFileSync(patchFile, proposal.patch, { mode: 0o600, flag: "wx" });
    git(["apply", "--check", "--whitespace=error", patchFile], stage);
    const manifest = { schema: "yutakasa-terra-staging-v1", mainSha,
      patchSha256: hash(proposal.patch), changedFiles: [SOURCE, TEST].sort(),
      syntheticOnly: true };
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    fs.copyFileSync(patchFile, path.join(outputDirectory, "terra-staging.patch"),
      fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(outputDirectory, "manifest.json"),
      `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
    return { ok: true, phase: "proposal", mainSha, model: "gpt-5.6-terra",
      terraCalls: metrics().openAiCalls, patchSha256: manifest.patchSha256,
      syntheticOnly: true, patchExecuted: false, productionVerified: false,
      draftPrCreated: false, customerReplySent: false };
  });
}

function readArtifact(directory, mainSha) {
  const manifestPath = path.join(directory, "manifest.json");
  const patchPath = path.join(directory, "terra-staging.patch");
  const manifestStat = fs.lstatSync(manifestPath);
  const patchStat = fs.lstatSync(patchPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4096 ||
      !patchStat.isFile() || patchStat.isSymbolicLink() || patchStat.size > 64 * 1024) {
    fail("staging_artifact_invalid");
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { fail("staging_artifact_invalid"); }
  const patch = fs.readFileSync(patchPath, "utf8");
  if (manifest?.schema !== "yutakasa-terra-staging-v1" ||
      manifest.mainSha !== mainSha || manifest.patchSha256 !== hash(patch) ||
      manifest.syntheticOnly !== true ||
      JSON.stringify(manifest.changedFiles) !== JSON.stringify([SOURCE, TEST].sort())) {
    fail("staging_artifact_mismatch");
  }
  return { patch, patchPath, patchSha256: manifest.patchSha256 };
}

export async function runTerraPatchVerification({ env = process.env, root = process.cwd() } = {}) {
  const mainSha = trustedMain(env, root);
  if (env.YUTAKASA_OPENAI_API_KEY || env.GH_TOKEN || env.SUPABASE_SERVICE_ROLE_KEY) {
    fail("staging_verification_has_secret");
  }
  const artifact = readArtifact(artifactDirectory(env), mainSha);
  return withSeededStage(root, mainSha, true, async ({ stage, temp, seedSha }) => {
    runOracle(stage, false);
    const baseline = runVitest(stage, path.join(temp, "baseline.json"), false);
    const context = syntheticContext(crypto.randomUUID());
    validateStagingPatch({ summary: "synthetic", diagnosis: "synthetic",
      patch: artifact.patch }, stage, context);
    git(["apply", "--check", "--whitespace=error", artifact.patchPath], stage);
    git(["apply", "--whitespace=error", `--include=${TEST}`, artifact.patchPath], stage);
    const changedBefore = git(["diff", "--name-only"], stage).split("\n").filter(Boolean);
    if (JSON.stringify(changedBefore) !== JSON.stringify([TEST])) fail("staging_before_scope_invalid");
    const before = runVitest(stage, path.join(temp, "before.json"), true);
    git(["reset", "--hard", seedSha], stage);
    git(["apply", "--check", "--whitespace=error", artifact.patchPath], stage);
    git(["apply", "--whitespace=error", artifact.patchPath], stage);
    git(["diff", "--check"], stage);
    const changedAfter = git(["diff", "--name-only"], stage).split("\n").filter(Boolean).sort();
    if (JSON.stringify(changedAfter) !== JSON.stringify([SOURCE, TEST].sort())) {
      fail("staging_after_scope_invalid");
    }
    const after = runVitest(stage, path.join(temp, "after.json"), false);
    const regression = checkBeforeAfter(before, after);
    runOracle(stage, true);
    return { ok: true, phase: "verification", mainSha, seedSha,
      patchSha256: artifact.patchSha256,
      changedFiles: changedAfter, baselineTests: baseline.numTotalTests, ...regression,
      syntheticOnly: true, productionVerified: false, customerReplySent: false,
      draftPrCreated: false, customerCompletionProofRecorded: false };
  });
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const mode = process.argv[2];
  const run = mode === "propose" ? runTerraPatchProposal :
    mode === "verify" ? runTerraPatchVerification : null;
  (run ? run() : Promise.reject(new TerraPatchStagingError("staging_mode_invalid"))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => { process.stdout.write(`${JSON.stringify({ ok: false,
      code: error instanceof TerraPatchStagingError ? error.code : "staging_failed" })}\n`);
      process.exitCode = 1; },
  );
}
