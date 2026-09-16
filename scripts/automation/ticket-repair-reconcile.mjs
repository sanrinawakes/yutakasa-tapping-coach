#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export class TicketReconcileError extends Error {
  constructor(code) { super(code); this.name = "TicketReconcileError"; this.code = code; }
}
function fail(code) { throw new TicketReconcileError(code); }
async function rpc(env, fetchImpl, name, body={}) {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("ticket_reconcile_db_request_failed"));
  if (response.status !== 200) fail("ticket_reconcile_db_http_failure");
  const raw = await response.text();
  if (Buffer.byteLength(raw)>16*1024) fail("ticket_reconcile_db_response_large");
  try { return JSON.parse(raw); } catch { fail("ticket_reconcile_db_response_invalid"); }
}

export async function reconcileTicketRepairs({env=process.env,fetchImpl=globalThis.fetch}={}) {
  if (env.GITHUB_EVENT_NAME!=="schedule" || env.TICKET_RECONCILE_ENABLED!=="true" ||
      typeof env.SUPABASE_URL!=="string" || !/^https:\/\/[^/]+$/u.test(env.SUPABASE_URL) ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY!=="string" || env.SUPABASE_SERVICE_ROLE_KEY.length<20) {
    fail("ticket_reconcile_configuration_invalid");
  }
  const recovery=await rpc(env,fetchImpl,"recover_yutakasa_ticket_repair_jobs");
  if (!Array.isArray(recovery) || recovery.length!==1 ||
      !Number.isSafeInteger(recovery[0]?.recovered) || recovery[0].recovered<0 ||
      recovery[0].recovered>100) fail("ticket_reconcile_recovery_invalid");
  const jobs=await rpc(env,fetchImpl,"list_due_yutakasa_ticket_repair_reviews");
  if (!Array.isArray(jobs) || jobs.length>100 ||
      jobs.some((job)=>!UUID.test(job?.work_id??"") || Object.keys(job).join(",")!=="work_id")) {
    fail("ticket_reconcile_queue_invalid");
  }
  let manualReviews=0;
  for (const job of jobs) {
    const receipt=await rpc(env,fetchImpl,"review_yutakasa_ticket_repair_release",{
      p_work_id:job.work_id,
    });
    if (!Array.isArray(receipt) || receipt.length!==1 ||
        !["manual_review","failed","stale","replied","pending"].includes(receipt[0]?.status)) {
      fail("ticket_reconcile_receipt_invalid");
    }
    if (receipt[0].status==="manual_review") manualReviews+=1;
  }
  // A full page is not a healthy state. The next schedule can continue, and
  // this run remains visibly failed until the backlog falls below the bound.
  if (jobs.length===100 || recovery[0].recovered===100) fail("ticket_reconcile_backlog_remaining");
  return {examined:jobs.length,manualReviews,recoveredClaims:recovery[0].recovered};
}

const isMain=process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if (isMain) {
  reconcileTicketRepairs().then(
    (result)=>process.stdout.write(`${JSON.stringify({ok:true,...result})}\n`),
    (error)=>{process.stdout.write(`${JSON.stringify({ok:false,
      code:error instanceof TicketReconcileError?error.code:"ticket_reconcile_failed"})}\n`);
      process.exitCode=1;},
  );
}
