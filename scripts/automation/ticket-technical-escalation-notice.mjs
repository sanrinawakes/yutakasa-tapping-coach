#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const EMAIL=/^[^\s@,;<>"\u0000-\u001f\u007f]+@[^\s@,;<>"\u0000-\u001f\u007f]+\.[^\s@,;<>"\u0000-\u001f\u007f]+$/u;
const REPOSITORY="sanrinawakes/yutakasa-tapping-coach";
const SUPPORT_URL="https://yutakasa-tapping-coach.vercel.app/admin/support";
const FROM="豊かさAI サポート <noreply@silversense.cc>";

export class TicketTechnicalEscalationNoticeError extends Error {
  constructor(code){super(code);this.name="TicketTechnicalEscalationNoticeError";this.code=code;}
}
function fail(code){throw new TicketTechnicalEscalationNoticeError(code);}

async function rpc(env,fetchImpl,name,body={}){
  const response=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:"POST",headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept:"application/json","content-type":"application/json"},
    body:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(15_000),
  }).catch(()=>fail("technical_escalation_db_request_failed"));
  if(response.status!==200)fail("technical_escalation_db_http_failure");
  const raw=await response.text();
  if(Buffer.byteLength(raw)>16*1024)fail("technical_escalation_db_response_large");
  try{return JSON.parse(raw);}catch{fail("technical_escalation_db_response_invalid");}
}

export function validateTechnicalEscalationClaim(claim,ticketId,messageId,token){
  if(["busy","accepted","suppressed","needs_review"].includes(claim?.status)){
    if(Object.keys(claim).join(",")!=="status")fail("technical_escalation_claim_invalid");
    return claim;
  }
  if(!claim||typeof claim!=="object"||Array.isArray(claim)||
      Object.keys(claim).sort().join(",")!==
        "claim_token,idempotency_key,latest_user_message_id,status,ticket_id"||
      claim.status!=="sending"||claim.ticket_id!==ticketId||
      claim.latest_user_message_id!==messageId||claim.claim_token!==token||
      claim.idempotency_key!==`yutakasa-technical-escalation/${ticketId}/${messageId}`){
    fail("technical_escalation_claim_invalid");
  }
  return claim;
}

async function markUncertain(env,fetchImpl,ticketId,messageId,claimToken,code){
  const receipt=await rpc(env,fetchImpl,"mark_yutakasa_technical_escalation_notice_uncertain",{
    p_ticket_id:ticketId,p_latest_user_message_id:messageId,
    p_claim_token:claimToken,p_error_code:code,
  });
  if(!Array.isArray(receipt)||receipt.length!==1||receipt[0]?.status!=="uncertain")
    fail("technical_escalation_uncertain_receipt_invalid");
}

export async function drainTechnicalEscalationNotices({env=process.env,
  fetchImpl=globalThis.fetch,uuid=randomUUID}={}){
  if(env.TICKET_TECHNICAL_ESCALATION_NOTICE_ENABLED!=="true")
    return {examined:0,accepted:0,uncertain:0,needsReview:0};
  if(env.GITHUB_REPOSITORY!==REPOSITORY||env.GITHUB_REF!=="refs/heads/main"||
      env.TICKET_RECONCILE_ENABLED!=="true"||
      !((env.GITHUB_EVENT_NAME==="schedule"&&!env.TICKET_RECONCILE_MODE)||
        (env.GITHUB_EVENT_NAME==="workflow_dispatch"&&env.TICKET_RECONCILE_MODE==="reconcile"))||
      typeof env.SUPABASE_URL!=="string"||!/^https:\/\/[^/]+$/u.test(env.SUPABASE_URL)||
      typeof env.SUPABASE_SERVICE_ROLE_KEY!=="string"||env.SUPABASE_SERVICE_ROLE_KEY.length<20||
      typeof env.YUTAKASA_RESEND_API_KEY!=="string"||env.YUTAKASA_RESEND_API_KEY.length<20||
      typeof env.YUTAKASA_TECHNICAL_ESCALATION_EMAIL!=="string"||
      !EMAIL.test(env.YUTAKASA_TECHNICAL_ESCALATION_EMAIL)){
    fail("technical_escalation_configuration_invalid");
  }
  const due=await rpc(env,fetchImpl,"list_due_yutakasa_technical_escalation_notices");
  if(!Array.isArray(due)||due.length>21||due.some((entry)=>
      Object.keys(entry??{}).sort().join(",")!=="latest_user_message_id,ticket_id"||
      !UUID.test(entry.ticket_id??"")||!UUID.test(entry.latest_user_message_id??"")))
    fail("technical_escalation_queue_invalid");
  let accepted=0,uncertain=0,needsReview=0;
  for(const entry of due.slice(0,20)){
    const claimToken=uuid();
    if(!UUID.test(claimToken))fail("technical_escalation_claim_token_invalid");
    const raw=await rpc(env,fetchImpl,"claim_yutakasa_technical_escalation_notice",{
      p_ticket_id:entry.ticket_id,p_latest_user_message_id:entry.latest_user_message_id,
      p_claim_token:claimToken,
    });
    const claim=validateTechnicalEscalationClaim(raw,entry.ticket_id,
      entry.latest_user_message_id,claimToken);
    if(claim.status==="needs_review"){needsReview+=1;continue;}
    if(claim.status!=="sending")continue;
    let response;
    try{
      response=await fetchImpl("https://api.resend.com/emails",{
        method:"POST",headers:{Authorization:`Bearer ${env.YUTAKASA_RESEND_API_KEY}`,
          "Content-Type":"application/json","Idempotency-Key":claim.idempotency_key},
        body:JSON.stringify({from:FROM,to:[env.YUTAKASA_TECHNICAL_ESCALATION_EMAIL],
          subject:"【豊かさAI】技術案件の自動対応が停止しました",
          text:`技術案件の自動対応が停止し、Codexによる調査が必要です。\n`+
            `案件ID: ${entry.ticket_id}\n\n`+
            `最新の状況を管理画面で確認してください。\n${SUPPORT_URL}\n\n`+
            "この通知は修正や顧客返信の完了を示すものではありません。"}),
        redirect:"error",signal:AbortSignal.timeout(15_000),
      });
    }catch{
      await markUncertain(env,fetchImpl,entry.ticket_id,entry.latest_user_message_id,
        claimToken,"provider_request_uncertain");
      uncertain+=1;continue;
    }
    if(response.status!==200&&response.status!==201){
      await markUncertain(env,fetchImpl,entry.ticket_id,entry.latest_user_message_id,
        claimToken,"provider_http_uncertain");
      uncertain+=1;continue;
    }
    const body=await response.text().catch(()=>"");
    let providerId;
    if(Buffer.byteLength(body)<=4096){try{providerId=JSON.parse(body)?.id;}catch{/* uncertain */}}
    if(!UUID.test(providerId??"")){
      await markUncertain(env,fetchImpl,entry.ticket_id,entry.latest_user_message_id,
        claimToken,"provider_receipt_uncertain");
      uncertain+=1;continue;
    }
    const receipt=await rpc(env,fetchImpl,"finish_yutakasa_technical_escalation_notice",{
      p_ticket_id:entry.ticket_id,p_latest_user_message_id:entry.latest_user_message_id,
      p_claim_token:claimToken,p_provider_email_id:providerId,
    });
    if(!Array.isArray(receipt)||receipt.length!==1||receipt[0]?.status!=="accepted")
      fail("technical_escalation_finish_unconfirmed");
    accepted+=1;
  }
  if(due.length===21)fail("technical_escalation_backlog_remaining");
  return {examined:due.length,accepted,uncertain,needsReview};
}
