import assert from "node:assert/strict";
import test from "node:test";

import { completeVerifiedTicketRepair, TicketCompletionError,
  validateCompletionContext } from "./ticket-completion.mjs";
import { reconcileTicketRepairs } from "./ticket-repair-reconcile.mjs";

const workId="123e4567-e89b-42d3-a456-426614174000";
const sha="a".repeat(40);
const deploymentId="dpl_Abcdefghijklmnop";
const context={work_id:workId,pr_number:78,merge_sha:sha,
  deployment_id:deploymentId,scenario_key:"chat_send_reload_persistence",notice_ready:true};
const env={GITHUB_REPOSITORY:"sanrinawakes/yutakasa-tapping-coach",
  GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"schedule",
  TICKET_COMPLETION_ENABLED:"true",TICKET_RECONCILE_ENABLED:"true",
  TICKET_COMPLETION_NOTICE_ENABLED:"true",YUTAKASA_RESEND_API_KEY:"r".repeat(32),
  SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"s".repeat(32),
  VERCEL_TOKEN:"v".repeat(32)};

test("completion context accepts only bound, supported metadata",()=>{
  assert.deepEqual(validateCompletionContext(context,workId),context);
  assert.throws(()=>validateCompletionContext({...context,scenario_key:"generic_smoke"},workId),
    TicketCompletionError);
  assert.throws(()=>validateCompletionContext({...context,ticket_id:workId},workId),
    TicketCompletionError);
  assert.throws(()=>validateCompletionContext({...context,merge_sha:"b".repeat(40)},
    "00000000-0000-4000-8000-000000000000"),TicketCompletionError);
});

test("missing flag, wrong branch, and probe stop before any IO",async()=>{
  for(const altered of [{TICKET_COMPLETION_ENABLED:"false"},
    {GITHUB_REF:"refs/heads/feature"},
    {GITHUB_EVENT_NAME:"workflow_dispatch",TICKET_RECONCILE_MODE:"probe"}]){
    await assert.rejects(()=>completeVerifiedTicketRepair({workId,env:{...env,...altered},
      fetchImpl:()=>assert.fail("must not read"),
      deploymentImpl:()=>assert.fail("must not inspect deployment")}),
    (error)=>error instanceof TicketCompletionError &&
      error.code==="ticket_completion_configuration_invalid");
  }
});

test("no exact proof returns unavailable without production lookup or send",async()=>{
  const result=await completeVerifiedTicketRepair({workId,env,
    fetchImpl:async(url)=>{
      assert.match(String(url),/get_yutakasa_ticket_completion_context$/u);
      return new Response("null");
    },deploymentImpl:()=>assert.fail("must not inspect deployment")});
  assert.deepEqual(result,{status:"unavailable"});
});

test("exact live production parity precedes one atomic database send",async()=>{
  const calls=[];
  const result=await completeVerifiedTicketRepair({workId,env,
    fetchImpl:async(url,init)=>{
      calls.push({url:String(url),body:JSON.parse(init.body)});
      if(String(url).endsWith("get_yutakasa_ticket_completion_context"))
        return new Response(JSON.stringify(context));
      if(String(url).endsWith("append_yutakasa_verified_ticket_completion"))
        return new Response(JSON.stringify([{message_id:"923e4567-e89b-42d3-a456-426614174000",created:true}]));
      assert.fail("unexpected request");
    },deploymentImpl:async()=>({ready:true,mainSha:sha,deploymentId})});
  assert.deepEqual(result,{status:"completed"});
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1].body,{p_work_id:workId,p_current_main_sha:sha,
    p_current_deployment_id:deploymentId});
  assert.equal(JSON.stringify(calls).includes("customer"),false);
});

test("changed production or ambiguous DB receipt fails closed",async()=>{
  let count=0;
  const fetchImpl=async()=>{count+=1;return new Response(JSON.stringify(context));};
  await assert.rejects(()=>completeVerifiedTicketRepair({workId,env,fetchImpl,
    deploymentImpl:async()=>({ready:true,mainSha:"b".repeat(40),deploymentId})}),
  (error)=>error instanceof TicketCompletionError &&
    error.code==="ticket_completion_production_changed");
  assert.equal(count,1);
  await assert.rejects(()=>completeVerifiedTicketRepair({workId,env,
    fetchImpl:async(url)=>new Response(String(url).endsWith("completion_context")?
      JSON.stringify(context):JSON.stringify([{message_id:"bad",created:false}])),
    deploymentImpl:async()=>({ready:true,mainSha:sha,deploymentId})}),
  (error)=>error instanceof TicketCompletionError &&
    error.code==="ticket_completion_receipt_invalid");
});

test("an uncertain HTTP result can return the existing atomic send",async()=>{
  const result=await completeVerifiedTicketRepair({workId,env,
    fetchImpl:async(url)=>new Response(String(url).endsWith("completion_context")?
      JSON.stringify(context):JSON.stringify([{
        message_id:"923e4567-e89b-42d3-a456-426614174000",created:false}])),
    deploymentImpl:async()=>({ready:true,mainSha:sha,deploymentId})});
  assert.deepEqual(result,{status:"existing"});
});

test("reconcile sends only proven work; unproven work enters manual review",async()=>{
  const jobs=[{work_id:workId},{work_id:"223e4567-e89b-42d3-a456-426614174000"}];
  let drafted=0,reviewed=0;
  const result=await reconcileTicketRepairs({env,
    completionImpl:async({workId:id})=>({status:id===workId?"completed":"unavailable"}),
    draftImpl:async()=>{drafted+=1;return {status:"unavailable"};},
    fetchImpl:async(url)=>{
      if(String(url).endsWith("recover_yutakasa_ticket_repair_jobs"))
        return new Response(JSON.stringify([{recovered:0}]));
      if(String(url).endsWith("list_due_yutakasa_ticket_repair_reviews"))
        return new Response(JSON.stringify(jobs));
      if(String(url).endsWith("review_yutakasa_ticket_repair_release")){
        reviewed+=1;return new Response(JSON.stringify([{status:"manual_review"}]));
      }
      if(String(url).endsWith("list_due_yutakasa_completion_notices"))
        return new Response("[]");
      assert.fail("unexpected request");
    }});
  assert.equal(result.completed,1);
  assert.equal(result.manualReviews,1);
  assert.equal(drafted,1);
  assert.equal(reviewed,1);
});
