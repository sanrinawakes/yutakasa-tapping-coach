#!/usr/bin/env node

// A deliberately limited producer. It proves that one named regression test
// fails against the PR base and passes against the PR head. It never records a
// completion proof: production and ticket-specific reproduction are separate.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, copyFile, lstat, symlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const BRANCH = /^codex\/yutakasa-support-ai-[a-f0-9]{16}$/u;
const TESTS = Object.freeze({
  chat_send_reload_persistence: "src/app/chat/page.test.tsx",
  chat_stream_completion: "src/app/api/chat/route.test.ts",
  chat_title_zero_width: "src/lib/chat-thread.test.ts",
});
const ALLOWED = new Set([
  "src/lib/gemini.ts", "src/lib/chat-thread.ts", "src/app/chat/page.tsx",
  "src/app/chat/layout.tsx", "src/app/api/chat/route.ts",
  "src/lib/gemini.retry.test.ts", "src/lib/chat-thread.test.ts",
  ...Object.values(TESTS),
]);

export class RegressionEvidenceError extends Error {
  constructor(code) { super(code); this.name = "RegressionEvidenceError"; this.code = code; }
}
function fail(code) { throw new RegressionEvidenceError(code); }
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function checkInputs({ workId, prNumber, scenarioKey, runId, repository, mainSha }) {
  if (!UUID.test(workId ?? "") || !Number.isSafeInteger(prNumber) || prNumber < 1 ||
      !Object.hasOwn(TESTS, scenarioKey ?? "") ||
      !Number.isSafeInteger(runId) || runId < 1 || repository !== REPO ||
      !SHA.test(mainSha ?? "")) fail("regression_inputs_invalid");
  return {
    workId, prNumber, scenarioKey, runId, mainSha,
    fingerprint: digest(workId).slice(0, 16), testFile: TESTS[scenarioKey],
  };
}

export function checkPullRequest(pr, context) {
  if (pr?.number !== context.prNumber || pr?.state !== "open" || pr?.draft !== true ||
      pr?.base?.ref !== "main" || pr.base.sha !== context.mainSha ||
      pr?.head?.repo?.full_name !== REPO || !BRANCH.test(pr?.head?.ref ?? "") ||
      !SHA.test(pr?.head?.sha ?? "") || pr.head.sha === context.mainSha) {
    fail("regression_pr_context_invalid");
  }
  return pr.head.sha;
}

