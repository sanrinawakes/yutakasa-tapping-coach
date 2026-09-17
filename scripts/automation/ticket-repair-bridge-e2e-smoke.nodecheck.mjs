import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeE2eSmokeError, checkGate, cleanupRemote,
  createSyntheticInvestigatorFetch, inspectChecks,
  rescueBridgeE2eSmoke } from "./ticket-repair-bridge-e2e-smoke.mjs";
import { BRIDGE_SUPPORT_BODY, TEST_SUPPORT_ACK, TEST_SUPPORT_SUBJECT } from
  "./ai-repair-functional-smoke.mjs";

const repo = "sanrinawakes/yutakasa-tapping-coach";
const sha = "a".repeat(40);
const headSha = "b".repeat(40);
const workId = crypto.randomUUID();
const id = crypto.createHash("sha256").update(workId).digest("hex").slice(0, 16);
const branch = `codex/yutakasa-support-ai-${id}`;
const title = `Yutakasa support repair ${id}`;
const body = `Private support reference: ${id}\nCustomer content and identifiers are stored only in the private support database.\nThis draft is unverified. Do not send a customer reply until the exact release passes production observation.`;
const runId = String(800_000_000 + crypto.randomInt(100_000_000));
const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: repo,
  GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_RUN_ID: runId,
  GITHUB_RUN_ATTEMPT: "1", YUTAKASA_BRIDGE_E2E_SMOKE_ENABLED: "true",
  TICKET_REPAIR_ENABLED: "false", AUTO_MERGE_ENABLED: "false",
  SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s".repeat(40),
  GH_TOKEN: "g".repeat(40), GH_READ_TOKEN: "r".repeat(40) };
const sidecar = path.join(os.tmpdir(), `yutakasa-ticket-bridge-e2e-${runId}.json.publish`);
function savePublish(prNumber = 99, prSha = headSha) {
  fs.writeFileSync(sidecar, `${JSON.stringify({ branch, workId, prNumber,
    headSha: prSha })}\n`, { mode: 0o600, flag: "wx" });
}
function pr(state) {
  return { number: 99, title, body, state, draft: true, merged_at: null,
    base: { ref: "main", sha }, head: { ref: branch, sha: headSha,
      repo: { full_name: repo } } };
}
function run(workflow, status = "completed", conclusion = "success") {
  return { id: 1, head_sha: headSha, head_branch: branch,
    event: "pull_request", path: `.github/workflows/${workflow}`, status, conclusion };
}
const workflows = [
  { workflow_runs: [run("source-repair-ci.yml")] },
  { workflow_runs: [run("ai-repair-independent-review.yml")] },
];
const vercel = { sha: headSha, statuses: [{ context: "Vercel", state: "success",
  description: "Deployment has completed",
  target_url: "https://vercel.com/sanrinawakes-projects/yutakasa-tapping-coach/preview" }] };

test("manual main gate requires both real repair flags off", () => {
  assert.doesNotThrow(() => checkGate(env, sha, "main", true));
  for (const [field, value] of Object.entries({ GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/feature", YUTAKASA_BRIDGE_E2E_SMOKE_ENABLED: "false",
    TICKET_REPAIR_ENABLED: "true", AUTO_MERGE_ENABLED: "true" })) {
    assert.throws(() => checkGate({ ...env, [field]: value }, sha, "main", true),
      BridgeE2eSmokeError);
  }
  assert.throws(() => checkGate(env, sha, "feature", true), BridgeE2eSmokeError);
  assert.throws(() => checkGate(env, headSha, "main", true), BridgeE2eSmokeError);
});

