import assert from "node:assert/strict";
import test from "node:test";
import { drainTechnicalEscalationNotices,
  TicketTechnicalEscalationNoticeError } from "./ticket-technical-escalation-notice.mjs";

const ticketId="d99c3f0a-1266-4dab-a2a3-8a3faf38b02d";
const messageId="e58ff284-e0a1-42aa-92da-11c605a9c9aa";
const claimToken="041b3a5d-8d10-43ca-9b18-46423d7404e9";
const providerId="b263aa9b-e8b1-48ce-9025-ff67eadfd76a";
const key=`yutakasa-technical-escalation/${ticketId}/${messageId}`;
const env={GITHUB_REPOSITORY:"sanrinawakes/yutakasa-tapping-coach",
  GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"schedule",
  TICKET_RECONCILE_ENABLED:"true",TICKET_TECHNICAL_ESCALATION_NOTICE_ENABLED:"true",
  SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"s".repeat(40),
  YUTAKASA_RESEND_API_KEY:"r".repeat(32),
  YUTAKASA_TECHNICAL_ESCALATION_EMAIL:"181wyc@gmail.com"};

function json(value){return new Response(JSON.stringify(value),{status:200});}
function claim(){return {status:"sending",ticket_id:ticketId,
  latest_user_message_id:messageId,claim_token:claimToken,idempotency_key:key};}

test("disabled escalation makes no database or provider request",async()=>{
  const result=await drainTechnicalEscalationNotices({env:{...env,
    TICKET_TECHNICAL_ESCALATION_NOTICE_ENABLED:"false"},
    fetchImpl:async()=>assert.fail("disabled notice must not access network")});
  assert.deepEqual(result,{examined:0,accepted:0,uncertain:0,needsReview:0});
});

test("wrong repository, recipient, event, or credentials fail closed",async()=>{
  for(const changed of [{GITHUB_REPOSITORY:"other/repo"},
    {GITHUB_REF:"refs/heads/feature"},{GITHUB_EVENT_NAME:"workflow_dispatch"},
    {YUTAKASA_TECHNICAL_ESCALATION_EMAIL:"other@example.com"},
    {YUTAKASA_TECHNICAL_ESCALATION_EMAIL:"other@example.com\r\nBcc:bad@example.com"},
    {YUTAKASA_RESEND_API_KEY:""}]){
    await assert.rejects(()=>drainTechnicalEscalationNotices({env:{...env,...changed},
      fetchImpl:async()=>assert.fail("invalid configuration must not access network")}),
    (error)=>error instanceof TicketTechnicalEscalationNoticeError&&
      error.code==="technical_escalation_configuration_invalid");
  }
});

test("one stopped technical ticket sends a private owner notice and records acceptance",async()=>{
  const requests=[];
  const result=await drainTechnicalEscalationNotices({env,uuid:()=>claimToken,
    fetchImpl:async(url,init)=>{
      const name=new URL(String(url)).pathname.split("/").at(-1);
      requests.push({name,init});
      if(name==="list_due_yutakasa_technical_escalation_notices")
        return json([{ticket_id:ticketId,latest_user_message_id:messageId}]);
      if(name==="claim_yutakasa_technical_escalation_notice")return json(claim());
      if(name==="support_messages")return json([{id:messageId,
        body:"ログイン画面でエラーが出て先に進めません。"}]);
      if(name==="emails")return json({id:providerId});
      if(name==="finish_yutakasa_technical_escalation_notice")
        return json([{status:"accepted"}]);
      assert.fail(`unexpected request: ${name}`);
    }});
  assert.deepEqual(result,{examined:1,accepted:1,uncertain:0,needsReview:0});
  assert.deepEqual(requests.map((r)=>r.name),[
    "list_due_yutakasa_technical_escalation_notices",
    "claim_yutakasa_technical_escalation_notice","support_messages","emails",
    "finish_yutakasa_technical_escalation_notice"]);
  const email=requests[3];
  assert.equal(email.init.headers["Idempotency-Key"],key);
  const body=JSON.parse(email.init.body);
  assert.deepEqual(body.to,["181wyc@gmail.com"]);
  assert.match(body.subject,/返信が必要/u);
  assert.match(body.text,/ログイン画面でエラーが出て先に進めません/u);
  assert.match(body.text,/あなたの確認と返信が必要/u);
  assert.doesNotMatch(body.text,new RegExp(ticketId));
  assert.match(body.text,/\/admin\/support/u);
  assert.equal(body.text.includes("customer@example.com"),false);
  assert.equal(JSON.stringify(requests).includes("customer@example.com"),false);
});

