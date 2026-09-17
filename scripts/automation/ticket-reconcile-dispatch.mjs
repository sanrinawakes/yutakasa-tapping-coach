import { RepairDispatchError } from "./dispatch-repair.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const WORKFLOW = "ticket-repair-reconcile.yml";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ACTIVE_RUNS = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);

function fail(code) { throw new RepairDispatchError(code); }

function settings(secrets) {
  const base = secrets.SUPABASE_URL;
  const key = secrets.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof base !== "string" || !/^https:\/\/[^/]+$/u.test(base) ||
      typeof key !== "string" || key.length < 20 || /[\r\n]/u.test(key)) {
    fail("ticket_reconcile_configuration_invalid");
  }
  return { base, key };
}

async function readJson(response, maximum, code) {
  const declared=response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared)>maximum) fail(code);
  const reader=response.body?.getReader?.();
  if (!reader) fail(code);
  const chunks=[];
  let size=0;
  try {
    while (true) {
      const next=await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) fail(code);
      size+=next.value.byteLength;
      if (size>maximum) fail(code);
      chunks.push(Buffer.from(next.value));
    }
  } catch { fail(code); }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks,size).toString("utf8")); }
  catch { fail(code); }
}

// Both requests are read-only. In particular, this probe never calls the
// recovery RPC, which can change ticket state and add an internal work log.
export async function inspectDueTicketReconciliations({secrets=process.env,
  fetchImpl=globalThis.fetch,now=Date.now}={}) {
  const {base,key}=settings(secrets);
  const headers={apikey:key,Authorization:`Bearer ${key}`,Accept:"application/json"};
  const reviewsResponse=await fetchImpl(`${base}/rest/v1/rpc/list_due_yutakasa_ticket_repair_reviews`,{
    method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}",
    redirect:"error",signal:AbortSignal.timeout(10_000),
  }).catch(()=>fail("ticket_reconcile_probe_unavailable"));
  if (reviewsResponse.status!==200) fail("ticket_reconcile_probe_unavailable");
  const reviews=await readJson(reviewsResponse,16*1024,"ticket_reconcile_probe_invalid");
  if (!Array.isArray(reviews) || reviews.length>100 || reviews.some((row)=>
    !UUID.test(row?.work_id??"") || Object.keys(row).join(",")!=="work_id")) {
    fail("ticket_reconcile_probe_invalid");
  }
  // The oldest final-attempt claim decides whether recovery is due. The
  // database RPC applies its own two-hour deadline again before changing it.
  const claimsResponse=await fetchImpl(`${base}/rest/v1/yutakasa_ticket_repair_jobs?select=claimed_at&status=eq.investigating&attempt_count=gte.3&order=claimed_at.asc&limit=1`,{
    headers,redirect:"error",signal:AbortSignal.timeout(10_000),
  }).catch(()=>fail("ticket_reconcile_probe_unavailable"));
  if (claimsResponse.status!==200) fail("ticket_reconcile_probe_unavailable");
  const claims=await readJson(claimsResponse,512,"ticket_reconcile_probe_invalid");
  if (!Array.isArray(claims) || claims.length>1 || claims.some((row)=>
    Object.keys(row).join(",")!=="claimed_at" ||
    typeof row.claimed_at!=="string" || !Number.isFinite(Date.parse(row.claimed_at)))) {
    fail("ticket_reconcile_probe_invalid");
  }
  const nowMs=now();
  if (!Number.isFinite(nowMs)) fail("ticket_reconcile_clock_invalid");
  const expiredClaims=claims.length===1 && Date.parse(claims[0].claimed_at)<nowMs-2*60*60*1000 ? 1 : 0;
  let dueNotices=0;
  // The outbox table is installed by a later migration. Keep this RPC absent
  // until that migration and the matching Railway flag are both in place.
  if (secrets.TICKET_COMPLETION_NOTICE_ENABLED==="true") {
    const noticesResponse=await fetchImpl(
      `${base}/rest/v1/rpc/list_due_yutakasa_completion_notices`,{
        method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}",
        redirect:"error",signal:AbortSignal.timeout(10_000),
      }).catch(()=>fail("ticket_reconcile_notice_probe_unavailable"));
    if (noticesResponse.status!==200) fail("ticket_reconcile_notice_probe_unavailable");
    const notices=await readJson(noticesResponse,4096,"ticket_reconcile_notice_probe_invalid");
    if (!Array.isArray(notices) || notices.length>21 || notices.some((row)=>
        !UUID.test(row?.work_id??"") || Object.keys(row).join(",")!=="work_id") ||
        new Set(notices.map((row)=>row.work_id)).size!==notices.length) {
      fail("ticket_reconcile_notice_probe_invalid");
    }
    dueNotices=notices.length;
  }
  if (secrets.TICKET_CLARIFICATION_NOTICE_ENABLED==="true") {
    const noticesResponse=await fetchImpl(
      `${base}/rest/v1/rpc/list_due_yutakasa_clarification_notices`,{
        method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}",
        redirect:"error",signal:AbortSignal.timeout(10_000),
      }).catch(()=>fail("ticket_reconcile_clarification_notice_probe_unavailable"));
    if (noticesResponse.status!==200)
      fail("ticket_reconcile_clarification_notice_probe_unavailable");
    const notices=await readJson(noticesResponse,4096,
      "ticket_reconcile_clarification_notice_probe_invalid");
    if (!Array.isArray(notices) || notices.length>21 || notices.some((row)=>
        !UUID.test(row?.ticket_id??"") || Object.keys(row).join(",")!=="ticket_id") ||
        new Set(notices.map((row)=>row.ticket_id)).size!==notices.length) {
      fail("ticket_reconcile_clarification_notice_probe_invalid");
    }
    dueNotices+=notices.length;
  }
  if (secrets.TICKET_TECHNICAL_ESCALATION_NOTICE_ENABLED==="true") {
    const noticesResponse=await fetchImpl(
      `${base}/rest/v1/rpc/list_due_yutakasa_technical_escalation_notices`,{
        method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}",
        redirect:"error",signal:AbortSignal.timeout(10_000),
      }).catch(()=>fail("ticket_reconcile_technical_notice_probe_unavailable"));
    if (noticesResponse.status!==200)
      fail("ticket_reconcile_technical_notice_probe_unavailable");
    const notices=await readJson(noticesResponse,4096,
      "ticket_reconcile_technical_notice_probe_invalid");
    if (!Array.isArray(notices) || notices.length>21 || notices.some((row)=>
        !UUID.test(row?.ticket_id??"") ||
        !UUID.test(row?.latest_user_message_id??"") ||
        Object.keys(row).sort().join(",")!=="latest_user_message_id,ticket_id") ||
        new Set(notices.map((row)=>`${row.ticket_id}/${row.latest_user_message_id}`)).size!==notices.length) {
      fail("ticket_reconcile_technical_notice_probe_invalid");
    }
    dueNotices+=notices.length;
  }
  return {dueReviews:reviews.length,expiredClaims,dueNotices,
    due:reviews.length>0 || expiredClaims>0 || dueNotices>0};
}

