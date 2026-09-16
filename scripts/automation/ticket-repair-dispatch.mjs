import { RepairDispatchError } from "./dispatch-repair.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const REPO = "sanrinawakes/yutakasa-tapping-coach";

function fail(code) { throw new RepairDispatchError(code); }

function databaseSettings(secrets) {
  const base=secrets.SUPABASE_URL;
  const key=secrets.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof base!=="string" || !/^https:\/\/[^/]+$/u.test(base) ||
      typeof key!=="string" || key.length<20) fail("ticket_dispatch_configuration_invalid");
  return {base,key};
}

export async function inspectTicketRepairBacklog({secrets=process.env,
  fetchImpl=globalThis.fetch}={}) {
  const {base,key}=databaseSettings(secrets);
  const response=await fetchImpl(`${base}/rest/v1/yutakasa_ticket_repair_jobs?status=in.(queued,investigating,pr_open)&select=status,created_at,claimed_at&limit=101`,{
    headers:{apikey:key,Authorization:`Bearer ${key}`,Accept:"application/json"},
    redirect:"error",signal:AbortSignal.timeout(10_000),
  }).catch(()=>fail("ticket_backlog_unavailable"));
  if(response.status!==200)fail("ticket_backlog_unavailable");
  const raw=await response.text();
  if(Buffer.byteLength(raw)>16*1024)fail("ticket_backlog_invalid");
  let jobs;
  try{jobs=JSON.parse(raw);}catch{fail("ticket_backlog_invalid");}
  if(!Array.isArray(jobs)||jobs.length>101||jobs.some((job)=>
    !["queued","investigating","pr_open"].includes(job?.status)||
    !Number.isFinite(Date.parse(job?.created_at??""))))fail("ticket_backlog_invalid");
  return {pending:jobs.length,overflow:jobs.length===101};
}

export async function dispatchQueuedTicketRepairs({
  secrets = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const {base,key}=databaseSettings(secrets);
  const token = secrets.GITHUB_DISPATCH_TOKEN;
  if (typeof token !== "string" || token.length < 20) fail("ticket_dispatch_configuration_invalid");
  const recovered=await fetchImpl(`${base}/rest/v1/rpc/recover_yutakasa_ticket_repair_jobs`,{
    method:"POST",headers:{apikey:key,Authorization:`Bearer ${key}`,
      Accept:"application/json","content-type":"application/json"},
    body:"{}",redirect:"error",signal:AbortSignal.timeout(10_000),
  }).catch(()=>fail("ticket_dispatch_recovery_unavailable"));
  if(recovered.status!==200)fail("ticket_dispatch_recovery_unavailable");
  const recoveryRaw=await recovered.text();
  if(Buffer.byteLength(recoveryRaw)>256)fail("ticket_dispatch_recovery_invalid");
  let recovery;
  try{recovery=JSON.parse(recoveryRaw);}catch{fail("ticket_dispatch_recovery_invalid");}
  if(!Array.isArray(recovery)||recovery.length!==1||
    !Number.isSafeInteger(recovery[0]?.recovered)||recovery[0].recovered<0||
    recovery[0].recovered>100)fail("ticket_dispatch_recovery_invalid");
  const response = await fetchImpl(
    `${base}/rest/v1/rpc/list_due_yutakasa_ticket_repair_jobs`,
    { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`,
        Accept: "application/json", "content-type": "application/json" },
      body: "{}",
      redirect: "error", signal: AbortSignal.timeout(10_000) },
  ).catch(() => fail("ticket_dispatch_queue_unavailable"));
  if (response.status !== 200) fail("ticket_dispatch_queue_unavailable");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 4096) fail("ticket_dispatch_queue_invalid");
  let jobs;
  try { jobs = JSON.parse(raw); } catch { fail("ticket_dispatch_queue_invalid"); }
  if (!Array.isArray(jobs) || jobs.length > 10 ||
      jobs.some((job) => !UUID.test(job?.work_id ?? "") || Object.keys(job).join(",") !== "work_id")) {
    fail("ticket_dispatch_queue_invalid");
  }
  for (const job of jobs) {
    const accepted = await fetchImpl(
      `https://api.github.com/repos/${REPO}/actions/workflows/ticket-repair.yml/dispatches`,
      { method: "POST", headers: { Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ ref: "main", inputs: { work_id: job.work_id } }),
        redirect: "error", signal: AbortSignal.timeout(15_000) },
    ).catch(() => fail("ticket_dispatch_request_uncertain"));
    if (accepted.status !== 204) fail("ticket_dispatch_http_failure");
  }
  return { dispatched: jobs.length };
}