export function checkChangedFiles(changedFiles, testFile) {
  if (testFile === TESTS.chat_title_zero_width) {
    if (!Array.isArray(changedFiles) || changedFiles.length !== 2 ||
        new Set(changedFiles).size !== 2 ||
        !changedFiles.includes("src/lib/chat-thread.ts") ||
        !changedFiles.includes(testFile)) fail("regression_diff_invalid");
    return;
  }
  if (!Array.isArray(changedFiles) || changedFiles.length < 2 ||
      changedFiles.length > ALLOWED.size || new Set(changedFiles).size !== changedFiles.length ||
      !changedFiles.includes(testFile) ||
      !changedFiles.some((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx")) ||
      changedFiles.some((file) => !ALLOWED.has(file))) fail("regression_diff_invalid");
}

export function checkTestSource({ baseSource, headSource, marker }) {
  if (typeof baseSource !== "string" || typeof headSource !== "string" ||
      Buffer.byteLength(headSource) > 180 * 1024 || baseSource === headSource ||
      baseSource.includes(marker) || headSource.split(marker).length !== 2) {
    fail("regression_test_marker_invalid");
  }
  return digest(headSource);
}

export function trustedZeroWidthSpec(marker) {
  if (!/^repair-regression:[a-f0-9]{16}:chat_title_zero_width$/u.test(marker)) {
    fail("regression_test_marker_invalid");
  }
  return `import { createChatTitle, sanitizeChatTitle, DEFAULT_CHAT_TITLE } from "./chat-thread";\n` +
    `describe("${marker}", () => {\n` +
    `  it("renders the default title for the exact U+200B input", () => {\n` +
    `    expect(createChatTitle("\\u200B")).toBe(DEFAULT_CHAT_TITLE);\n` +
    `    expect(sanitizeChatTitle("\\u200B")).toBe(DEFAULT_CHAT_TITLE);\n` +
    `  });\n` +
    `});\n`;
}

function assertions(report) {
  if (!Array.isArray(report?.testResults) || report.testResults.length !== 1 ||
      !Array.isArray(report.testResults[0]?.assertionResults) ||
      report.testResults[0].assertionResults.length < 1 ||
      report.testResults[0].assertionResults.length > 200 ||
      report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
      report.numTotalTests !== report.testResults[0].assertionResults.length) {
    fail("regression_test_report_invalid");
  }
  return report.testResults[0].assertionResults;
}

export function checkRegressionReports({ before, after, marker }) {
  const beforeAssertions = assertions(before);
  const afterAssertions = assertions(after);
  const identity = (result) => result?.fullName ?? result?.title;
  const beforeNames = beforeAssertions.map(identity);
  const afterNames = afterAssertions.map(identity);
  const failure = beforeAssertions.find((result) => result.status === "failed");
  if (beforeNames.some((name) => typeof name !== "string" || !name.trim()) ||
      afterNames.some((name) => typeof name !== "string" || !name.trim()) ||
      new Set(beforeNames).size !== beforeNames.length ||
      JSON.stringify(beforeNames) !== JSON.stringify(afterNames) ||
      beforeNames.filter((name) => typeof name === "string" && name.includes(marker)).length !== 1 ||
      beforeAssertions.filter((result) => result.status === "failed").length !== 1 ||
      failure?.fullName?.includes(marker) !== true ||
      !Array.isArray(failure?.failureMessages) || failure.failureMessages.length < 1 ||
      failure.failureMessages.length > 4 ||
      failure.failureMessages.some((message) => typeof message !== "string" ||
        !message.trim() || Buffer.byteLength(message) > 32 * 1024) ||
      beforeAssertions.some((result) => !["passed", "failed"].includes(result.status)) ||
      afterAssertions.some((result) => result.status !== "passed") ||
      afterAssertions.some((result) => (result.failureMessages ?? []).length !== 0) ||
      before.success !== false || after.success !== true) {
    fail("regression_not_reproduced_and_fixed");
  }
  const summary = (results) => results.map((item) => ({ name: identity(item), status: item.status }));
  return {
    beforeFailureSha256: digest(JSON.stringify({
      assertions: summary(beforeAssertions), failureMessages: failure.failureMessages,
    })),
    afterSuccessSha256: digest(JSON.stringify(summary(afterAssertions))),
    tests: afterAssertions.length,
  };
}

async function command(binary, args, options = {}) {
  try {
    return await exec(binary, args, { ...options, maxBuffer: 512 * 1024, timeout: 180_000 });
  } catch (error) {
    // Vitest intentionally exits 1 for the pre-fix reproduction. Its JSON
    // report, rather than stdout or the exit code alone, determines success.
    if (options.allowFailure && error?.code === 1) return { stdout: "", stderr: "" };
    fail("regression_command_failed");
  }
}

async function jsonResponse(response, code) {
  if (response.status !== 200) fail(code);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 128 * 1024) fail(code);
  try { return JSON.parse(raw); } catch { fail(code); }
}

async function readPr(context, fetchImpl) {
  // The repository is public. Keep this entire job free of application and
  // GitHub API secrets before executing the PR's regression test.
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/pulls/${context.prNumber}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "yutakasa-regression-evidence" },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("regression_pr_lookup_failed"));
  return jsonResponse(response, "regression_pr_lookup_failed");
}

function testEnv() {
  // Never pass GitHub, Supabase, OpenAI, Vercel or Railway credentials to PR
  // code. It is allowed to execute only as an unprivileged test process.
  return { PATH: process.env.PATH ?? "", CI: "true", NODE_ENV: "test",
    TZ: "UTC", HOME: os.tmpdir() };
}

