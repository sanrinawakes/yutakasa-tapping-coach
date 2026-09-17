import assert from "node:assert/strict";
import test from "node:test";
import { dispatchQueuedTicketRepairs } from "./ticket-repair-dispatch.mjs";
import { TicketRepairError, assertNoCustomerLeak, validatePrivateContext,
  runTicketRepairInvestigation } from "./ticket-repair-investigate.mjs";
import { TicketReconcileError, reconcileTicketRepairs } from "./ticket-repair-reconcile.mjs";
import { retryPendingPromotions } from "./ai-repair-promote-sweep.mjs";

const workId="e1aa3fb1-afae-43b8-b139-bc0fa4682255";
const ticketId="91fc220d-19a8-447a-a19d-feac919af642";
const messageId="2e4710db-9274-4e4c-96c4-59dc97e21c8d";
const context={work_id:workId,ticket_id:ticketId,latest_user_message_id:messageId,
  category:"technical",subject:"田中様の画面が保存されない",
  messages:[{id:messageId,sender_type:"user",body:"田中です。abc@example.com。保存できません。",
    created_at:"2026-09-16T01:00:00Z"}]};
const env={WORK_ID:workId,GITHUB_RUN_ID:"123",GITHUB_REPOSITORY:"sanrinawakes/yutakasa-tapping-coach",
  TICKET_REPAIR_ENABLED:"true",SUPABASE_URL:"https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY:"s".repeat(40),GH_TOKEN:"g".repeat(40),
  YUTAKASA_OPENAI_API_KEY:"o".repeat(40),YUTAKASA_OPENAI_PROJECT_ID:"proj_1234567890"};

test("private context must match the opaque work ID and latest user message",()=>{
  assert.equal(validatePrivateContext(context,workId),context);
  assert.throws(()=>validatePrivateContext({...context,work_id:ticketId},workId),TicketRepairError);
  assert.throws(()=>validatePrivateContext({...context,latest_user_message_id:ticketId},workId),TicketRepairError);
});

test("customer words and identifiers cannot enter a published patch",()=>{
  assert.throws(()=>assertNoCustomerLeak({patch:"+const x='abc@example.com';"},context),TicketRepairError);
  assert.throws(()=>assertNoCustomerLeak({patch:"+const x='田中様の画面が保存されない';"},context),TicketRepairError);
  assert.throws(()=>assertNoCustomerLeak({patch:'+const diagnostic = "田中";'},context),TicketRepairError);
  assert.throws(()=>assertNoCustomerLeak({patch:'+const diagnostic = "さとし";'},
    {...context,subject:"画面",messages:[{...context.messages[0],body:"さとしです"}]}),TicketRepairError);
  assert.throws(()=>assertNoCustomerLeak({patch:'+const diagnostic = "Sato";'},
    {...context,subject:"画面",messages:[{...context.messages[0],body:"Sato here"}]}),TicketRepairError);
  assert.throws(()=>assertNoCustomerLeak({patch:"+const x='customer@real-domain.jp';"},context),TicketRepairError);
  assertNoCustomerLeak({patch:"+const healthy = true;"},context);
});

test("Railway dispatch sends only a random UUID to the dedicated workflow",async()=>{
  const requests=[];
  const result=await dispatchQueuedTicketRepairs({secrets:{SUPABASE_URL:env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY:env.SUPABASE_SERVICE_ROLE_KEY,GITHUB_DISPATCH_TOKEN:env.GH_TOKEN},
  fetchImpl:async(url,init)=>{
    requests.push({url:String(url),init});
    if(requests.length===1)return new Response(JSON.stringify([{recovered:0}]),{status:200});
    if(requests.length===2)return new Response(JSON.stringify([{work_id:workId}]),{status:200});
    return new Response(null,{status:204});
  }});
  assert.equal(result.dispatched,1);
  const body=JSON.parse(requests[2].init.body);
  assert.deepEqual(body,{ref:"main",inputs:{work_id:workId}});
  assert.equal(JSON.stringify(body).includes("田中"),false);
});

