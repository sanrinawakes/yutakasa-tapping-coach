import assert from "node:assert/strict";
import test from "node:test";
import { RepairDispatchError } from "./dispatch-repair.mjs";
import { dispatchDueTicketReconciliation,
  inspectDueTicketReconciliations } from "./ticket-reconcile-dispatch.mjs";

const secrets={SUPABASE_URL:"https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY:"s".repeat(40),GITHUB_DISPATCH_TOKEN:"g".repeat(40)};
const workId="e1aa3fb1-afae-43b8-b139-bc0fa4682255";
const now=()=>Date.parse("2026-09-17T12:00:00Z");

test("read-only probe reports due reviews and expired final claims without recovery",async()=>{
  const requests=[];
  const result=await inspectDueTicketReconciliations({secrets,now,fetchImpl:async(url,init)=>{
    requests.push({url:String(url),init});
    return new Response(JSON.stringify(requests.length===1?[{work_id:workId}]:
      [{claimed_at:"2026-09-17T09:59:59Z"}]),{status:200});
  }});
  assert.deepEqual(result,{dueReviews:1,expiredClaims:1,due:true});
  assert.equal(requests.length,2);
  assert.equal(requests[0].url.endsWith("/rpc/list_due_yutakasa_ticket_repair_reviews"),true);
  assert.equal(requests[1].init.method??"GET","GET");
  assert.equal(requests.some((request)=>request.url.includes("recover_yutakasa")),false);
  assert.equal(JSON.stringify(result).includes(workId),false);
});

test("claim at exact two-hour boundary is not treated as expired",async()=>{
  let call=0;
  const result=await inspectDueTicketReconciliations({secrets,now,fetchImpl:async()=>{
    call+=1;
    return new Response(JSON.stringify(call===1?[]:[{claimed_at:"2026-09-17T10:00:00Z"}]),
      {status:200});
  }});
  assert.deepEqual(result,{dueReviews:0,expiredClaims:0,due:false});
});

test("probe rejects malformed or unavailable database data",async()=>{
  await assert.rejects(()=>inspectDueTicketReconciliations({secrets,now,
    fetchImpl:async()=>new Response(JSON.stringify([{work_id:"private text"}]),{status:200})}),
  (error)=>error instanceof RepairDispatchError && error.code==="ticket_reconcile_probe_invalid");
  await assert.rejects(()=>inspectDueTicketReconciliations({secrets,now,
    fetchImpl:async()=>new Response("{}",{status:503})}),
  (error)=>error instanceof RepairDispatchError && error.code==="ticket_reconcile_probe_unavailable");
  await assert.rejects(()=>inspectDueTicketReconciliations({secrets,now,
    fetchImpl:async()=>new Response("x".repeat(17*1024),{status:200})}),
  (error)=>error instanceof RepairDispatchError && error.code==="ticket_reconcile_probe_invalid");
});

test("no due work needs no GitHub request",async()=>{
  const result=await dispatchDueTicketReconciliation({secrets,
    inspection:{dueReviews:0,expiredClaims:0,due:false},
    fetchImpl:async()=>assert.fail("no dispatch")});
  assert.deepEqual(result,{dispatched:0,alreadyRunning:false});
});

test("active scheduled or manual workflow prevents duplicate dispatch",async()=>{
  for(const event of ["schedule","workflow_dispatch"]){
    let count=0;
    const result=await dispatchDueTicketReconciliation({secrets,
      inspection:{dueReviews:1,expiredClaims:0,due:true},fetchImpl:async(url)=>{
        count+=1;
        assert.ok(String(url).endsWith("/runs?per_page=20"));
        return new Response(JSON.stringify({workflow_runs:[{event,status:"in_progress",
          head_branch:"main"}]}),{status:200});
      }});
    assert.deepEqual(result,{dispatched:0,alreadyRunning:true});
    assert.equal(count,1);
  }
});

test("due work dispatches only fixed reconcile input after confirming no active run",async()=>{
  const calls=[];
  const result=await dispatchDueTicketReconciliation({secrets,
    inspection:{dueReviews:1,expiredClaims:0,due:true},fetchImpl:async(url,init)=>{
      calls.push({url:String(url),init});
      if(calls.length===1)return new Response(JSON.stringify({workflow_runs:[{
        event:"workflow_dispatch",status:"completed",head_branch:"main"}]}),{status:200});
      return new Response(null,{status:204});
    }});
  assert.deepEqual(result,{dispatched:1,alreadyRunning:false});
  assert.deepEqual(JSON.parse(calls[1].init.body),{ref:"main",inputs:{mode:"reconcile"}});
  assert.equal(calls[1].url.endsWith("/ticket-repair-reconcile.yml/dispatches"),true);
  assert.equal(JSON.stringify(JSON.parse(calls[1].init.body)).includes(workId),false);
});

test("GitHub list or dispatch failure is visible and cannot claim acceptance",async()=>{
  const inspection={dueReviews:1,expiredClaims:0,due:true};
  await assert.rejects(()=>dispatchDueTicketReconciliation({secrets,inspection,
    fetchImpl:async()=>new Response("{}",{status:503})}),
  (error)=>error instanceof RepairDispatchError && error.code==="ticket_reconcile_runs_unavailable");
  let count=0;
  await assert.rejects(()=>dispatchDueTicketReconciliation({secrets,inspection,
    fetchImpl:async()=>++count===1
      ?new Response(JSON.stringify({workflow_runs:[]}),{status:200})
      :new Response("{}",{status:500})}),
  (error)=>error instanceof RepairDispatchError && error.code==="ticket_reconcile_dispatch_http_failure");
});
