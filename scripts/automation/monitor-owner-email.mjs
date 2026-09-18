#!/usr/bin/env node

import { alertTitle, normalizeAlertInput } from "./monitor-alert.mjs";

const REPOSITORY="sanrinawakes/yutakasa-tapping-coach";
const API=`https://api.github.com/repos/${REPOSITORY}`;
const RECIPIENT="181wyc@gmail.com";
const FROM="豊かさAI サポート <noreply@silversense.cc>";
const MARKER="yutakasa-monitor-owner-email-v1";
const ROUTINE_REASONS=new Set(["pending_tickets","drive_intake_items",
  "ticket_reconcile_work_due"]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const MAX_BYTES=1024*1024;

export class MonitorOwnerEmailError extends Error {
  constructor(code){super(code);this.name="MonitorOwnerEmailError";this.code=code;}
}
function fail(code){throw new MonitorOwnerEmailError(code);}

async function boundedJson(response){
  const raw=await response.text();
  if(Buffer.byteLength(raw)>MAX_BYTES)fail("monitor_email_response_large");
  try{return JSON.parse(raw);}catch{fail("monitor_email_response_invalid");}
}
async function request(fetchImpl,url,options){
  try{return await fetchImpl(url,{...options,redirect:"error",
    signal:AbortSignal.timeout(15_000)});
  }catch{fail("monitor_email_request_uncertain");}
}
function githubHeaders(token){
  return {Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json",
    "Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28"};
}
async function listOpenIssues(fetchImpl,token){
  const found=[];
  for(let page=1;page<=10;page++){
    const response=await request(fetchImpl,`${API}/issues?state=open&per_page=100&page=${page}`,{
      method:"GET",headers:githubHeaders(token)});
    if(response.status!==200)fail("monitor_email_issue_list_failed");
    const rows=await boundedJson(response);
    if(!Array.isArray(rows)||rows.length>100)fail("monitor_email_issue_list_invalid");
    for(const row of rows){
      if(row?.pull_request||typeof row?.title!=="string"||
          !row.title.startsWith("[Yutakasa monitor] "))continue;
      const reason=row.title.slice("[Yutakasa monitor] ".length);
      try{if(alertTitle(reason)!==row.title)continue;}catch{continue;}
      if(ROUTINE_REASONS.has(reason))continue;
      if(!Number.isSafeInteger(row.number)||row.number<1||
          !Number.isFinite(Date.parse(row.created_at??"")))
        fail("monitor_email_issue_invalid");
      found.push({number:row.number,reason,createdAt:row.created_at});
    }
    if(rows.length<100)return found;
  }
  fail("monitor_email_issue_list_limit");
}
async function listMarkers(fetchImpl,token,issueNumber){
  let attemptAt=null,delivered=false;
  for(let page=1;page<=5;page++){
    const response=await request(fetchImpl,
      `${API}/issues/${issueNumber}/comments?per_page=100&page=${page}`,{
        method:"GET",headers:githubHeaders(token)});
    if(response.status!==200)fail("monitor_email_comment_list_failed");
    const rows=await boundedJson(response);
    if(!Array.isArray(rows)||rows.length>100)fail("monitor_email_comment_list_invalid");
    for(const row of rows){
      if(row?.user?.login!=="github-actions[bot]"||typeof row.body!=="string")continue;
      const deliveredMatch=row.body.match(new RegExp(`^管理者メールの配達を確認しました。\\n<!-- ${MARKER}:delivered:([a-f0-9-]{36}) -->$`,"iu"));
      if(deliveredMatch&&UUID.test(deliveredMatch[1]))delivered=true;
      const attemptMatch=row.body.match(new RegExp(`^管理者メールの送信を開始しました。\\n<!-- ${MARKER}:attempt:([^ ]+) -->$`,"u"));
      if(attemptMatch&&Number.isFinite(Date.parse(attemptMatch[1])))
        attemptAt=attemptAt===null||Date.parse(attemptMatch[1])<Date.parse(attemptAt)
          ?attemptMatch[1]:attemptAt;
    }
    if(rows.length<100)return {attemptAt,delivered};
  }
  fail("monitor_email_comment_list_limit");
}
async function comment(fetchImpl,token,issueNumber,body){
  const response=await request(fetchImpl,`${API}/issues/${issueNumber}/comments`,{
    method:"POST",headers:githubHeaders(token),body:JSON.stringify({body})});
  if(response.status!==201)fail("monitor_email_comment_create_failed");
  const receipt=await boundedJson(response);
  if(receipt?.body!==body||!Number.isSafeInteger(receipt.id))
    fail("monitor_email_comment_receipt_invalid");
}
function ownerMessage(reason){
  if(reason==="support_owner_decision_required")return {
    subject:"判断と返信が必要な問い合わせがあります",
    detail:"運営者の判断が必要な問い合わせを検知しました。管理画面で内容と履歴を確認し、会員サイト内で返信してください。",
    action:"https://yutakasa-tapping-coach.vercel.app/admin/support",
  };
  if(reason==="support_technical_review_required")return {
    subject:"お客様の技術報告を確認してください",
    detail:"技術的な報告の自動対応が止まりました。管理画面で報告内容と履歴を確認し、修正状況に応じてお客様へ返信してください。",
    action:"https://yutakasa-tapping-coach.vercel.app/admin/support",
  };
  if(reason.startsWith("production_log_")||reason.startsWith("historical_production_log_"))
    return {subject:"サービスのエラーを検知しました",
      detail:"本番サービスの記録にエラーがありました。原因とお客様への影響はまだ確認できていません。監視記録を開いて調査してください。"};
  if(reason.includes("snapshot")||reason.includes("monitor")||
      reason.includes("dispatch")||reason.includes("reconcile"))
    return {subject:"自動監視の確認が必要です",
      detail:"問い合わせやサービス状態の自動確認が正常に終わりませんでした。監視記録を開いて原因を確認してください。"};
  return {subject:"豊かさBOTで確認が必要な問題があります",
    detail:"問い合わせ対応またはサービス状態の確認で問題を検知しました。監視記録を開いて内容を確認してください。"};
}
async function sendAndVerify(fetchImpl,key,reason,issueNumber,resendKey){
  const message=ownerMessage(reason);
  const response=await request(fetchImpl,"https://api.resend.com/emails",{
    method:"POST",headers:{Authorization:`Bearer ${resendKey}`,
      "Content-Type":"application/json","Idempotency-Key":key},
    body:JSON.stringify({from:FROM,to:[RECIPIENT],
      subject:`【豊かさBOT】${message.subject}`,
      text:`${message.detail}\n\n`+
        `${message.action ? `問い合わせ管理画面: ${message.action}\n` : ""}`+
        `監視記録: https://github.com/${REPOSITORY}/issues/${issueNumber}\n\n`+
        "この通知は原因の確定や修正完了を示すものではありません。"})});
  if(response.status!==200&&response.status!==201)fail("monitor_email_provider_http_uncertain");
  const receipt=await boundedJson(response);
  if(!UUID.test(receipt?.id??""))fail("monitor_email_provider_receipt_invalid");
  for(let attempt=0;attempt<5;attempt++){
    const checked=await request(fetchImpl,`https://api.resend.com/emails/${receipt.id}`,{
      method:"GET",headers:{Authorization:`Bearer ${resendKey}`,
        Accept:"application/json"}});
    if(checked.status!==200)fail("monitor_email_provider_check_failed");
    const result=await boundedJson(checked);
    if(result?.id!==receipt.id||result?.object!=="email"||
        result?.to?.length!==1||result.to[0]?.toLowerCase()!==RECIPIENT)
      fail("monitor_email_provider_check_invalid");
    if(result.last_event==="delivered")return receipt.id;
    if(["bounced","complained","canceled","failed"].includes(result.last_event))
      fail("monitor_email_provider_adverse_event");
    if(attempt<4)await new Promise(resolve=>setTimeout(resolve,3000));
  }
  fail("monitor_email_delivery_pending");
}

export async function runMonitorOwnerEmail({env=process.env,
  fetchImpl=globalThis.fetch,now=new Date()}={}){
  if(env.YUTAKASA_MONITOR_OWNER_EMAIL_ENABLED!=="true")
    return {ok:true,disabled:true,examined:0,delivered:0,alreadyDelivered:0};
  const cutoff=Date.parse(env.YUTAKASA_MONITOR_OWNER_EMAIL_CUTOFF??"");
  if(env.GITHUB_REPOSITORY!==REPOSITORY||env.GITHUB_REF!=="refs/heads/main"||
      !["workflow_dispatch","schedule"].includes(env.GITHUB_EVENT_NAME)||
      typeof env.GITHUB_TOKEN!=="string"||env.GITHUB_TOKEN.length<20||
      typeof env.YUTAKASA_RESEND_API_KEY!=="string"||
        env.YUTAKASA_RESEND_API_KEY.length<20||
      env.YUTAKASA_TECHNICAL_ESCALATION_EMAIL!==RECIPIENT||
      !Number.isFinite(cutoff)||cutoff>now.getTime()||
      !Number.isFinite(now.getTime()))fail("monitor_email_configuration_invalid");
  let activeReasons=new Set();
  if(env.GITHUB_EVENT_NAME==="workflow_dispatch"){
    try{activeReasons=new Set(normalizeAlertInput(env.ALERT_REASON_CODES,"unknown").reasonCodes);}
    catch{fail("monitor_email_dispatch_input_invalid");}
  }
  const issues=await listOpenIssues(fetchImpl,env.GITHUB_TOKEN);
  if(issues.length>50)fail("monitor_email_backlog_large");
  let delivered=0,alreadyDelivered=0;
  let examined=0;
  for(const issue of issues){
    const markers=await listMarkers(fetchImpl,env.GITHUB_TOKEN,issue.number);
    const eligible=Date.parse(issue.createdAt)>=cutoff||
      activeReasons.has(issue.reason)||
      (markers.attemptAt!==null&&Date.parse(markers.attemptAt)>=cutoff);
    if(!eligible)continue;
    examined++;
    if(examined>20)fail("monitor_email_backlog_large");
    if(markers.delivered){alreadyDelivered++;continue;}
    const attemptAt=markers.attemptAt??now.toISOString();
    if(now.getTime()-Date.parse(attemptAt)>=23*60*60*1000)
      fail("monitor_email_idempotency_window_expired");
    if(markers.attemptAt===null)await comment(fetchImpl,env.GITHUB_TOKEN,
      issue.number,`管理者メールの送信を開始しました。\n<!-- ${MARKER}:attempt:${attemptAt} -->`);
    const providerId=await sendAndVerify(fetchImpl,
      `yutakasa-monitor-alert/${issue.number}`,issue.reason,issue.number,
      env.YUTAKASA_RESEND_API_KEY);
    await comment(fetchImpl,env.GITHUB_TOKEN,issue.number,
      `管理者メールの配達を確認しました。\n<!-- ${MARKER}:delivered:${providerId} -->`);
    delivered++;
  }
  return {ok:true,examined,delivered,alreadyDelivered};
}

if(process.argv[1]?.endsWith("/monitor-owner-email.mjs")){
  runMonitorOwnerEmail().then(result=>console.log(JSON.stringify(result)),error=>{
    console.log(JSON.stringify({ok:false,code:error instanceof MonitorOwnerEmailError
      ?error.code:"monitor_email_unexpected_failure"}));
    process.exitCode=1;
  });
}
