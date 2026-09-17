import assert from "node:assert/strict";
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
  support: { ticketCreated: true, idempotent: true, messagesSaved: true, queueIsolated: true } };

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
      assert.equal(args.release.merge_sha, sha);
      assert.equal(args.deployment, deployment);
      return evidence;
    },
  });
  assert.deepEqual(calls, ["parity", "smoke", "parity"]);
  assert.deepEqual(result, { ok: true, mainSha: sha, deploymentId: deployment.deploymentId,
    desktopBrowser: true, mobileBrowser: true, supportTicketCreated: true,
    supportQueueIsolated: true, testDataCleaned: true });
});

test("missing cleanup evidence cannot produce a successful run", async () => {
  await assert.rejects(() => runOneShotSmoke({ env,
    deploymentImpl: async () => deployment,
    smokeImpl: async () => ({ ...evidence, testDataCleaned: false }) }),
  (error) => error instanceof OneShotSmokeError && error.code === "one_shot_smoke_evidence_incomplete");
});

test("main deployment changing during the run fails after cleanup", async () => {
  let calls = 0;
  await assert.rejects(() => runOneShotSmoke({ env,
    deploymentImpl: async () => ++calls === 1 ? deployment : { ...deployment, deploymentId: "dpl_DifferentDeployment" },
    smokeImpl: async () => evidence }),
  (error) => error instanceof OneShotSmokeError && error.code === "one_shot_production_changed");
});
