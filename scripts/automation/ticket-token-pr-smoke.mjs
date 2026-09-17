#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyMainProtection } from "./ai-repair-promote.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SOURCE = "src/lib/chat-thread.ts";
const TEST = "src/lib/chat-thread.test.ts";
const SHA = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,17}$/u;
const BRANCH = /^codex\/yutakasa-token-smoke-[1-9][0-9]{0,17}-[1-9][0-9]{0,2}$/u;
const CI_WORKFLOWS = [
  { file: "source-repair-ci.yml", check: "source-repair-verify" },
  { file: "ai-repair-independent-review.yml", check: "ai-repair-independent-review" },
];

export class TokenPrSmokeError extends Error {
  constructor(code) { super(code); this.name = "TokenPrSmokeError"; this.code = code; }
}
function fail(code) { throw new TokenPrSmokeError(code); }
function command(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, { encoding: "utf8", maxBuffer: 512 * 1024,
      timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
  } catch { fail("smoke_command_failed"); }
}
function git(args, options = {}) {
  return command("git", ["-c", "core.hooksPath=/dev/null", ...args], options);
}

export function checkRun(env, headSha, clean) {
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      env.YUTAKASA_TOKEN_PR_SMOKE_ENABLED !== "true" ||
      env.YUTAKASA_AUTO_MERGE_ENABLED !== "false" ||
      env.YUTAKASA_TICKET_REPAIR_ENABLED !== "false" ||
      !RUN_ID.test(runId ?? "") || !Number.isSafeInteger(Number(runId)) ||
      !/^[1-9][0-9]{0,2}$/u.test(attempt ?? "") ||
      !SHA.test(headSha) || env.GITHUB_SHA !== headSha || !clean ||
      typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length < 20) {
    fail("smoke_gate_closed");
  }
  return { branch: `codex/yutakasa-token-smoke-${runId}-${attempt}`,
    title: `Synthetic scoped-token PR smoke ${runId}-${attempt}`,
    body: `Synthetic scoped-token PR smoke ${runId}-${attempt}. No customer data, payment, model call, or production merge. This draft will be closed and its branch deleted after exact-head CI and Vercel preview.`,
  };
}

export function fixedChanges({ source, test, marker }) {
  const sourceAnchor = 'export const DEFAULT_CHAT_TITLE = "新しいチャット";';
  const testAnchor = 'describe("chat thread helpers", () => {';
  if (!BRANCH.test(marker) || source.split(sourceAnchor).length !== 2 ||
      test.split(testAnchor).length !== 2 || source.includes(marker) || test.includes(marker)) {
    fail("smoke_fixture_source_changed");
  }
  const testCase = [
    `  it("keeps a fixed synthetic title case (${marker})", () => {`,
    '    expect(sanitizeChatTitle("  試験  ")).toBe("試験");',
    "  });",
  ].join("\n");
  return {
    source: source.replace(sourceAnchor, `// Synthetic scoped-token permission check: ${marker}\n${sourceAnchor}`),
    test: test.replace(testAnchor, `${testAnchor}\n${testCase}`),
  };
}

function statePath(env) {
  const value = env.SMOKE_STATE_PATH;
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 1024) {
    fail("smoke_state_path_invalid");
  }
  return value;
}
function stateFields(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      Object.keys(state).sort().join(",") !==
        "baseSha,body,branch,createAttempted,headSha,prNumber,repository,title" ||
      state.repository !== REPO || !BRANCH.test(state.branch ?? "") ||
      typeof state.createAttempted !== "boolean" ||
      !SHA.test(state.baseSha ?? "") ||
      (state.headSha !== null && !SHA.test(state.headSha ?? "")) ||
      (state.prNumber !== null && (!Number.isSafeInteger(state.prNumber) || state.prNumber < 1)) ||
      state.title !== `Synthetic scoped-token PR smoke ${state.branch.slice("codex/yutakasa-token-smoke-".length)}` ||
      typeof state.body !== "string" || !state.body.startsWith(`${state.title}. `)) {
    fail("smoke_state_invalid");
  }
  return state;
}
function writeState(file, state, initial = false) {
  stateFields(state);
  if (initial) fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
  else {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      fail("smoke_state_security_invalid");
    }
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }
}
function readState(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
      stat.size > 4096) fail("smoke_state_security_invalid");
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail("smoke_state_invalid"); }
  return stateFields(value);
}

