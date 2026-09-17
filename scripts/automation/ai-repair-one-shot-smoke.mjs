#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectRemoteDeployment } from "./remote-production.mjs";
import { runProductionFunctionalSmoke } from "./ai-repair-functional-smoke.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;

export class OneShotSmokeError extends Error {
  constructor(code) { super(code); this.name = "OneShotSmokeError"; this.code = code; }
}
function fail(code) { throw new OneShotSmokeError(code); }

/** A manually dispatched main-only probe. It never writes the repair-release ledger. */
export async function runOneShotSmoke({
  env = process.env,
  fetchImpl = globalThis.fetch,
  deploymentImpl = collectRemoteDeployment,
  smokeImpl = runProductionFunctionalSmoke,
} = {}) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      !SHA.test(env.GITHUB_SHA ?? "")) fail("one_shot_trusted_main_required");
  const before = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  if (before?.ready !== true || before.mainSha !== env.GITHUB_SHA) {
    fail("one_shot_production_not_at_main");
  }
  const evidence = await smokeImpl({
    release: { merge_sha: env.GITHUB_SHA }, deployment: before,
    env, fetchImpl, includeSupportTicket: true,
  });
  if (evidence?.mergeSha !== before.mainSha || evidence.deploymentId !== before.deploymentId ||
      evidence.testDataCleaned !== true || evidence.desktopBrowser !== true ||
      evidence.mobileBrowser !== true || evidence.streamComplete !== true ||
      evidence.databaseSaved !== true || evidence.reloadPersisted !== true ||
      evidence.clientErrors !== 0 || evidence.support?.ticketCreated !== true ||
      evidence.support?.idempotent !== true || evidence.support?.messagesSaved !== true ||
      evidence.support?.queueIsolated !== true) fail("one_shot_smoke_evidence_incomplete");
  const after = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  if (after?.ready !== true || after.mainSha !== before.mainSha ||
      after.deploymentId !== before.deploymentId) fail("one_shot_production_changed");
  return {
    ok: true,
    mainSha: before.mainSha,
    deploymentId: before.deploymentId,
    desktopBrowser: true,
    mobileBrowser: true,
    supportTicketCreated: true,
    supportQueueIsolated: true,
    testDataCleaned: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runOneShotSmoke().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const code = error instanceof OneShotSmokeError ||
        (typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code))
        ? error.code : "one_shot_smoke_failed";
      process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    },
  );
}
