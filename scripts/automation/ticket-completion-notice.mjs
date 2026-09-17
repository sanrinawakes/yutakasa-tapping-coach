#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const REPOSITORY="sanrinawakes/yutakasa-tapping-coach";
const SUPPORT_URL="https://yutakasa-tapping-coach.vercel.app/support";
const FROM="豊かさAI サポート <noreply@silversense.cc>";
const TEXT=`豊かさAIのサポート画面へ返信しました。\n\nこちらから内容をご確認ください。\n${SUPPORT_URL}\n\nこのメールへ返信しても、問い合わせ履歴には追加されません。追加のご連絡は豊かさAI内の問い合わせ画面からお送りください。`;

export class TicketCompletionNoticeError extends Error {
  constructor(code){super(code);this.name="TicketCompletionNoticeError";this.code=code;}
}
function fail(code){throw new TicketCompletionNoticeError(code);}

async function rpc(env,fetchImpl,name,body={}){
  const response=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:"POST",headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept:"application/json","content-type":"application/json"},
    body:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(15_000),
  }).catch(()=>fail("completion_notice_db_request_failed"));
  if(response.status!==200)fail("completion_notice_db_http_failure");
  const raw=await response.text();
  if(Buffer.byteLength(raw)>16*1024)fail("completion_notice_db_response_large");
  try{return JSON.parse(raw);}catch{fail("completion_notice_db_response_invalid");}
}

export function validateClaim(claim,workId,claimToken){
  if(claim?.status==="busy"||claim?.status==="accepted"||
      claim?.status==="suppressed"||claim?.status==="needs_review"){
    if(Object.keys(claim).join(",")!=="status")fail("completion_notice_claim_invalid");
    return claim;
  }
  if(!claim||typeof claim!=="object"||Array.isArray(claim)||
      Object.keys(claim).sort().join(",")!==
        "claim_token,idempotency_key,recipient_email,status,ticket_subject,work_id"||
      claim.status!=="sending"||claim.work_id!==workId||claim.claim_token!==claimToken||
      claim.idempotency_key!==`yutakasa-ticket-completion/${workId}`||
      typeof claim.recipient_email!=="string"||claim.recipient_email.length>254||
      !/^[^\s@,;<>"\u0000-\u001f\u007f]+@[^\s@,;<>"\u0000-\u001f\u007f]+\.[^\s@,;<>"\u0000-\u001f\u007f]+$/u.test(claim.recipient_email)||
      typeof claim.ticket_subject!=="string"||claim.ticket_subject.length<1||
      claim.ticket_subject.length>120||/[\u0000-\u001f\u007f]/u.test(claim.ticket_subject)){
    fail("completion_notice_claim_invalid");
  }
  return claim;
}

async function markUncertain(env,fetchImpl,workId,claimToken,code){
  const receipt=await rpc(env,fetchImpl,"mark_yutakasa_completion_notice_uncertain",{
    p_work_id:workId,p_claim_token:claimToken,p_error_code:code,
  });
  if(!Array.isArray(receipt)||receipt.length!==1||
      !["uncertain","needs_review"].includes(receipt[0]?.status)){
    fail("completion_notice_uncertain_receipt_invalid");
  }
}

export async function drainCompletionNotices({env=process.env,
  fetchImpl=globalThis.fetch,uuid=randomUUID}={}){
  if(env.TICKET_COMPLETION_NOTICE_ENABLED!=="true")
    return {examined:0,accepted:0,needsReview:0};
  if(env.GITHUB_REPOSITORY!==REPOSITORY||env.GITHUB_REF!=="refs/heads/main"||
      env.TICKET_RECONCILE_ENABLED!=="true"||
      !((env.GITHUB_EVENT_NAME==="schedule"&&!env.TICKET_RECONCILE_MODE)||
        (env.GITHUB_EVENT_NAME==="workflow_dispatch"&&env.TICKET_RECONCILE_MODE==="reconcile"))||
      typeof env.SUPABASE_URL!=="string"||!/^https:\/\/[^/]+$/u.test(env.SUPABASE_URL)||
      typeof env.SUPABASE_SERVICE_ROLE_KEY!=="string"||env.SUPABASE_SERVICE_ROLE_KEY.length<20||
      typeof env.YUTAKASA_RESEND_API_KEY!=="string"||env.YUTAKASA_RESEND_API_KEY.length<20){
    fail("completion_notice_configuration_invalid");
  }
  const jobs=await rpc(env,fetchImpl,"list_due_yutakasa_completion_notices");
  if(!Array.isArray(jobs)||jobs.length>21||jobs.some((j)=>
      Object.keys(j??{}).join(",")!=="work_id"||!UUID.test(j.work_id??""))){
    fail("completion_notice_queue_invalid");
  }
  let accepted=0,needsReview=0,uncertain=0;
  for(const job of jobs.slice(0,20)){
    const claimToken=uuid();
    if(!UUID.test(claimToken))fail("completion_notice_claim_token_invalid");
    const raw=await rpc(env,fetchImpl,"claim_yutakasa_completion_notice",{
      p_work_id:job.work_id,p_claim_token:claimToken,
    });
    let claim;
    try{claim=validateClaim(raw,job.work_id,claimToken);}
    catch{
      await markUncertain(env,fetchImpl,job.work_id,claimToken,"invalid_notice_payload");
      needsReview+=1;continue;
    }
    if(claim.status==="needs_review"){needsReview+=1;continue;}
    if(claim.status!=="sending")continue;
    let response;
    try{
      response=await fetchImpl("https://api.resend.com/emails",{
        method:"POST",headers:{Authorization:`Bearer ${env.YUTAKASA_RESEND_API_KEY}`,
          "Content-Type":"application/json","Idempotency-Key":claim.idempotency_key},
        body:JSON.stringify({from:FROM,to:[claim.recipient_email],
          subject:`【豊かさAI】「${claim.ticket_subject}」へ返信しました`,text:TEXT}),
        redirect:"error",signal:AbortSignal.timeout(15_000),
      });
    }catch{
      await markUncertain(env,fetchImpl,job.work_id,claimToken,"provider_request_uncertain");
      uncertain+=1;continue;
    }
    if(response.status!==200&&response.status!==201){
      await markUncertain(env,fetchImpl,job.work_id,claimToken,"provider_http_uncertain");
      uncertain+=1;continue;
    }
    const rawBody=await response.text().catch(()=>"");
    let providerId;
    if(Buffer.byteLength(rawBody)<=4096){
      try{providerId=JSON.parse(rawBody)?.id;}catch{/* uncertain */}
    }
    if(!UUID.test(providerId??"")){
      await markUncertain(env,fetchImpl,job.work_id,claimToken,"provider_receipt_uncertain");
      uncertain+=1;continue;
    }
    const receipt=await rpc(env,fetchImpl,"finish_yutakasa_completion_notice",{
      p_work_id:job.work_id,p_claim_token:claimToken,p_provider_email_id:providerId,
    });
    if(!Array.isArray(receipt)||receipt.length!==1||receipt[0]?.status!=="accepted"){
      fail("completion_notice_finish_unconfirmed");
    }
    accepted+=1;
  }
  if(jobs.length===21)fail("completion_notice_backlog_remaining");
  if(uncertain||needsReview)fail("completion_notice_provider_outcome_unconfirmed");
  return {examined:jobs.length,accepted,needsReview};
}
