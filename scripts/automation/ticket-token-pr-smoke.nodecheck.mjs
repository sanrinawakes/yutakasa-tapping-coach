import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRun, cleanupTokenPrSmoke, fixedChanges, inspectChecks,
  TokenPrSmokeError } from "./ticket-token-pr-smoke.mjs";

const repo = "sanrinawakes/yutakasa-tapping-coach";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const branch = "codex/yutakasa-token-smoke-123-1";
const title = "Synthetic scoped-token PR smoke 123-1";
const body = `${title}. No customer data, payment, model call, or production merge. This draft will be closed and its branch deleted after exact-head CI and Vercel preview.`;
const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: repo,
  GITHUB_REF: "refs/heads/main", GITHUB_SHA: baseSha,
  GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  YUTAKASA_TOKEN_PR_SMOKE_ENABLED: "true",
  YUTAKASA_TICKET_REPAIR_ENABLED: "false", YUTAKASA_AUTO_MERGE_ENABLED: "false",
  GH_TOKEN: "g".repeat(40), GH_READ_TOKEN: "r".repeat(40) };

test("one-shot gate requires manual main and both production repair flags off", () => {
  assert.deepEqual(checkRun(env, baseSha, true), { branch, title, body });
  for (const [name, value] of Object.entries({ GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/feature", YUTAKASA_TOKEN_PR_SMOKE_ENABLED: "false",
    YUTAKASA_TICKET_REPAIR_ENABLED: "true", YUTAKASA_AUTO_MERGE_ENABLED: "true",
  })) assert.throws(() => checkRun({ ...env, [name]: value }, baseSha, true),
    TokenPrSmokeError);
  assert.throws(() => checkRun(env, headSha, true), TokenPrSmokeError);
  assert.throws(() => checkRun(env, baseSha, false), TokenPrSmokeError);
});

test("the disposable diff is fixed, benign, and limited to an existing source and test", () => {
  const source = fs.readFileSync("src/lib/chat-thread.ts", "utf8");
  const existingTest = fs.readFileSync("src/lib/chat-thread.test.ts", "utf8");
  const changed = fixedChanges({ source, test: existingTest, marker: branch });
  assert.equal(changed.source.replace(`// Synthetic scoped-token permission check: ${branch}\n`,
    ""), source);
  assert.equal(changed.test.includes(`(${branch})`), true);
  assert.equal(changed.test.includes('expect(sanitizeChatTitle("  試験  ")).toBe("試験")'), true);
  assert.throws(() => fixedChanges({ source: changed.source, test: existingTest,
    marker: branch }), TokenPrSmokeError);
  assert.throws(() => fixedChanges({ source, test: existingTest,
    marker: "codex/yutakasa-support-ai-deadbeefdeadbeef" }), TokenPrSmokeError);
});

function run(file, check, status = "completed", conclusion = "success") {
  return { id: 1, head_sha: headSha, head_branch: branch,
    event: "pull_request", path: `.github/workflows/${file}`,
    status, conclusion, name: check };
}
const workflows = [
  { workflow_runs: [run("source-repair-ci.yml", "source-repair-verify")] },
  { workflow_runs: [run("ai-repair-independent-review.yml", "ai-repair-independent-review")] },
];
const vercel = { sha: headSha, statuses: [{ context: "Vercel", state: "success",
  description: "Deployment has completed",
  target_url: "https://vercel.com/sanrinawakes-projects/yutakasa-tapping-coach/preview" }] };

test("exact-head PR runs and Vercel status are required", () => {
  assert.deepEqual(inspectChecks({ runs: workflows, status: vercel, branch, sha: headSha }),
    { status: "passed", workflows: 2, vercelPreview: true });
  assert.deepEqual(inspectChecks({ runs: [{ workflow_runs: [] }, workflows[1]],
    status: vercel, branch, sha: headSha }), { status: "pending" });
  assert.throws(() => inspectChecks({ runs: [{ workflow_runs: [
    run("source-repair-ci.yml", "source-repair-verify", "completed", "failure") ] },
  workflows[1]], status: vercel, branch, sha: headSha }), TokenPrSmokeError);
  assert.throws(() => inspectChecks({ runs: workflows,
    status: { ...vercel, sha: baseSha }, branch, sha: headSha }), TokenPrSmokeError);
});

function stateFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yutakasa-token-smoke-check-"));
  const file = path.join(directory, "state.json");
  fs.writeFileSync(file, `${JSON.stringify({ repository: repo, branch,
    baseSha, headSha, prNumber: 99, title, body })}\n`, { mode: 0o600 });
  return { directory, file };
}

test("cleanup closes only the exact draft and deletes only its unchanged branch", async () => {
  const { directory, file } = stateFile();
  const calls = [];
  let closed = false;
  let deleted = false;
  const fakeFetch = async (url, init) => {
    const parsed = new URL(url);
    calls.push(`${init.method}:${parsed.pathname}`);
    assert.equal(init.headers.Authorization,
      `Bearer ${init.method === "GET" ? env.GH_READ_TOKEN : env.GH_TOKEN}`);
    if (parsed.pathname.endsWith("/pulls") && init.method === "GET") {
      return new Response(JSON.stringify([{ number: 99, title, body,
        state: closed ? "closed" : "open", draft: true, merged_at: null,
        base: { ref: "main" }, head: { ref: branch, sha: headSha,
          repo: { full_name: repo } } }]), { status: 200 });
    }
    if (parsed.pathname.endsWith("/pulls/99") && init.method === "PATCH") {
      closed = true;
      return new Response(JSON.stringify({ number: 99, state: "closed", merged_at: null }),
        { status: 200 });
    }
    if (parsed.pathname.includes("/git/ref/heads/") && init.method === "GET") {
      return deleted ? new Response(null, { status: 404 }) :
        new Response(JSON.stringify({ ref: `refs/heads/${branch}`,
          object: { sha: headSha } }), { status: 200 });
    }
    assert.fail(`unexpected ${init.method} ${parsed.pathname}`);
  };
  try {
    const result = await cleanupTokenPrSmoke({ env: { ...env, SMOKE_STATE_PATH: file },
      fetchImpl: fakeFetch, deleteRef: async (_, state) => {
        assert.equal(state.headSha, headSha); deleted = true; calls.push("LEASE_DELETE");
      } });
    assert.deepEqual(result, { ok: true, status: "cleaned", prClosed: true,
      branchDeleted: true, syntheticOnly: true });
    assert.equal(calls.filter((call) => call === "LEASE_DELETE").length, 1);
    const repeat = await cleanupTokenPrSmoke({ env: { ...env, SMOKE_STATE_PATH: file },
      fetchImpl: fakeFetch, deleteRef: async () => assert.fail("already deleted") });
    assert.deepEqual(repeat, { ok: true, status: "cleaned", prClosed: true,
      branchDeleted: false, syntheticOnly: true });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("changed PR or branch identity stops cleanup before deletion", async () => {
  const { directory, file } = stateFile();
  const mutations = [];
  const fakeFetch = async (url, init) => {
    mutations.push(init.method);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/pulls")) {
      return new Response(JSON.stringify([{ number: 99, title, body,
        state: "open", draft: true, merged_at: null,
        base: { ref: "main" }, head: { ref: branch, sha: baseSha,
          repo: { full_name: repo } } }]), { status: 200 });
    }
    assert.fail("cleanup must stop before mutation");
  };
  try {
    await assert.rejects(() => cleanupTokenPrSmoke({ env: { ...env, SMOKE_STATE_PATH: file },
      fetchImpl: fakeFetch }), TokenPrSmokeError);
    assert.deepEqual(mutations, ["GET"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("missing state is a no-op even when the scoped token is unavailable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yutakasa-token-smoke-empty-"));
  try {
    const result = await cleanupTokenPrSmoke({ env: { ...env, GH_TOKEN: "",
      SMOKE_STATE_PATH: path.join(directory, "missing.json") },
    fetchImpl: async () => assert.fail("no remote call") });
    assert.deepEqual(result, { ok: true, status: "nothing_created" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
