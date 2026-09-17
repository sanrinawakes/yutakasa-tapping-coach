#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { TEST_SUPPORT_ACK, TEST_SUPPORT_BODY, TEST_SUPPORT_SUBJECT } from
  "./ai-repair-functional-smoke.mjs";
import { cleanupTicketRepairSmoke, runTicketRepairHandoffSmoke } from
  "./ticket-repair-handoff-smoke.mjs";
import { runTerraIssueOneShot } from "./terra-issue-one-shot.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUN_ID = /^[1-9][0-9]{0,17}$/u;

export class TicketTerraIssueSmokeError extends Error {
  constructor(code) { super(code); this.name = "TicketTerraIssueSmokeError"; this.code = code; }
}
function fail(code) { throw new TicketTerraIssueSmokeError(code); }

function statePath(env) {
  if (!RUN_ID.test(env.GITHUB_RUN_ID ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))) {
    fail("ticket_terra_issue_run_id_invalid");
  }
  return path.join(os.tmpdir(), `yutakasa-ticket-terra-issue-${env.GITHUB_RUN_ID}.json`);
}

function validateEnvironment(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      !RUN_ID.test(env.GITHUB_RUN_ID ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) ||
      !RUN_ID.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)) ||
      env.TICKET_REPAIR_ENABLED !== "false" ||
      env.AUTO_MERGE_ENABLED !== "false" ||
      typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length < 20 ||
      /[\r\n]/u.test(env.GH_TOKEN)) fail("ticket_terra_issue_configuration_invalid");
}

async function databaseJson(env, fetchImpl, route, body = null) {
  const url = new URL(`/rest/v1/${route}`, env.SUPABASE_URL);
  const response = await fetchImpl(url, {
    method: body === null ? "GET" : "POST",
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
      ...(body === null ? {} : { "content-type": "application/json" }) },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("ticket_terra_issue_database_request_failed"));
  if (response.status !== 200) fail("ticket_terra_issue_database_http_failure");
  const raw = await response.text().catch(() => fail("ticket_terra_issue_database_body_failed"));
  if (Buffer.byteLength(raw) > 64 * 1024) fail("ticket_terra_issue_database_response_large");
  try { return JSON.parse(raw); } catch { fail("ticket_terra_issue_database_response_invalid"); }
}

function validateClaimedContext(context, { ticketId, workId, latestUserMessageId }) {
  if (context?.work_id !== workId || context?.ticket_id !== ticketId ||
      context?.latest_user_message_id !== latestUserMessageId ||
      context?.category !== "technical" || context?.subject !== TEST_SUPPORT_SUBJECT ||
      !Array.isArray(context?.messages) || context.messages.length !== 2 ||
      context.messages.filter((message) => message?.sender_type === "user" &&
        message?.id === latestUserMessageId && message?.body === TEST_SUPPORT_BODY).length !== 1 ||
      context.messages.filter((message) => message?.sender_type === "system" &&
        message?.body === TEST_SUPPORT_ACK && UUID.test(message?.id ?? "")).length !== 1) {
    fail("ticket_terra_issue_context_mismatch");
  }
}

async function verifyManualReview(env, fetchImpl, { ticketId, workId }) {
  const jobs = await databaseJson(env, fetchImpl,
    `yutakasa_ticket_repair_jobs?work_id=eq.${workId}&select=work_id,ticket_id,status,attempt_count,claimed_run_id,pr_number,head_sha&limit=2`);
  const tickets = await databaseJson(env, fetchImpl,
    `support_tickets?id=eq.${ticketId}&select=id,category,status,automation_status,decision_required&limit=2`);
  if (!Array.isArray(jobs) || jobs.length !== 1 ||
      jobs[0]?.work_id !== workId || jobs[0]?.ticket_id !== ticketId ||
      jobs[0]?.status !== "failed" || jobs[0]?.attempt_count !== 1 ||
      jobs[0]?.claimed_run_id !== Number(env.GITHUB_RUN_ID) ||
      jobs[0]?.pr_number !== null || jobs[0]?.head_sha !== null ||
      !Array.isArray(tickets) || tickets.length !== 1 ||
      tickets[0]?.id !== ticketId || tickets[0]?.category !== "technical" ||
      tickets[0]?.status !== "in_progress" ||
      tickets[0]?.automation_status !== "manual_review" ||
      tickets[0]?.decision_required !== false) {
    fail("ticket_terra_issue_manual_review_unconfirmed");
  }
}

