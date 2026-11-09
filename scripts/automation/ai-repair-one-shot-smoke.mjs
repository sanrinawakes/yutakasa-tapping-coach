#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectRemoteDeployment } from "./remote-production.mjs";
import { runProductionFunctionalSmoke } from "./ai-repair-functional-smoke.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const CHAT_PROVIDER_PATHS = {
  gemini: new Set(["gemini"]),
  openai: new Set(["openai_primary", "openai_fallback", "openai_circuit"]),
};

export class OneShotSmokeError extends Error {
  constructor(code) { super(code); this.name = "OneShotSmokeError"; this.code = code; }
}
function fail(code) { throw new OneShotSmokeError(code); }

function providerProofComplete(evidence) {
  const turns = evidence?.providerProvenance?.turns;
  return evidence?.providerProvenance?.status === "verified" &&
    evidence?.assistantIdsBound === true && Array.isArray(turns) && turns.length === 2 &&
    turns.every((turn) => typeof turn?.provider === "string" &&
      typeof turn?.path === "string" &&
      Object.hasOwn(CHAT_PROVIDER_PATHS, turn.provider) &&
      CHAT_PROVIDER_PATHS[turn.provider].has(turn.path));
}

/** A manually dispatched main-only probe. It never writes the repair-release ledger. */
export async function runOneShotSmoke({
  env = process.env,
  fetchImpl = globalThis.fetch,
  deploymentImpl = collectRemoteDeployment,
  smokeImpl = runProductionFunctionalSmoke,
  includeSupportTicket = true,
} = {}) {
  if (typeof includeSupportTicket !== "boolean") fail("one_shot_scope_invalid");
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      !SHA.test(env.GITHUB_SHA ?? "")) fail("one_shot_trusted_main_required");
  const before = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  if (before?.ready !== true || before.mainSha !== env.GITHUB_SHA) {
    fail("one_shot_production_not_at_main");
  }
  const evidence = await smokeImpl({
    release: { merge_sha: env.GITHUB_SHA }, deployment: before,
    env, fetchImpl, includeSupportTicket, requireProviderProof: true,
  });
  if (evidence?.mergeSha !== before.mainSha || evidence.deploymentId !== before.deploymentId ||
      evidence.testDataCleaned !== true || evidence.desktopBrowser !== true ||
      evidence.mobileBrowser !== true || evidence.streamComplete !== true ||
      evidence.databaseSaved !== true || evidence.reloadPersisted !== true ||
      !providerProofComplete(evidence) || evidence.clientErrors !== 0 ||
      (includeSupportTicket && (evidence.support?.ticketCreated !== true ||
        evidence.support?.idempotent !== true || evidence.support?.messagesSaved !== true ||
        evidence.support?.queueIsolated !== true)) ||
      (!includeSupportTicket && evidence.support != null)) {
    fail("one_shot_smoke_evidence_incomplete");
  }
  const after = await deploymentImpl({ token: env.VERCEL_TOKEN, fetchImpl });
  if (after?.ready !== true || after.mainSha !== before.mainSha ||
      after.deploymentId !== before.deploymentId) fail("one_shot_production_changed");
  return {
    ok: true,
    mainSha: before.mainSha,
    deploymentId: before.deploymentId,
    desktopBrowser: true,
    mobileBrowser: true,
    testDataCleaned: true,
    providerProof: true,
    providers: evidence.providerProvenance.turns.map(({ provider, path }) => ({
      provider, path,
    })),
    ...(includeSupportTicket ? {
      supportTicketCreated: true,
      supportQueueIsolated: true,
    } : { supportTicketChecked: false }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const validArguments = args.length === 0 ||
    (args.length === 1 && args[0] === "--chat-only");
  const run = validArguments
    ? runOneShotSmoke({ includeSupportTicket: args[0] !== "--chat-only" })
    : Promise.reject(new OneShotSmokeError("one_shot_arguments_invalid"));
  run.then(
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