test("provider uncertainty is recorded and a later run reuses the same key",async()=>{
  let attempts=0;
  const keys=[];
  const fetchImpl=async(url,init)=>{
    const name=new URL(String(url)).pathname.split("/").at(-1);
    if(name==="list_due_yutakasa_technical_escalation_notices")
      return json([{ticket_id:ticketId,latest_user_message_id:messageId}]);
    if(name==="claim_yutakasa_technical_escalation_notice")return json(claim());
    if(name==="support_messages")return json([{id:messageId,body:"技術報告です。"}]);
    if(name==="mark_yutakasa_technical_escalation_notice_uncertain")
      return json([{status:"uncertain"}]);
    if(name==="finish_yutakasa_technical_escalation_notice")
      return json([{status:"accepted"}]);
    if(name==="emails"){
      keys.push(init.headers["Idempotency-Key"]);
      attempts+=1;
      if(attempts===1)throw new Error("timeout");
      return json({id:providerId});
    }
    assert.fail(`unexpected request: ${name}`);
  };
  const first=await drainTechnicalEscalationNotices({env,uuid:()=>claimToken,fetchImpl});
  const second=await drainTechnicalEscalationNotices({env,uuid:()=>claimToken,fetchImpl});
  assert.deepEqual(first,{examined:1,accepted:0,uncertain:1,needsReview:0});
  assert.deepEqual(second,{examined:1,accepted:1,uncertain:0,needsReview:0});
  assert.deepEqual(keys,[key,key]);
});

test("missing customer report never sends a misleading owner email",async()=>{
  let sends=0;
  const result=await drainTechnicalEscalationNotices({env,uuid:()=>claimToken,
    fetchImpl:async(url)=>{
      const name=new URL(String(url)).pathname.split("/").at(-1);
      if(name==="list_due_yutakasa_technical_escalation_notices")
        return json([{ticket_id:ticketId,latest_user_message_id:messageId}]);
      if(name==="claim_yutakasa_technical_escalation_notice")return json(claim());
      if(name==="support_messages")return json([]);
      if(name==="mark_yutakasa_technical_escalation_notice_uncertain")
        return json([{status:"uncertain"}]);
      if(name==="emails")sends+=1;
      assert.fail(`unexpected request: ${name}`);
    }});
  assert.equal(sends,0);
  assert.deepEqual(result,{examined:1,accepted:0,uncertain:1,needsReview:0});
});

test("a ticket changed before claim cannot send email",async()=>{
  let sent=0;
  const result=await drainTechnicalEscalationNotices({env,uuid:()=>claimToken,
    fetchImpl:async(url)=>{
      const name=new URL(String(url)).pathname.split("/").at(-1);
      if(name==="list_due_yutakasa_technical_escalation_notices")
        return json([{ticket_id:ticketId,latest_user_message_id:messageId}]);
      if(name==="claim_yutakasa_technical_escalation_notice")return json({status:"suppressed"});
      if(name==="emails")sent+=1;
      assert.fail(`unexpected request: ${name}`);
    }});
  assert.equal(sent,0);
  assert.deepEqual(result,{examined:1,accepted:0,uncertain:0,needsReview:0});
});
