#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { draftVerifiedTicketReply } from "./ticket-reply-draft.mjs";
import { completeVerifiedTicketRepair } from "./ticket-completion.mjs";
import { RepairDispatchError } from "./dispatch-repair.mjs";
import { inspectDueTicketReconciliations } from "./ticket-reconcile-dispatch.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const REPO = "sanrinawakes/yutakasa-tapping-coach";

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

export async function reconcileTicketRepairs({env=process.env,fetchImpl=globalThis.fetch,
  draftImpl=draftVerifiedTicketReply,completionImpl=completeVerifiedTicketRepair}={}) {
  const scheduled=env.GITHUB_EVENT_NAME==="schedule" && !env.TICKET_RECONCILE_MODE;
  const manual=env.GITHUB_EVENT_NAME==="workflow_dispatch" &&
    env.TICKET_RECONCILE_MODE==="reconcile";
  if ((!scheduled && !manual) || env.GITHUB_REPOSITORY!==REPO ||
      env.TICKET_RECONCILE_ENABLED!=="true" ||
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
  let drafted=0;
  let draftFailures=0;
  let completed=0;
  let completionFailures=0;
  for (const job of jobs) {
    if (env.TICKET_COMPLETION_ENABLED==="true") {
      try {
        const completion=await completionImpl({workId:job.work_id,env,fetchImpl});
        if (["completed","existing"].includes(completion?.status)) { completed+=1; continue; }
        if (completion?.status!=="unavailable") completionFailures+=1;
      } catch { completionFailures+=1; }
    }
    // The draft is private and never sent. An AI or database failure must not
    // stop the ticket from reaching a human review queue.
    if (drafted+draftFailures<10) {
      try {
        const draft=await draftImpl({workId:job.work_id,env,fetchImpl});
        if (draft?.status==="drafted" || draft?.status==="existing") drafted+=1;
        else if (draft?.status!=="unavailable") draftFailures+=1;
      } catch { draftFailures+=1; }
    }
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
  return {examined:jobs.length,manualReviews,drafted,draftFailures,completed,completionFailures,
    recoveredClaims:recovery[0].recovered};
}

export async function probeTicketRepairs({env=process.env,fetchImpl=globalThis.fetch,
  now=Date.now}={}) {
  if (env.GITHUB_EVENT_NAME!=="workflow_dispatch" ||
      env.TICKET_RECONCILE_MODE!=="probe" || env.GITHUB_REPOSITORY!==REPO ||
      env.TICKET_RECONCILE_ENABLED!=="true") fail("ticket_reconcile_configuration_invalid");
  return inspectDueTicketReconciliations({secrets:env,fetchImpl,now});
}

export async function runTicketRepairReconcile(options={}) {
  const env=options.env??process.env;
  if (env.GITHUB_EVENT_NAME==="workflow_dispatch" &&
      env.TICKET_RECONCILE_MODE==="probe") {
    return {mode:"probe",...await probeTicketRepairs({...options,env})};
  }
  return {mode:"reconcile",...await reconcileTicketRepairs({...options,env})};
}

const isMain=process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if (isMain) {
  runTicketRepairReconcile().then(
    (result)=>process.stdout.write(`${JSON.stringify({ok:true,...result})}\n`),
    (error)=>{process.stdout.write(`${JSON.stringify({ok:false,
      code:error instanceof TicketReconcileError || error instanceof RepairDispatchError
        ? error.code : "ticket_reconcile_failed"})}\n`);
      process.exitCode=1;},
  );
}
