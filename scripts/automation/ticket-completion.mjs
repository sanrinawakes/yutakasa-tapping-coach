#!/usr/bin/env node

import { collectRemoteDeployment } from "./remote-production.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/u;
const DEPLOYMENT = /^dpl_[A-Za-z0-9]{8,160}$/u;
const REPOSITORY = "sanrinawakes/yutakasa-tapping-coach";
const SCENARIOS = new Set(["chat_title_zero_width"]);

export class TicketCompletionError extends Error {
  constructor(code) { super(code); this.name = "TicketCompletionError"; this.code = code; }
}
function fail(code) { throw new TicketCompletionError(code); }

async function rpc(env, fetchImpl, name, body) {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("ticket_completion_db_request_failed"));
  if (response.status !== 200) fail("ticket_completion_db_http_failure");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 8 * 1024) fail("ticket_completion_db_response_large");
  try { return JSON.parse(raw); } catch { fail("ticket_completion_db_response_invalid"); }
}

export function validateCompletionContext(context, workId) {
  if (!context || typeof context !== "object" || Array.isArray(context) ||
    Object.keys(context).sort().join(",") !==
      "deployment_id,merge_sha,notice_ready,pr_number,scenario_key,work_id" ||
    context.work_id !== workId || !Number.isSafeInteger(context.pr_number) ||
    context.pr_number < 1 || !SHA.test(context.merge_sha ?? "") ||
    !DEPLOYMENT.test(context.deployment_id ?? "") ||
    context.notice_ready !== true ||
    !SCENARIOS.has(context.scenario_key)) fail("ticket_completion_context_invalid");
  return context;
}

/** Only a separately attested, work-specific proof can reach this path. */
export async function completeVerifiedTicketRepair({workId,env=process.env,
  fetchImpl=globalThis.fetch,deploymentImpl=collectRemoteDeployment}={}) {
  if (!UUID.test(workId ?? "") || env.GITHUB_REPOSITORY !== REPOSITORY ||
      env.GITHUB_REF !== "refs/heads/main" ||
      env.TICKET_COMPLETION_ENABLED !== "true" ||
      env.TICKET_COMPLETION_NOTICE_ENABLED !== "true" ||
      env.TICKET_RECONCILE_ENABLED !== "true" ||
      !((env.GITHUB_EVENT_NAME === "schedule" && !env.TICKET_RECONCILE_MODE) ||
        (env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.TICKET_RECONCILE_MODE === "reconcile")) ||
      typeof env.SUPABASE_URL !== "string" || !/^https:\/\/[^/]+$/u.test(env.SUPABASE_URL) ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" || env.SUPABASE_SERVICE_ROLE_KEY.length < 20 ||
      typeof env.VERCEL_TOKEN !== "string" || env.VERCEL_TOKEN.length < 20 ||
      typeof env.YUTAKASA_RESEND_API_KEY !== "string" || env.YUTAKASA_RESEND_API_KEY.length < 20) {
    fail("ticket_completion_configuration_invalid");
  }
  const raw = await rpc(env,fetchImpl,"get_yutakasa_ticket_completion_context",{p_work_id:workId});
  if (raw === null) return {status:"unavailable"};
  const context=validateCompletionContext(raw,workId);
  const deployment=await deploymentImpl({token:env.VERCEL_TOKEN,fetchImpl})
    .catch(() => fail("ticket_completion_production_lookup_failed"));
  if (deployment?.ready !== true || deployment.mainSha !== context.merge_sha ||
      deployment.deploymentId !== context.deployment_id) {
    fail("ticket_completion_production_changed");
  }
  const receipt=await rpc(env,fetchImpl,"append_yutakasa_verified_ticket_completion",{
    p_work_id:workId,p_current_main_sha:deployment.mainSha,
    p_current_deployment_id:deployment.deploymentId,
  });
  if (!Array.isArray(receipt) || receipt.length !== 1 ||
      !UUID.test(receipt[0]?.message_id ?? "") || typeof receipt[0]?.created !== "boolean") {
    fail("ticket_completion_receipt_invalid");
  }
  // No customer content or message ID is written to the workflow summary.
  return {status:receipt[0].created?"completed":"existing"};
}