test("only a confirmed synthetic context adds exact two-file guidance to Terra", async () => {
  const ticketId = crypto.randomUUID();
  const latestUserMessageId = crypto.randomUUID();
  const identity = { workId, ticketId, latestUserMessageId };
  const context = { work_id: workId, ticket_id: ticketId,
    latest_user_message_id: latestUserMessageId, category: "technical",
    subject: TEST_SUPPORT_SUBJECT, messages: [
      { id: crypto.randomUUID(), sender_type: "system", body: TEST_SUPPORT_ACK },
      { id: latestUserMessageId, sender_type: "user", body: BRIDGE_SUPPORT_BODY },
    ] };
  const request = { model: "gpt-5.6-terra", store: false, tools: [],
    input: [{ role: "developer", content: "Original private investigation rule." },
      { role: "user", content: "Synthetic repository context." }],
    text: { format: { type: "json_schema" } } };
  let modelRequest = null;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/claim_yutakasa_ticket_repair_context")) {
      return new Response(JSON.stringify(context), { status: 200 });
    }
    if (String(url) === "https://api.openai.com/v1/responses") {
      modelRequest = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }
    assert.fail("unexpected request");
  };
  const scopedFetch = createSyntheticInvestigatorFetch(fetchImpl, env, identity);
  const modelUrl = "https://api.openai.com/v1/responses";
  await assert.rejects(() => scopedFetch(modelUrl, { method: "POST",
    body: JSON.stringify(request) }),
  (error) => error instanceof BridgeE2eSmokeError &&
    error.code === "bridge_terra_request_invalid");
  assert.equal(modelRequest, null);
  await scopedFetch(`${env.SUPABASE_URL}/rest/v1/rpc/claim_yutakasa_ticket_repair_context`,
    { method: "POST" });
  await scopedFetch(modelUrl, { method: "POST", body: JSON.stringify(request) });
  assert.equal(modelRequest.model, "gpt-5.6-terra");
  assert.equal(modelRequest.store, false);
  assert.deepEqual(modelRequest.tools, []);
  assert.equal(modelRequest.input[1].content, request.input[1].content);
  assert.ok(modelRequest.input[0].content.startsWith(request.input[0].content));
  assert.match(modelRequest.input[0].content,
    /exactly two existing files: src\/lib\/chat-thread\.ts and src\/lib\/chat-thread\.test\.ts/u);
  assert.match(modelRequest.input[0].content, /Change both files and no others/u);
  assert.equal(request.input[0].content, "Original private investigation rule.");

  const wrongContextFetch = createSyntheticInvestigatorFetch(async () =>
    new Response(JSON.stringify({ ...context, subject: "unexpected" }), { status: 200 }),
  env, identity);
  await assert.rejects(() => wrongContextFetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/claim_yutakasa_ticket_repair_context`,
    { method: "POST" }),
  (error) => error instanceof BridgeE2eSmokeError &&
    error.code === "bridge_claimed_context_changed");
});

test("required PR checks are tied to the exact branch and SHA", () => {
  assert.deepEqual(inspectChecks({ runs: workflows, status: vercel, branch,
    sha: headSha }), { status: "passed" });
  assert.deepEqual(inspectChecks({ runs: [{ workflow_runs: [] }, workflows[1]],
    status: vercel, branch, sha: headSha }), { status: "pending" });
  assert.throws(() => inspectChecks({ runs: [{ workflow_runs: [
    run("source-repair-ci.yml", "completed", "failure") ] }, workflows[1]],
    status: vercel, branch, sha: headSha }), BridgeE2eSmokeError);
  assert.throws(() => inspectChecks({ runs: workflows,
    status: { ...vercel, sha }, branch, sha: headSha }), BridgeE2eSmokeError);
});

test("remote cleanup closes only the exact draft then deletes only its unchanged head", async () => {
  savePublish();
  let closed = false;
  let deleted = false;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    calls.push(`${init.method}:${target.pathname}`);
    if (target.host === "fixture.supabase.co") {
      return new Response(JSON.stringify([{ work_id: workId, status: "pr_open",
        claimed_run_id: Number(runId), pr_number: 99, head_sha: headSha }]));
    }
    assert.equal(init.headers.Authorization,
      `Bearer ${init.method === "GET" ? env.GH_READ_TOKEN : env.GH_TOKEN}`);
    if (target.pathname.endsWith("/pulls/99")) {
      if (init.method === "PATCH") closed = true;
      return new Response(JSON.stringify(pr(closed ? "closed" : "open")));
    }
    if (target.pathname.includes("/git/ref/heads/")) {
      return deleted ? new Response(null, { status: 404 }) :
        new Response(JSON.stringify({ ref: `refs/heads/${branch}`,
          object: { sha: headSha } }));
    }
    assert.fail(`unexpected ${target.pathname}`);
  };
  try {
    const result = await cleanupRemote({ env, fetchImpl, workId,
      deleteRef: async (_, identity, expected) => {
        assert.equal(identity.branch, branch);
        assert.equal(expected, headSha);
        assert.equal(closed, true);
        deleted = true; calls.push("LEASE_DELETE");
      } });
    assert.deepEqual(result, { prClosed: true, branchDeleted: true,
      prNumber: 99, headSha });
    assert.equal(calls.filter((item) => item === "LEASE_DELETE").length, 1);
    const repeated = await cleanupRemote({ env, fetchImpl, workId,
      deleteRef: async () => assert.fail("must not delete twice") });
    assert.deepEqual(repeated, result);
  } finally { fs.rmSync(sidecar, { force: true }); }
});

test("uncertain publisher result leaves DB and branch untouched", async () => {
  savePublish(null, null);
  let lookups = 0;
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    if (target.host === "fixture.supabase.co") return new Response("[]");
    assert.equal(init.method, "GET");
    if (target.pathname.endsWith("/pulls")) {
      lookups += 1; return new Response("[]");
    }
    if (target.pathname.includes("/git/ref/heads/")) return new Response(null, { status: 404 });
    assert.fail("no mutation may occur");
  };
  try {
    await assert.rejects(() => cleanupRemote({ env, fetchImpl, workId,
      sleep: async () => {}, deleteRef: async () => assert.fail("must not delete") }),
    (error) => error instanceof BridgeE2eSmokeError &&
      error.code === "bridge_publication_uncertain");
    assert.equal(lookups, 4);
  } finally { fs.rmSync(sidecar, { force: true }); }
});

test("a changed branch head stops before closing the PR or deleting the branch", async () => {
  savePublish();
  const methods = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    methods.push(init.method);
    if (target.host === "fixture.supabase.co") {
      return new Response(JSON.stringify([{ work_id: workId, status: "pr_open",
        claimed_run_id: Number(runId), pr_number: 99, head_sha: headSha }]));
    }
    if (target.pathname.endsWith("/pulls/99")) return new Response(JSON.stringify(pr("open")));
    if (target.pathname.includes("/git/ref/heads/")) {
      return new Response(JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha } }));
    }
    assert.fail("unexpected lookup");
  };
  try {
    await assert.rejects(() => cleanupRemote({ env, fetchImpl, workId,
      deleteRef: async () => assert.fail("must not delete") }),
    (error) => error instanceof BridgeE2eSmokeError &&
      error.code === "bridge_remote_identity_uncertain");
    assert.deepEqual(methods, ["GET", "GET", "GET"]);
  } finally { fs.rmSync(sidecar, { force: true }); }
});

test("an observed PR is recorded before cleanup so rescue can retry", async () => {
  savePublish(null, null);
  let closed = false;
  let deleted = false;
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    if (target.host === "fixture.supabase.co") {
      return new Response(JSON.stringify([{ work_id: workId, status: "investigating",
        claimed_run_id: Number(runId), pr_number: null, head_sha: null }]));
    }
    if (target.pathname.endsWith("/pulls")) return new Response(JSON.stringify([pr("open")]));
    if (target.pathname.endsWith("/pulls/99")) {
      if (init.method === "PATCH") closed = true;
      return new Response(JSON.stringify(pr(closed ? "closed" : "open")));
    }
    if (target.pathname.includes("/git/ref/heads/")) {
      return deleted ? new Response(null, { status: 404 }) :
        new Response(JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: headSha } }));
    }
    assert.fail("unexpected lookup");
  };
  try {
    await cleanupRemote({ env, fetchImpl, workId,
      deleteRef: async () => {
        const saved = JSON.parse(fs.readFileSync(sidecar, "utf8"));
        assert.equal(saved.prNumber, 99);
        assert.equal(saved.headSha, headSha);
        deleted = true;
      } });
    const retried = await cleanupRemote({ env, fetchImpl, workId,
      deleteRef: async () => assert.fail("must not delete twice") });
    assert.equal(retried.prClosed, true);
  } finally { fs.rmSync(sidecar, { force: true }); }
});

test("missing rescue state performs no remote or database mutation", async () => {
  const result = await rescueBridgeE2eSmoke({ env, fetchImpl: async () =>
    assert.fail("no request"), remoteCleanup: async () => assert.fail("no cleanup"),
    cleanup: async () => assert.fail("no database cleanup") });
  assert.deepEqual(result, { ok: true, rescued: false });
});
