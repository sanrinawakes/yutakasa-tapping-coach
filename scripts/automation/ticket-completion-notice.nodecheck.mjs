import assert from "node:assert/strict";
import test from "node:test";

import {drainCompletionNotices,TicketCompletionNoticeError,validateClaim}
  from "./ticket-completion-notice.mjs";

const workId="123e4567-e89b-42d3-a456-426614174000";
const claimToken="223e4567-e89b-42d3-a456-426614174000";
const providerId="323e4567-e89b-42d3-a456-426614174000";
const claim={status:"sending",work_id:workId,claim_token:claimToken,
  recipient_email:"customer@example.com",ticket_subject:"会話が消える",
  idempotency_key:`yutakasa-ticket-completion/${workId}`};
const env={GITHUB_REPOSITORY:"sanrinawakes/yutakasa-tapping-coach",
  GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"schedule",
  TICKET_RECONCILE_ENABLED:"true",TICKET_COMPLETION_NOTICE_ENABLED:"true",
  SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"s".repeat(32),
  YUTAKASA_RESEND_API_KEY:"r".repeat(32)};

test("disabled notice worker performs no reads or provider calls",async()=>{
  const result=await drainCompletionNotices({env:{...env,TICKET_COMPLETION_NOTICE_ENABLED:"false"},
    fetchImpl:()=>assert.fail("must not call provider or database")});
  assert.deepEqual(result,{examined:0,accepted:0,needsReview:0});
});

test("suppressed synthetic notice never reaches the provider",async()=>{
  const result=await drainCompletionNotices({env,uuid:()=>claimToken,
    fetchImpl:async(url)=>{
      if(String(url).endsWith("list_due_yutakasa_completion_notices"))
        return new Response(JSON.stringify([{work_id:workId}]));
      if(String(url).endsWith("claim_yutakasa_completion_notice"))
        return new Response(JSON.stringify({status:"suppressed"}));
      assert.fail("suppressed notice must not call provider");
    }});
  assert.deepEqual(result,{examined:1,accepted:0,needsReview:0});
});

test("claim refuses changed work, key, recipient, and subject",()=>{
  assert.deepEqual(validateClaim(claim,workId,claimToken),claim);
  for(const changed of [{work_id:"323e4567-e89b-42d3-a456-426614174000"},
    {idempotency_key:"new-key"},{recipient_email:"bad\n@example.com"},
    {ticket_subject:"bad\rsubject"}]){
    assert.throws(()=>validateClaim({...claim,...changed},workId,claimToken),
      TicketCompletionNoticeError);
  }
});

test("one claimed notice uses the fixed body and key then records provider acceptance",async()=>{
  const calls=[];
  const result=await drainCompletionNotices({env,uuid:()=>claimToken,
    fetchImpl:async(url,init)=>{
      calls.push({url:String(url),init});
      if(String(url).endsWith("list_due_yutakasa_completion_notices"))
        return new Response(JSON.stringify([{work_id:workId}]));
      if(String(url).endsWith("claim_yutakasa_completion_notice"))
        return new Response(JSON.stringify(claim));
      if(String(url)==="https://api.resend.com/emails")
        return new Response(JSON.stringify({id:providerId}),{status:200});
      if(String(url).endsWith("finish_yutakasa_completion_notice"))
        return new Response(JSON.stringify([{status:"accepted"}]));
      assert.fail("unexpected request");
    }});
  assert.deepEqual(result,{examined:1,accepted:1,needsReview:0});
  const sent=calls.find((c)=>c.url==="https://api.resend.com/emails");
  assert.equal(sent.init.headers["Idempotency-Key"],claim.idempotency_key);
  const payload=JSON.parse(sent.init.body);
  assert.deepEqual(payload.to,[claim.recipient_email]);
  assert.equal(payload.subject,"【豊かさAI】「会話が消える」へ返信しました");
  assert.match(payload.text,/サポート画面へ返信しました/u);
  assert.doesNotMatch(payload.text,/会話が消える/u);
  assert.equal(calls.filter((c)=>c.url==="https://api.resend.com/emails").length,1);
});

test("timeout keeps the same durable key and marks outcome uncertain without retrying POST",async()=>{
  let posts=0,marks=0;
  await assert.rejects(()=>drainCompletionNotices({env,uuid:()=>claimToken,
    fetchImpl:async(url)=>{
      if(String(url).endsWith("list_due_yutakasa_completion_notices"))
        return new Response(JSON.stringify([{work_id:workId}]));
      if(String(url).endsWith("claim_yutakasa_completion_notice"))
        return new Response(JSON.stringify(claim));
      if(String(url)==="https://api.resend.com/emails"){
        posts+=1;throw new Error("timeout");
      }
      if(String(url).endsWith("mark_yutakasa_completion_notice_uncertain")){
        marks+=1;return new Response(JSON.stringify([{status:"uncertain"}]));
      }
      assert.fail("unexpected request");
    }}),
  (error)=>error instanceof TicketCompletionNoticeError&&
    error.code==="completion_notice_provider_outcome_unconfirmed");
  assert.equal(posts,1);
  assert.equal(marks,1);
});

test("invalid recipient never reaches Resend and requires human review",async()=>{
  let posts=0;
  await assert.rejects(()=>drainCompletionNotices({env,uuid:()=>claimToken,
    fetchImpl:async(url,init)=>{
      if(String(url).endsWith("list_due_yutakasa_completion_notices"))
        return new Response(JSON.stringify([{work_id:workId}]));
      if(String(url).endsWith("claim_yutakasa_completion_notice"))
        return new Response(JSON.stringify({...claim,recipient_email:"bad\n@example.com"}));
      if(String(url).endsWith("mark_yutakasa_completion_notice_uncertain")){
        assert.equal(JSON.parse(init.body).p_error_code,"invalid_notice_payload");
        return new Response(JSON.stringify([{status:"needs_review"}]));
      }
      if(String(url)==="https://api.resend.com/emails")posts+=1;
      assert.fail("unexpected request");
    }}),TicketCompletionNoticeError);
  assert.equal(posts,0);
});

test("missing provider key and probe mode fail before database access",async()=>{
  for(const changed of [{YUTAKASA_RESEND_API_KEY:""},
    {GITHUB_EVENT_NAME:"workflow_dispatch",TICKET_RECONCILE_MODE:"probe"}]){
    await assert.rejects(()=>drainCompletionNotices({env:{...env,...changed},
      fetchImpl:()=>assert.fail("must not call")}),TicketCompletionNoticeError);
  }
});