test("ticket job rechecks private context, makes a fixed-body PR, then links CAS",async()=>{
  let lookups=0;
  let published;
  const requests=[];
  const result=await runTicketRepairInvestigation({env,
    projectGate:async()=>({projectConfirmed:true}),
    publisher:(input)=>{published=input;return {status:"draft_pr_created"};},
    fetchImpl:async(url,init)=>{
      const target=String(url);
      requests.push({target,init});
      if(target.endsWith("/rpc/claim_yutakasa_ticket_repair_context"))
        return new Response(JSON.stringify(context),{status:200});
      if(target.includes("/pulls?")){
        lookups+=1;
        return new Response(JSON.stringify(lookups===1?[]:[{number:91,state:"open",
          title:"Yutakasa support repair 9e5866bd9dbd02c7",
          head:{ref:"codex/yutakasa-support-ai-9e5866bd9dbd02c7",sha:"a".repeat(40),
            repo:{full_name:"sanrinawakes/yutakasa-tapping-coach"}},base:{ref:"main"}}]),{status:200});
      }
      if(target==="https://api.openai.com/v1/responses")
        return new Response(JSON.stringify({status:"completed",output:[{content:[{type:"output_text",
          text:JSON.stringify({summary:"調査",diagnosis:"調査",patch:""})}]}]}),{status:200});
      if(target.endsWith("/rpc/link_yutakasa_ticket_repair_pr"))
        return new Response(JSON.stringify([{pr_number:91,head_sha:"a".repeat(40)}]),{status:200});
      throw new Error("unexpected request");
    }});
  assert.equal(result.status,"draft_pr_linked");
  assert.equal(published.AI_REPAIR_TICKET_MODE,"true");
  assert.equal(published.AI_REPAIR_WORK_ID,workId);
  const model=JSON.parse(requests.find((request)=>request.target==="https://api.openai.com/v1/responses").init.body);
  assert.equal(model.store,false);
  assert.deepEqual(model.tools,[]);
  assert.equal(requests.filter((request)=>request.target.includes("/pulls?")).length,2);
});

test("scheduled recovery sends no customer reply and moves verified or expired work to review",async()=>{
  const called=[];
  let drafts=0;
  const result=await reconcileTicketRepairs({env:{GITHUB_EVENT_NAME:"schedule",
    GITHUB_REPOSITORY:env.GITHUB_REPOSITORY,TICKET_RECONCILE_ENABLED:"true",SUPABASE_URL:env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY:env.SUPABASE_SERVICE_ROLE_KEY},
  draftImpl:async()=>{drafts+=1;return {status:"drafted"};},
  fetchImpl:async(url,init)=>{
    called.push({url:String(url),body:JSON.parse(init.body)});
    if(String(url).endsWith("recover_yutakasa_ticket_repair_jobs"))
      return new Response(JSON.stringify([{recovered:0}]),{status:200});
    if(String(url).endsWith("list_due_yutakasa_ticket_repair_reviews"))
      return new Response(JSON.stringify([{work_id:workId}]),{status:200});
    if(String(url).endsWith("review_yutakasa_ticket_repair_release"))
      return new Response(JSON.stringify([{status:"manual_review"}]),{status:200});
    throw new Error("unexpected request");
  }});
  assert.deepEqual(result,{examined:1,manualReviews:1,drafted:1,draftFailures:0,recoveredClaims:0});
  assert.equal(drafts,1);
  assert.equal(called.some((item)=>item.url.includes("append_verified")),false);
  assert.deepEqual(called[2].body,{p_work_id:workId});
  await assert.rejects(()=>reconcileTicketRepairs({env:{},fetchImpl:async()=>{
    throw new Error("should not call");}}),TicketReconcileError);
});

test("scheduled promotion retries pending Vercel status within a 24-hour window",async()=>{
  let calls=0;
  const result=await retryPendingPromotions({env:{GITHUB_EVENT_NAME:"schedule",
    YUTAKASA_AUTO_MERGE_ENABLED:"true",GITHUB_REPOSITORY:env.GITHUB_REPOSITORY,
    GH_TOKEN:env.GH_TOKEN},now:()=>Date.parse("2026-09-16T12:00:00Z"),
  fetchImpl:async()=>new Response(JSON.stringify([{created_at:"2026-09-16T11:00:00Z",
    head:{ref:"codex/yutakasa-ai-repair-0123456789abcdef",sha:"a".repeat(40),
      repo:{full_name:env.GITHUB_REPOSITORY}},base:{ref:"main"}}]),{status:200}),
  promoteImpl:async()=>{calls+=1;return {status:"pending_ci"};}});
  assert.deepEqual(result,{examined:1,merged:0,pending:1,rejected:0});
  assert.equal(calls,1);
});

test("scheduled promotion includes private ticket repair branches",async()=>{
  let calls=0;
  const result=await retryPendingPromotions({env:{GITHUB_EVENT_NAME:"schedule",
    YUTAKASA_AUTO_MERGE_ENABLED:"true",GITHUB_REPOSITORY:env.GITHUB_REPOSITORY,
    GH_TOKEN:env.GH_TOKEN},now:()=>Date.parse("2026-09-16T12:00:00Z"),
  fetchImpl:async()=>new Response(JSON.stringify([{created_at:"2026-09-16T11:00:00Z",
    head:{ref:"codex/yutakasa-support-ai-0123456789abcdef",sha:"a".repeat(40),
      repo:{full_name:env.GITHUB_REPOSITORY}},base:{ref:"main"}}]),{status:200}),
  promoteImpl:async()=>{calls+=1;return {status:"pending_ci"};}});
  assert.equal(result.pending,1);
  assert.equal(calls,1);
});
