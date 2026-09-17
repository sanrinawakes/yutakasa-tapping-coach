import assert from "node:assert/strict";
import test from "node:test";
import { draftVerifiedTicketReply, parseReplyDraft, TicketReplyDraftError,
  validateReplyDraftContext } from "./ticket-reply-draft.mjs";

const workId="e1aa3fb1-afae-43b8-b139-bc0fa4682255";
const ticketId="91fc220d-19a8-447a-a19d-feac919af642";
const messageId="2e4710db-9274-4e4c-96c4-59dc97e21c8d";
const context={work_id:workId,ticket_id:ticketId,latest_user_message_id:messageId,
  pr_number:91,merge_sha:"a".repeat(40),deployment_id:"dpl_1234567890ABCDEF",
  category:"technical",subject:"保存できない",draft_exists:false,messages:[
    {id:messageId,sender_type:"user",body:"送信後に画面が止まります。",
      created_at:"2026-09-16T00:00:00Z"}]};
const env={GITHUB_EVENT_NAME:"schedule",GITHUB_REPOSITORY:"sanrinawakes/yutakasa-tapping-coach",
  TICKET_RECONCILE_ENABLED:"true",SUPABASE_URL:"https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY:"s".repeat(40),YUTAKASA_OPENAI_API_KEY:"o".repeat(40),
  YUTAKASA_OPENAI_PROJECT_ID:"proj_1234567890"};

test("private reply context is bounded and bound to the latest user message",()=>{
  assert.equal(validateReplyDraftContext(context,workId),context);
  assert.throws(()=>validateReplyDraftContext({...context,work_id:ticketId},workId),TicketReplyDraftError);
  assert.throws(()=>validateReplyDraftContext({...context,latest_user_message_id:ticketId},workId),TicketReplyDraftError);
  assert.throws(()=>validateReplyDraftContext({...context,messages:[...context.messages,
    {...context.messages[0],id:ticketId,body:"x".repeat(21_000)}]},workId),TicketReplyDraftError);
});

test("model output rejects oversized or malformed reply drafts",()=>{
  assert.equal(parseReplyDraft(JSON.stringify({body:"操作した画面と時刻を教えてください。"})),
    "操作した画面と時刻を教えてください。");
  assert.throws(()=>parseReplyDraft(JSON.stringify({body:"x".repeat(601)})),TicketReplyDraftError);
  assert.equal(parseReplyDraft(JSON.stringify({body:"返信\n本文"})),"返信\n本文");
  assert.throws(()=>parseReplyDraft(JSON.stringify({body:"返信\u0001本文"})),TicketReplyDraftError);
  assert.throws(()=>parseReplyDraft(JSON.stringify({body:"本文",sent:true})),TicketReplyDraftError);
});

test("verified case produces a private Terra draft and only saves it for human review",async()=>{
  const calls=[];
  let gateCalls=0;
  const result=await draftVerifiedTicketReply({workId,env,projectGate:async()=>{gateCalls+=1;},
    fetchImpl:async(url,init)=>{
      const target=String(url);calls.push({target,init});
      if(target.endsWith("/rpc/get_yutakasa_ticket_reply_draft_context"))
        return new Response(JSON.stringify(context),{status:200});
      if(target==="https://api.openai.com/v1/responses")
        return new Response(JSON.stringify({status:"completed",output:[{content:[{
          type:"output_text",text:JSON.stringify({body:"画面と操作した時刻、今の表示を教えてください。"})}]}]}),{status:200});
      if(target.endsWith("/rpc/save_yutakasa_ticket_reply_draft"))
        return new Response(JSON.stringify([{created:true}]),{status:200});
      throw new Error("unexpected request");
    }});
  assert.deepEqual(result,{status:"drafted"});
  assert.equal(gateCalls,1);
  assert.equal(calls.length,3);
  const model=JSON.parse(calls[1].init.body);
  assert.equal(model.model,"gpt-5.6-terra");
  assert.equal(model.store,false);
  assert.deepEqual(model.tools,[]);
  assert.equal(JSON.stringify(calls).includes("append_yutakasa_automation_reply"),false);
  assert.deepEqual(JSON.parse(calls[2].init.body),{p_work_id:workId,
    p_latest_user_message_id:messageId,p_pr_number:91,
    p_body:"画面と操作した時刻、今の表示を教えてください。"});
});

test("unavailable or stale release never calls the model or saves a draft",async()=>{
  let requests=0;
  const unavailable=await draftVerifiedTicketReply({workId,env,
    projectGate:async()=>{throw new Error("must not run");},
    fetchImpl:async()=>{requests+=1;return new Response("null",{status:200});}});
  assert.deepEqual(unavailable,{status:"unavailable"});
  assert.equal(requests,1);
  const existing=await draftVerifiedTicketReply({workId,env,
    projectGate:async()=>{throw new Error("must not run");},
    fetchImpl:async()=>new Response(JSON.stringify({...context,draft_exists:true}),{status:200})});
  assert.deepEqual(existing,{status:"existing"});
  await assert.rejects(()=>draftVerifiedTicketReply({workId,env,
    projectGate:async()=>{throw new Error("must not run");},
    fetchImpl:async()=>new Response(JSON.stringify({...context,latest_user_message_id:ticketId}),{status:200})}),
    TicketReplyDraftError);
});
