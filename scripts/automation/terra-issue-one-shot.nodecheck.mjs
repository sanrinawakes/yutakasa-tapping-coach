import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { runTerraIssueOneShot } from "./terra-issue-one-shot.mjs";

const repo = "sanrinawakes/yutakasa-tapping-coach";
const sha = "a".repeat(40);
const marker = createHash("sha256").update(`${repo}:123456`).digest("hex").slice(0, 16);
const title = `Yutakasa synthetic Terra issue probe ${marker}`;
const body = [
  "One-shot synthetic integration check. No customer ticket or production database row was read.",
  "A capped Terra request containing only the fixed text OK completed before this issue was created.",
  "This issue is closed by the same workflow and must never enter a repair or release queue.",
].join("\n");
const baseEnv = {
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: repo,
  GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_RUN_ID: "123456",
  TICKET_REPAIR_ENABLED: "false", AUTO_MERGE_ENABLED: "false",
  GH_TOKEN: "ghs_" + "x".repeat(35),
};
const confirmedTerra = {
  ok: true, project_attestation_match: true, key_fingerprint_match: true,
  response_model: "gpt-5.6-terra",
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function fixture({ existing = null, mainSha = sha, incomplete = false,
  createThrows = false, closeThrows = false } = {}) {
  const calls = [];
  let terraCalls = 0;
  const issue = (state = "open") => ({ number: 987, title, body, state });
  return {
    calls,
    terraCalls: () => terraCalls,
    terraImpl: async () => { terraCalls += 1; return confirmedTerra; },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls.push({ url: url.toString(), method: init.method, body: init.body ?? null });
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(init.headers.Authorization, `Bearer ${baseEnv.GH_TOKEN}`);
      assert.equal(init.redirect, "error");
      if (url.pathname === `/repos/${repo}/commits/main`) {
        assert.equal(init.method, "GET");
        return json({ sha: mainSha });
      }
      if (url.pathname === "/search/issues") {
        assert.equal(init.method, "GET");
        assert.equal(url.searchParams.get("q"), `repo:${repo} is:issue in:title ${marker}`);
        return json({ total_count: existing ? 1 : 0, incomplete_results: incomplete,
          items: existing ? [existing] : [] });
      }
      if (url.pathname === `/repos/${repo}/issues` && init.method === "POST") {
        assert.deepEqual(JSON.parse(init.body), { title, body });
        if (createThrows) throw new Error("PRIVATE RESPONSE");
        return json(issue(), 201);
      }
      if (url.pathname === `/repos/${repo}/issues/987` && init.method === "PATCH") {
        assert.deepEqual(JSON.parse(init.body), { state: "closed", state_reason: "completed" });
        if (closeThrows) throw new Error("PRIVATE RESPONSE");
        return json(issue("closed"));
      }
      if (url.pathname === `/repos/${repo}/issues/987` && init.method === "GET") {
        return json(issue("closed"));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    },
  };
}

test("main-only disabled repair gates reject before any network access", async () => {
  for (const change of [
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY: "other/repo" },
    { TICKET_REPAIR_ENABLED: "true" },
    { AUTO_MERGE_ENABLED: "true" },
  ]) {
    const f = fixture();
    await assert.rejects(runTerraIssueOneShot({ env: { ...baseEnv, ...change }, ...f }),
      { code: "terra_issue_configuration_invalid" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.terraCalls(), 0);
  }
});

test("main SHA mismatch rejects before Terra or GitHub write", async () => {
  const f = fixture({ mainSha: "b".repeat(40) });
  await assert.rejects(runTerraIssueOneShot({ env: baseEnv, ...f }),
    { code: "terra_issue_main_changed" });
  assert.deepEqual(f.calls.map((x) => x.method), ["GET"]);
  assert.equal(f.terraCalls(), 0);
});

test("fixed Terra confirmation creates and closes one exact synthetic issue", async () => {
  const f = fixture();
  const result = await runTerraIssueOneShot({ env: baseEnv, ...f });
  assert.deepEqual(result, { ok: true, issueNumber: 987, issueClosed: true,
    terraCalled: true, recovered: false });
  assert.equal(f.terraCalls(), 1);
  assert.deepEqual(f.calls.map((x) => x.method),
    ["GET", "GET", "GET", "POST", "PATCH", "GET"]);
  assert.equal(JSON.stringify(result).includes(baseEnv.GH_TOKEN), false);
});

test("existing closed issue is idempotent and skips Terra", async () => {
  const f = fixture({ existing: { number: 987, title, body, state: "closed" } });
  const result = await runTerraIssueOneShot({ env: baseEnv, ...f });
  assert.equal(result.recovered, true);
  assert.equal(result.terraCalled, false);
  assert.deepEqual(f.calls.map((x) => x.method), ["GET", "GET"]);
  assert.equal(f.terraCalls(), 0);
});

test("existing open issue is closed without a second Terra call", async () => {
  const f = fixture({ existing: { number: 987, title, body, state: "open" } });
  const result = await runTerraIssueOneShot({ env: baseEnv, ...f });
  assert.equal(result.recovered, true);
  assert.deepEqual(f.calls.map((x) => x.method), ["GET", "GET", "PATCH", "GET"]);
  assert.equal(f.terraCalls(), 0);
});

test("ambiguous, changed, or incomplete search fails before Terra or write", async () => {
  for (const options of [
    { existing: { number: 987, title, body: "changed", state: "open" } },
    { incomplete: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(runTerraIssueOneShot({ env: baseEnv, ...f }));
    assert.deepEqual(f.calls.map((x) => x.method), ["GET", "GET"]);
    assert.equal(f.terraCalls(), 0);
  }
});

test("Terra failure never creates an issue", async () => {
  const f = fixture();
  await assert.rejects(runTerraIssueOneShot({ env: baseEnv, ...f,
    terraImpl: async () => ({ ...confirmedTerra, ok: false }) }),
  { code: "terra_issue_terra_unconfirmed" });
  assert.deepEqual(f.calls.map((x) => x.method), ["GET", "GET"]);
});

test("uncertain issue creation or close is never retried or logged", async () => {
  for (const [options, code, methods] of [
    [{ createThrows: true }, "terra_issue_create_outcome_uncertain",
      ["GET", "GET", "GET", "POST"]],
    [{ closeThrows: true }, "terra_issue_close_outcome_uncertain",
      ["GET", "GET", "GET", "POST", "PATCH"]],
  ]) {
    const f = fixture(options);
    await assert.rejects(runTerraIssueOneShot({ env: baseEnv, ...f }), { code });
    assert.deepEqual(f.calls.map((x) => x.method), methods);
  }
});