/** Does not dispatch ticket-repair.yml or invoke the PR publisher. */
export async function runTicketTerraIssueSmoke({ env = process.env,
  fetchImpl = globalThis.fetch,
  handoffImpl = runTicketRepairHandoffSmoke,
  issueImpl = runTerraIssueOneShot,
} = {}) {
  validateEnvironment(env);
  let proof = null;
  const handoff = await handoffImpl({ env, fetchImpl,
    cleanupRpcName: "cleanup_yutakasa_ticket_terra_issue_smoke",
    statePath: statePath(env),
    afterQueued: async (identity) => {
      const { ticketId, workId, latestUserMessageId } = identity;
      const context = await databaseJson(env, fetchImpl,
        "rpc/claim_yutakasa_ticket_repair_context", {
          p_work_id: workId, p_run_id: Number(env.GITHUB_RUN_ID),
        });
      let primaryError = null;
      let issue = null;
      try {
        validateClaimedContext(context, { ticketId, workId, latestUserMessageId });
        issue = await issueImpl({ env, fetchImpl, issueMode: "synthetic_ticket" });
        if (issue?.ok !== true || issue.issueClosed !== true ||
            issue.terraCalled !== true || issue.recovered !== false ||
            !Number.isSafeInteger(issue.issueNumber) || issue.issueNumber < 1) {
          fail("ticket_terra_issue_provider_proof_incomplete");
        }
      } catch (error) { primaryError = error; }
      // Even if Terra or GitHub fails, use the real ownership-checked failure
      // RPC so the synthetic ticket enters the same private review state.
      const failed = await databaseJson(env, fetchImpl,
        "rpc/fail_yutakasa_ticket_repair_work", {
          p_work_id: workId, p_run_id: Number(env.GITHUB_RUN_ID),
          p_reason_code: "synthetic_terra_issue_probe",
        });
      if (!Array.isArray(failed) || failed.length !== 1 || failed[0]?.status !== "failed") {
        fail("ticket_terra_issue_failure_transition_unconfirmed");
      }
      await verifyManualReview(env, fetchImpl, { ticketId, workId });
      if (primaryError) throw primaryError;
      proof = { issueNumber: issue.issueNumber, terraCalled: true,
        issueClosed: true, manualReviewVerified: true };
    },
  });
  if (!proof || handoff?.syntheticDataCleaned !== true) {
    fail("ticket_terra_issue_incomplete");
  }
  return { ok: true, mainSha: handoff.mainSha,
    deploymentId: handoff.deploymentId, ...proof, syntheticDataCleaned: true };
}

/** Called by an always-running workflow step after the main job step exits. */
export async function rescueTicketTerraIssueSmoke({ env = process.env,
  fetchImpl = globalThis.fetch,
  cleanupImpl = cleanupTicketRepairSmoke } = {}) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      typeof env.SUPABASE_URL !== "string" ||
      !/^https:\/\/[a-z0-9-]+\.supabase\.co$/u.test(env.SUPABASE_URL) ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
      env.SUPABASE_SERVICE_ROLE_KEY.length < 20) {
    fail("ticket_terra_issue_rescue_configuration_invalid");
  }
  const file = statePath(env);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === "ENOENT") return { ok: true, rescued: false };
    fail("ticket_terra_issue_rescue_state_unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 || stat.size > 512 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    fail("ticket_terra_issue_rescue_state_unsafe");
  }
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail("ticket_terra_issue_rescue_state_invalid"); }
  if (saved?.version !== 1 || saved.ghRunId !== Number(env.GITHUB_RUN_ID) ||
      !UUID.test(saved.runId ?? "") || !UUID.test(saved.workId ?? "") ||
      !UUID.test(saved.lockToken ?? "") ||
      Object.keys(saved).sort().join(",") !== "ghRunId,lockToken,runId,version,workId") {
    fail("ticket_terra_issue_rescue_state_invalid");
  }
  const email = `yutakasa-auto-smoke+${saved.runId}@example.invalid`;
  await cleanupImpl(env, fetchImpl, email, saved.runId, null,
    saved.workId, saved.lockToken, {
      rpcName: "cleanup_yutakasa_ticket_terra_issue_smoke",
      ghRunId: saved.ghRunId, postInvestigation: true,
    });
  fs.unlinkSync(file);
  return { ok: true, rescued: true };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const task = process.argv[2] === "rescue"
    ? rescueTicketTerraIssueSmoke() : process.argv.length === 2
      ? runTicketTerraIssueSmoke() : Promise.reject(new TicketTerraIssueSmokeError(
        "ticket_terra_issue_usage_invalid"));
  task.then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const code = typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code)
        ? error.code : "ticket_terra_issue_failed";
      process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    },
  );
}