async function api(env, fetchImpl, route, options = {}) {
  const method = options.method ?? "GET";
  const token = method === "GET" ? env.GH_READ_TOKEN : env.GH_TOKEN;
  if (typeof token !== "string" || token.length < 20) fail("smoke_read_credential_missing");
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}${route}`, {
    method,
    headers: { Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "content-type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("smoke_github_request_failed"));
  if (options.allow404 && response.status === 404) return null;
  const expected = options.expected ?? 200;
  if (response.status !== expected) fail(`smoke_github_http_${response.status}`);
  if (expected === 204) return true;
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 512 * 1024) fail("smoke_github_response_large");
  try { return JSON.parse(raw); } catch { fail("smoke_github_response_invalid"); }
}

async function findPr(env, fetchImpl, state) {
  const query = new URLSearchParams({ state: "all", head: `sanrinawakes:${state.branch}`,
    per_page: "10" });
  const rows = await api(env, fetchImpl, `/pulls?${query}`);
  if (!Array.isArray(rows) || rows.length > 10) fail("smoke_pr_lookup_invalid");
  if (rows.length === 0) return null;
  if (rows.length !== 1) fail("smoke_pr_ambiguous");
  const pr = rows[0];
  if (!Number.isSafeInteger(pr?.number) || pr.number < 1 ||
      pr.title !== state.title || pr.body !== state.body ||
      pr.base?.ref !== "main" || pr.head?.ref !== state.branch ||
      pr.head?.repo?.full_name !== REPO ||
      (state.headSha && pr.head.sha !== state.headSha) ||
      (state.prNumber && pr.number !== state.prNumber) ||
      pr.merged_at !== null) fail("smoke_pr_identity_changed");
  return pr;
}

async function findPrBounded(env, fetchImpl, state, sleep) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pr = await findPr(env, fetchImpl, state);
    if (pr) return pr;
    if (attempt < 3) await sleep(5_000);
  }
  return null;
}

export function inspectChecks({ runs, status, branch, sha }) {
  if (!BRANCH.test(branch) || !SHA.test(sha) ||
      !Array.isArray(runs) || runs.length !== CI_WORKFLOWS.length) {
    fail("smoke_check_evidence_invalid");
  }
  let pending = false;
  for (let i = 0; i < CI_WORKFLOWS.length; i += 1) {
    const expected = CI_WORKFLOWS[i];
    const list = runs[i]?.workflow_runs;
    if (!Array.isArray(list) || list.length > 100) fail("smoke_check_evidence_invalid");
    const exact = list.filter((run) => run.head_sha === sha &&
      run.head_branch === branch && run.event === "pull_request" &&
      run.path === `.github/workflows/${expected.file}`)
      .sort((a, b) => b.id - a.id);
    if (exact.length === 0 || exact[0].status !== "completed") { pending = true; continue; }
    if (exact[0].conclusion !== "success") fail("smoke_ci_failed");
  }
  const vercel = status?.statuses?.find((item) => item.context === "Vercel");
  if (status?.sha !== sha || !Array.isArray(status.statuses)) fail("smoke_vercel_evidence_invalid");
  if (!vercel || vercel.state === "pending") pending = true;
  else if (vercel.state !== "success" ||
      vercel.description !== "Deployment has completed" ||
      typeof vercel.target_url !== "string" ||
      !vercel.target_url.startsWith("https://vercel.com/sanrinawakes-projects/yutakasa-tapping-coach/")) {
    fail("smoke_vercel_preview_failed");
  }
  return pending ? { status: "pending" } : { status: "passed", workflows: 2,
    vercelPreview: true };
}

async function waitForChecks(env, fetchImpl, state, sleep, now) {
  const deadline = now() + 10 * 60 * 1000;
  while (now() < deadline) {
    const runs = [];
    for (const workflow of CI_WORKFLOWS) {
      const query = new URLSearchParams({ head_sha: state.headSha,
        event: "pull_request", per_page: "100" });
      runs.push(await api(env, fetchImpl,
        `/actions/workflows/${workflow.file}/runs?${query}`));
    }
    const status = await api(env, fetchImpl, `/commits/${state.headSha}/status`);
    const inspected = inspectChecks({ runs, status, branch: state.branch, sha: state.headSha });
    if (inspected.status === "passed") return inspected;
    await sleep(15_000);
  }
  fail("smoke_ci_timeout");
}

function checkedEnvironment(env) {
  const childEnv = { ...process.env, GH_TOKEN: env.GH_TOKEN,
    GIT_TERMINAL_PROMPT: "0" };
  delete childEnv.SUPABASE_SERVICE_ROLE_KEY;
  delete childEnv.YUTAKASA_OPENAI_API_KEY;
  delete childEnv.YUTAKASA_RESEND_API_KEY;
  return childEnv;
}

function deleteUnchangedBranch(env, state) {
  const temp = fs.mkdtempSync(path.join(path.dirname(statePath(env)), "yutakasa-token-delete-"));
  fs.chmodSync(temp, 0o700);
  try {
    const askpass = path.join(temp, "askpass.sh");
    fs.writeFileSync(askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf %s x-access-token ;; *Password*) printf %s "$GH_TOKEN" ;; *) exit 1 ;; esac\n',
      { mode: 0o700, flag: "wx" });
    git(["push", `--force-with-lease=refs/heads/${state.branch}:${state.headSha}`,
      `https://github.com/${REPO}.git`, `:refs/heads/${state.branch}`],
    { env: { ...checkedEnvironment(env), GIT_ASKPASS: askpass } });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function publishTokenPrSmoke({ env = process.env,
  fetchImpl = globalThis.fetch, root = process.cwd(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now } = {}) {
  const baseSha = git(["rev-parse", "HEAD"], { cwd: root });
  const plan = checkRun(env, baseSha, git(["status", "--porcelain"], { cwd: root }) === "");
  verifyMainProtection(await api(env, fetchImpl, "/rules/branches/main"));
  const file = statePath(env);
  const state = { repository: REPO, branch: plan.branch, baseSha, createAttempted: false,
    headSha: null, prNumber: null, title: plan.title, body: plan.body };
  writeState(file, state, true);
  const temp = fs.mkdtempSync(path.join(path.dirname(file), "yutakasa-token-smoke-"));
  fs.chmodSync(temp, 0o700);
  try {
    const askpass = path.join(temp, "askpass.sh");
    fs.writeFileSync(askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf %s x-access-token ;; *Password*) printf %s "$GH_TOKEN" ;; *) exit 1 ;; esac\n',
      { mode: 0o700, flag: "wx" });
    const bodyFile = path.join(temp, "body.md");
    fs.writeFileSync(bodyFile, state.body, { mode: 0o600, flag: "wx" });
    git(["switch", "-c", state.branch], { cwd: root });
    const sourceFile = path.join(root, SOURCE);
    const testFile = path.join(root, TEST);
    const change = fixedChanges({ source: fs.readFileSync(sourceFile, "utf8"),
      test: fs.readFileSync(testFile, "utf8"), marker: state.branch });
    fs.writeFileSync(sourceFile, change.source);
    fs.writeFileSync(testFile, change.test);
    git(["diff", "--check"], { cwd: root });
    const changed = git(["diff", "--name-only"], { cwd: root }).split("\n").filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify([SOURCE, TEST].sort())) {
      fail("smoke_diff_scope_invalid");
    }
    git(["add", "--", SOURCE, TEST], { cwd: root });
    git(["diff", "--cached", "--check"], { cwd: root });
    git(["-c", "user.name=synthetic-smoke[bot]",
      "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit", "-m", `Synthetic scoped-token PR smoke ${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`],
    { cwd: root });
    state.headSha = git(["rev-parse", "HEAD"], { cwd: root });
    writeState(file, state);
    git(["push", `https://github.com/${REPO}.git`,
      `HEAD:refs/heads/${state.branch}`], { cwd: root,
      env: { ...checkedEnvironment(env), GIT_ASKPASS: askpass } });
    // A failed create may have succeeded remotely. Never retry blindly.
    state.createAttempted = true;
    writeState(file, state);
    try {
      command("gh", ["pr", "create", "--repo", REPO, "--draft", "--base", "main",
        "--head", state.branch, "--title", state.title, "--body-file", bodyFile],
      { cwd: root, env: checkedEnvironment(env) });
    } catch { /* resolve the one possible remote result by branch identity */ }
    const pr = await findPrBounded(env, fetchImpl, state, sleep);
    if (!pr || pr.state !== "open" || pr.draft !== true) fail("smoke_draft_pr_unconfirmed");
    state.prNumber = pr.number;
    writeState(file, state);
    const checks = await waitForChecks(env, fetchImpl, state, sleep, now);
    return { ok: true, prNumber: state.prNumber, headSha: state.headSha,
      checks: checks.workflows, vercelPreview: checks.vercelPreview,
      syntheticOnly: true, productionMerge: false, customerDataUsed: false };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function cleanupTokenPrSmoke({ env = process.env,
  fetchImpl = globalThis.fetch, deleteRef = deleteUnchangedBranch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  // Cleanup is allowed even if the one-shot variable was reset mid-run.
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      !RUN_ID.test(env.GITHUB_RUN_ID ?? "") ||
      !/^[1-9][0-9]{0,2}$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")) {
    fail("smoke_cleanup_gate_closed");
  }
  const state = readState(statePath(env));
  if (!state) return { ok: true, status: "nothing_created" };
  if (typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length < 20) {
    fail("smoke_cleanup_credential_missing");
  }
  const expectedBranch = `codex/yutakasa-token-smoke-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  if (state.branch !== expectedBranch) fail("smoke_cleanup_identity_mismatch");
  const pr = state.createAttempted ?
    await findPrBounded(env, fetchImpl, state, sleep) : await findPr(env, fetchImpl, state);
  if (!pr && (state.createAttempted || state.prNumber !== null)) {
    fail("smoke_pr_creation_uncertain");
  }
  if (pr) {
    if (pr.state === "open") {
      if (pr.draft !== true) fail("smoke_pr_not_draft");
      const closed = await api(env, fetchImpl, `/pulls/${pr.number}`, {
        method: "PATCH", body: { state: "closed" },
      });
      if (closed?.number !== pr.number || closed?.state !== "closed" ||
          closed?.merged_at !== null) fail("smoke_pr_close_unconfirmed");
    } else if (pr.state !== "closed") fail("smoke_pr_state_invalid");
  }
  const ref = await api(env, fetchImpl, `/git/ref/heads/${state.branch}`, { allow404: true });
  if (ref !== null) {
    if (!SHA.test(state.headSha ?? "") || ref?.ref !== `refs/heads/${state.branch}` ||
        ref.object?.sha !== state.headSha) fail("smoke_branch_head_changed");
    await deleteRef(env, state);
  }
  const remaining = await api(env, fetchImpl, `/git/ref/heads/${state.branch}`, { allow404: true });
  const finalPr = await findPr(env, fetchImpl, state);
  if (remaining !== null || (finalPr && (finalPr.state !== "closed" || finalPr.merged_at !== null))) {
    fail("smoke_cleanup_unconfirmed");
  }
  return { ok: true, status: "cleaned", prClosed: finalPr !== null,
    branchDeleted: ref !== null, syntheticOnly: true };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const mode = process.argv[2];
  const run = mode === "run" ? publishTokenPrSmoke :
    mode === "cleanup" ? cleanupTokenPrSmoke : null;
  (run ? run() : Promise.reject(new TokenPrSmokeError("smoke_mode_invalid"))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => { process.stdout.write(`${JSON.stringify({ ok: false,
      code: error instanceof TokenPrSmokeError ? error.code : "smoke_failed" })}\n`);
      process.exitCode = 1; },
  );
}
