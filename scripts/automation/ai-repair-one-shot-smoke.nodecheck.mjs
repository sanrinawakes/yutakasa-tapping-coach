import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { OneShotSmokeError, runOneShotSmoke } from "./ai-repair-one-shot-smoke.mjs";

const sha = "a".repeat(40);
const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha,
  VERCEL_TOKEN: "v".repeat(40),
};
const deployment = { mainSha: sha, deploymentId: "dpl_Abcdefghijklmnop", ready: true };
const evidence = { mergeSha: sha, deploymentId: deployment.deploymentId,
  testDataCleaned: true, desktopBrowser: true, mobileBrowser: true,
  streamComplete: true, databaseSaved: true, reloadPersisted: true, clientErrors: 0,
  providerProvenance: { status: "verified", turns: [
    { provider: "gemini", path: "gemini" },
    { provider: "openai", path: "openai_fallback" },
  ] },
  assistantIdsBound: true,
  support: { ticketCreated: true, idempotent: true, messagesSaved: true, queueIsolated: true } };

test("workflow exposes a boolean chat-only input and selects only fixed CLI commands", () => {
  const workflow = readFileSync(new URL(
    "../../.github/workflows/ai-repair-one-shot-smoke.yml", import.meta.url
  ), "utf8");
  assert.match(workflow,
    /chat_only:\n\s+description: [^\n]+\n\s+required: true\n\s+type: boolean\n\s+default: false/u);
  assert.match(workflow, /YUTAKASA_ONE_SHOT_CHAT_ONLY: \$\{\{ inputs\.chat_only \}\}/u);
  assert.match(workflow,
    /true\) exec node scripts\/automation\/ai-repair-one-shot-smoke\.mjs --chat-only ;;/u);
  assert.match(workflow,
    /false\) exec node scripts\/automation\/ai-repair-one-shot-smoke\.mjs ;;/u);
  assert.doesNotMatch(workflow,
    /node scripts\/automation\/ai-repair-one-shot-smoke\.mjs[^\n]*\$\{\{/u);
});

test("manual main-only guard stops PR or schedule contexts before external access", async () => {
  for (const key of ["GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_SHA"]) {
    let calls = 0;
    await assert.rejects(() => runOneShotSmoke({ env: { ...env, [key]: "invalid" },
      deploymentImpl: async () => { calls += 1; return deployment; } }),
    (error) => error instanceof OneShotSmokeError && error.code === "one_shot_trusted_main_required");
    assert.equal(calls, 0);
  }
});

test("production SHA mismatch stops before any synthetic writes", async () => {
  let smokeCalls = 0;
  await assert.rejects(() => runOneShotSmoke({ env,
    deploymentImpl: async () => ({ ...deployment, mainSha: "b".repeat(40) }),
    smokeImpl: async () => { smokeCalls += 1; } }),
  (error) => error instanceof OneShotSmokeError && error.code === "one_shot_production_not_at_main");
  assert.equal(smokeCalls, 0);
});

test("one-shot probe requires support evidence and unchanged production after cleanup", async () => {
  const calls = [];
  const result = await runOneShotSmoke({ env,
    deploymentImpl: async () => { calls.push("parity"); return deployment; },
    smokeImpl: async (args) => {
      calls.push("smoke");
      assert.equal(args.includeSupportTicket, true);
      assert.equal(args.requireProviderProof, true);
      assert.equal(args.release.merge_sha, sha);
      assert.equal(args.deployment, deployment);
      return evidence;
    },
  });
  assert.deepEqual(calls, ["parity", "smoke", "parity"]);
  assert.deepEqual(result, { ok: true, mainSha: sha, deploymentId: deployment.deploymentId,
    desktopBrowser: true, mobileBrowser: true, supportTicketCreated: true,
    supportQueueIsolated: true, testDataCleaned: true, providerProof: true,
    providers: [
      { provider: "gemini", path: "gemini" },
      { provider: "openai", path: "openai_fallback" },
    ] });
});

test("chat-only mode proves provider continuity without entering the support path", async () => {
  const calls = [];
  const result = await runOneShotSmoke({ env, includeSupportTicket: false,
    deploymentImpl: async () => deployment,
    smokeImpl: async (args) => {
      calls.push(args.includeSupportTicket);
      return { ...evidence, support: undefined };
    },
  });
  assert.deepEqual(calls, [false]);
  assert.deepEqual(result, {
    ok: true, mainSha: sha, deploymentId: deployment.deploymentId,
    desktopBrowser: true, mobileBrowser: true, testDataCleaned: true,
    providerProof: true,
    providers: [
      { provider: "gemini", path: "gemini" },
      { provider: "openai", path: "openai_fallback" },
    ],
    supportTicketChecked: false,
  });
});

test("chat-only mode rejects evidence that claims the support path ran", async () => {
  await assert.rejects(() => runOneShotSmoke({ env, includeSupportTicket: false,
    deploymentImpl: async () => deployment,
    smokeImpl: async () => evidence,
  }), (error) => error instanceof OneShotSmokeError &&
    error.code === "one_shot_smoke_evidence_incomplete");
});

test("missing cleanup evidence cannot produce a successful run", async () => {
  await assert.rejects(() => runOneShotSmoke({ env,
    deploymentImpl: async () => deployment,
    smokeImpl: async () => ({ ...evidence, testDataCleaned: false }) }),
  (error) => error instanceof OneShotSmokeError && error.code === "one_shot_smoke_evidence_incomplete");
});

test("missing or invalid provider provenance cannot produce a successful run", async () => {
  for (const providerEvidence of [
    { providerProvenance: { status: "unknown", turns: [
      { provider: "unknown", path: "unknown" },
      { provider: "unknown", path: "unknown" },
    ] }, assistantIdsBound: false },
    { providerProvenance: { status: "verified", turns: [
      { provider: "gemini", path: "openai_fallback" },
      { provider: "openai", path: "openai_fallback" },
    ] }, assistantIdsBound: true },
  ]) {
    await assert.rejects(() => runOneShotSmoke({ env,
      deploymentImpl: async () => deployment,
      smokeImpl: async () => ({ ...evidence, ...providerEvidence }) }),
    (error) => error instanceof OneShotSmokeError &&
      error.code === "one_shot_smoke_evidence_incomplete");
  }
});

test("main deployment changing during the run fails after cleanup", async () => {
  let calls = 0;
  await assert.rejects(() => runOneShotSmoke({ env,
    deploymentImpl: async () => ++calls === 1 ? deployment : { ...deployment, deploymentId: "dpl_DifferentDeployment" },
    smokeImpl: async () => evidence }),
  (error) => error instanceof OneShotSmokeError && error.code === "one_shot_production_changed");
});