// GitHub's workflow concurrency is the final guard. Inspecting existing
// queued/running jobs prevents repeated Railway ticks from adding more runs.
export async function dispatchDueTicketReconciliation({secrets=process.env,
  inspection,fetchImpl=globalThis.fetch}={}) {
  if (!inspection || !Number.isSafeInteger(inspection.dueReviews) ||
      inspection.dueReviews<0 || inspection.dueReviews>100 ||
      ![0,1].includes(inspection.expiredClaims) ||
      !Number.isSafeInteger(inspection.dueNotices) ||
      inspection.dueNotices<0 || inspection.dueNotices>63 ||
      inspection.due!==(inspection.dueReviews>0 || inspection.expiredClaims>0 ||
        inspection.dueNotices>0)) {
    fail("ticket_reconcile_inspection_invalid");
  }
  if (!inspection.due) return {dispatched:0,alreadyRunning:false};
  const token=secrets.GITHUB_DISPATCH_TOKEN;
  if (typeof token!=="string" || token.length<20 || /[\r\n]/u.test(token))
    fail("ticket_reconcile_dispatch_token_invalid");
  const base=`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}`;
  const headers={Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,
    "X-GitHub-Api-Version":"2022-11-28"};
  const runsResponse=await fetchImpl(`${base}/runs?per_page=20`,{
    headers,redirect:"error",signal:AbortSignal.timeout(15_000),
  }).catch(()=>fail("ticket_reconcile_runs_unavailable"));
  if (runsResponse.status!==200) fail("ticket_reconcile_runs_unavailable");
  const runs=await readJson(runsResponse,128*1024,"ticket_reconcile_runs_invalid");
  if (!Array.isArray(runs?.workflow_runs) || runs.workflow_runs.length>20 ||
      runs.workflow_runs.some((run)=>typeof run?.status!=="string" ||
        typeof run?.event!=="string" || typeof run?.head_branch!=="string")) {
    fail("ticket_reconcile_runs_invalid");
  }
  if (runs.workflow_runs.some((run)=>run.head_branch==="main" &&
      ["schedule","workflow_dispatch"].includes(run.event) && ACTIVE_RUNS.has(run.status))) {
    return {dispatched:0,alreadyRunning:true};
  }
  const response=await fetchImpl(`${base}/dispatches`,{
    method:"POST",headers:{...headers,"Content-Type":"application/json"},
    body:JSON.stringify({ref:"main",inputs:{mode:"reconcile"}}),
    redirect:"error",signal:AbortSignal.timeout(15_000),
  }).catch(()=>fail("ticket_reconcile_dispatch_uncertain"));
  if (response.status!==204) fail("ticket_reconcile_dispatch_http_failure");
  return {dispatched:1,alreadyRunning:false};
}