async function readSafeFile(file) {
  const stat = await lstat(file).catch(() => fail("regression_test_file_missing"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 180 * 1024) {
    fail("regression_test_file_invalid");
  }
  return readFile(file, "utf8");
}

async function runVitest(checkout, testFile, reportFile, allowFailure) {
  await command(path.join(checkout, "node_modules/.bin/vitest"),
    ["run", testFile, "--reporter=json", `--outputFile=${reportFile}`, "--maxWorkers=2"],
    { cwd: checkout, env: testEnv(), allowFailure });
  const raw = await readFile(reportFile, "utf8").catch(() => fail("regression_report_missing"));
  if (Buffer.byteLength(raw) > 512 * 1024) fail("regression_report_too_large");
  try { return JSON.parse(raw); } catch { fail("regression_report_invalid"); }
}

export async function runRegressionEvidence({
  env = process.env, fetchImpl = globalThis.fetch, root = process.cwd(),
} = {}) {
  const mainSha = (await command("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const context = checkInputs({ workId: env.WORK_ID, prNumber: Number(env.PR_NUMBER),
    scenarioKey: env.SCENARIO_KEY, runId: Number(env.GITHUB_RUN_ID),
    repository: env.GITHUB_REPOSITORY, mainSha });
  if (env.GITHUB_REF !== "refs/heads/main" ||
      !(await lstat(path.join(root, "node_modules/.bin/vitest")).catch(() => null))) {
    fail("regression_trusted_checkout_missing");
  }
  const headSha = checkPullRequest(await readPr(context, fetchImpl), context);
  // The only fetched PR ref must resolve to the GitHub API's exact head.
  await command("git", ["fetch", "--no-tags", "origin", `refs/pull/${context.prNumber}/head`], { cwd: root });
  const fetchedSha = (await command("git", ["rev-parse", "FETCH_HEAD"], { cwd: root })).stdout.trim();
  if (fetchedSha !== headSha) fail("regression_pr_head_changed");
  const files = (await command("git", ["diff", "--name-only", context.mainSha, headSha], { cwd: root }))
    .stdout.trim().split("\n").filter(Boolean);
  checkChangedFiles(files, context.testFile);
  const temp = await mkdtemp(path.join(os.tmpdir(), "yutakasa-regression-"));
  const base = path.join(temp, "base");
  const head = path.join(temp, "head");
  let baseAdded = false;
  let headAdded = false;
  try {
    await command("git", ["worktree", "add", "--detach", base, context.mainSha], { cwd: root });
    baseAdded = true;
    await command("git", ["worktree", "add", "--detach", head, headSha], { cwd: root });
    headAdded = true;
    const mainModules = path.join(root, "node_modules");
    await symlink(mainModules, path.join(base, "node_modules"), "dir");
    await symlink(mainModules, path.join(head, "node_modules"), "dir");
    const baseTest = path.join(base, context.testFile);
    const headTest = path.join(head, context.testFile);
    const marker = `repair-regression:${context.fingerprint}:${context.scenarioKey}`;
    const baseSource = await readSafeFile(baseTest);
    const headSource = await readSafeFile(headTest);
    const scenarioSha256 = checkTestSource({ baseSource, headSource, marker });
    let regressionFile = context.testFile;
    if (context.scenarioKey === "chat_title_zero_width") {
      // The test used as proof is generated by trusted main code. A PR cannot
      // make a fake test pass or encode private ticket text in this assertion.
      regressionFile = "src/lib/chat-thread.condition.test.ts";
      const spec = trustedZeroWidthSpec(marker);
      await writeFile(path.join(base, regressionFile), spec, { mode: 0o600, flag: "wx" });
      await writeFile(path.join(head, regressionFile), spec, { mode: 0o600, flag: "wx" });
    } else {
      // Older scenarios remain candidate-only: they use the PR's new test.
      await copyFile(headTest, baseTest);
    }
    const before = await runVitest(base, regressionFile, path.join(temp, "before.json"), true);
    const after = await runVitest(head, regressionFile, path.join(temp, "after.json"), false);
    const result = checkRegressionReports({ before, after, marker });
    const evidence = {
      schema: "yutakasa-ticket-regression-v1", workId: context.workId,
      prNumber: context.prNumber, baseSha: context.mainSha, headSha,
      scenarioKey: context.scenarioKey, scenarioSha256,
      beforeFailureSha256: result.beforeFailureSha256,
      afterSuccessSha256: result.afterSuccessSha256,
      beforeAfterRunId: context.runId, tests: result.tests,
      productionVerified: false, ticketCompletionProofRecorded: false,
    };
    if (typeof env.EVIDENCE_PATH === "string" && env.EVIDENCE_PATH) {
      await writeFile(env.EVIDENCE_PATH, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: "wx" });
    }
    return evidence;
  } finally {
    if (headAdded) await command("git", ["worktree", "remove", "--force", head], { cwd: root });
    if (baseAdded) await command("git", ["worktree", "remove", "--force", base], { cwd: root });
    await rm(temp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runRegressionEvidence().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, prNumber: result.prNumber,
      tests: result.tests, productionVerified: false, ticketCompletionProofRecorded: false })}\n`),
    (error) => { process.stdout.write(`${JSON.stringify({ ok: false,
      code: error instanceof RegressionEvidenceError ? error.code : "regression_evidence_failed" })}\n`);
      process.exitCode = 1; },
  );
}
