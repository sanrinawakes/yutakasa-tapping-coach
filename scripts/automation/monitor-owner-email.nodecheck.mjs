import assert from "node:assert/strict";
import test from "node:test";
import { runMonitorOwnerEmail, MonitorOwnerEmailError } from "./monitor-owner-email.mjs";

const recipient="181wyc@gmail.com";
const providerId="65dd4860-90c7-4511-853e-b3f485b94a4e";
const now=new Date("2026-09-18T10:00:00Z");
const env={GITHUB_REPOSITORY:"sanrinawakes/yutakasa-tapping-coach",
  GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"workflow_dispatch",
  ALERT_REASON_CODES:'["production_log_fiveXx"]',
  GITHUB_TOKEN:"test-github-token-long-enough",
  YUTAKASA_RESEND_API_KEY:"test-resend-key-long-enough",
  YUTAKASA_TECHNICAL_ESCALATION_EMAIL:recipient,
  YUTAKASA_MONITOR_OWNER_EMAIL_ENABLED:"true",
  YUTAKASA_MONITOR_OWNER_EMAIL_CUTOFF:"2026-09-18T00:00:00Z"};
const issue={number:123,title:"[Yutakasa monitor] production_log_fiveXx",
  created_at:"2026-09-18T09:00:00Z"};
function json(value,status=200){return Response.json(value,{status});}

test("disabled owner email makes no network request",async()=>{
  assert.deepEqual(await runMonitorOwnerEmail({env:{...env,
    YUTAKASA_MONITOR_OWNER_EMAIL_ENABLED:"false"},now,
    fetchImpl:()=>assert.fail("disabled must not access network")}),
  {ok:true,disabled:true,examined:0,delivered:0,alreadyDelivered:0});
});

test("wrong branch, recipient, cutoff, or key fails before network",async()=>{
  for(const changed of [{GITHUB_REF:"refs/heads/test"},
    {YUTAKASA_TECHNICAL_ESCALATION_EMAIL:"wrong@example.com"},
    {YUTAKASA_MONITOR_OWNER_EMAIL_CUTOFF:"bad"},
    {YUTAKASA_RESEND_API_KEY:""}]){
    await assert.rejects(()=>runMonitorOwnerEmail({env:{...env,...changed},now,
      fetchImpl:()=>assert.fail("invalid configuration must not access network")}),
    error=>error instanceof MonitorOwnerEmailError&&
      error.code==="monitor_email_configuration_invalid");
  }
});

test("old monitor issues do not cause retroactive email",async()=>{
  const result=await runMonitorOwnerEmail({env:{...env,GITHUB_EVENT_NAME:"schedule"},
    now,fetchImpl:async(url)=>{
    if(String(url).includes("/comments?"))return json([]);
    assert.match(String(url),/\/issues\?state=open/u);
    return json([{...issue,created_at:"2026-09-17T23:59:59Z"}]);
  }});
  assert.deepEqual(result,{ok:true,examined:0,delivered:0,alreadyDelivered:0});
});

test("routine queued work is not reported as an error email",async()=>{
  const result=await runMonitorOwnerEmail({env,now,fetchImpl:async(url)=>{
    assert.match(String(url),/\/issues\?state=open/u);
    return json([{...issue,title:"[Yutakasa monitor] pending_tickets"}]);
  }});
  assert.deepEqual(result,{ok:true,examined:0,delivered:0,alreadyDelivered:0});
});

test("a fresh recurrence of an older open error is emailed once",async()=>{
  const oldIssue={...issue,created_at:"2026-09-17T12:00:00Z"};
  const comments=[];
  let sent=0;
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;
    if(path.endsWith("/issues"))return json([oldIssue]);
    if(path.endsWith("/comments")&&options.method==="GET")return json(comments);
    if(path.endsWith("/comments")&&options.method==="POST"){
      const body=JSON.parse(options.body).body;
      comments.push({id:comments.length+1,body,user:{login:"github-actions[bot]"}});
      return json({id:comments.length,body},201);
    }
    if(path==="/emails"&&options.method==="POST"){
      sent++;
      return json({id:providerId},201);
    }
    if(path===`/emails/${providerId}`)
      return json({id:providerId,object:"email",to:[recipient],last_event:"delivered"});
    assert.fail(`unexpected request ${path}`);
  };
  assert.deepEqual(await runMonitorOwnerEmail({env,now,fetchImpl}),
    {ok:true,examined:1,delivered:1,alreadyDelivered:0});
  assert.deepEqual(await runMonitorOwnerEmail({env:{...env,GITHUB_EVENT_NAME:"schedule"},
    now,fetchImpl}),{ok:true,examined:1,delivered:0,alreadyDelivered:1});
  assert.equal(sent,1);
});

test("new monitored error sends one private email, verifies delivery, and does not resend",async()=>{
  const comments=[];
  const requests=[];
  let sendCount=0;
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;
    requests.push({path,method:options.method});
    if(path.endsWith("/issues"))return json([issue]);
    if(path.endsWith("/issues/123/comments")&&options.method==="GET")
      return json(comments);
    if(path.endsWith("/issues/123/comments")&&options.method==="POST"){
      const body=JSON.parse(options.body).body;
      comments.push({id:comments.length+1,body,user:{login:"github-actions[bot]"}});
      return json({id:comments.length,body},201);
    }
    if(path==="/emails"&&options.method==="POST"){
      sendCount++;
      assert.equal(options.headers["Idempotency-Key"],"yutakasa-monitor-alert/123");
      const body=JSON.parse(options.body);
      assert.deepEqual(body.to,[recipient]);
      assert.match(body.subject,/サービスのエラーを検知しました/u);
      assert.match(body.text,/本番サービスの記録にエラー/u);
      assert.doesNotMatch(body.text,/理由コード/u);
      assert.match(body.text,/issues\/123/u);
      assert.equal(JSON.stringify(body).includes("private customer text"),false);
      return json({id:providerId},201);
    }
    if(path===`/emails/${providerId}`&&options.method==="GET")
      return json({id:providerId,object:"email",to:[recipient],last_event:"delivered"});
    assert.fail(`unexpected request ${path}`);
  };
  assert.deepEqual(await runMonitorOwnerEmail({env,now,fetchImpl}),
    {ok:true,examined:1,delivered:1,alreadyDelivered:0});
  assert.deepEqual(await runMonitorOwnerEmail({env:{...env,GITHUB_EVENT_NAME:"schedule"},
    now,fetchImpl}),{ok:true,examined:1,delivered:0,alreadyDelivered:1});
  assert.equal(sendCount,1);
  assert.equal(comments.length,2);
  assert.match(comments[0].body,/attempt:2026-09-18T10:00:00.000Z/u);
  assert.match(comments[1].body,/delivered:65dd4860/u);
  assert.equal(requests.filter(r=>r.path==="/emails").length,1);
});

test("uncertain provider result retries with the same idempotency key",async()=>{
  const comments=[];
  let sends=0;
  const keys=[];
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;
    if(path.endsWith("/issues"))return json([issue]);
    if(path.endsWith("/issues/123/comments")&&options.method==="GET")
      return json(comments);
    if(path.endsWith("/issues/123/comments")&&options.method==="POST"){
      const body=JSON.parse(options.body).body;
      comments.push({id:comments.length+1,body,user:{login:"github-actions[bot]"}});
      return json({id:comments.length,body},201);
    }
    if(path==="/emails"&&options.method==="POST"){
      sends++;
      keys.push(options.headers["Idempotency-Key"]);
      if(sends===1)throw Error("provider timed out");
      return json({id:providerId},201);
    }
    if(path===`/emails/${providerId}`)
      return json({id:providerId,object:"email",to:[recipient],last_event:"delivered"});
    assert.fail(`unexpected request ${path}`);
  };
  await assert.rejects(()=>runMonitorOwnerEmail({env,now,fetchImpl}),
    error=>error instanceof MonitorOwnerEmailError&&
      error.code==="monitor_email_request_uncertain");
  assert.equal(comments.length,1);
  assert.deepEqual(await runMonitorOwnerEmail({env,now,fetchImpl}),
    {ok:true,examined:1,delivered:1,alreadyDelivered:0});
  assert.deepEqual(keys,["yutakasa-monitor-alert/123","yutakasa-monitor-alert/123"]);
});

test("expired attempt stops before provider retry",async()=>{
  const attempt="管理者メールの送信を開始しました。\n<!-- yutakasa-monitor-owner-email-v1:attempt:2026-09-17T10:00:00Z -->";
  await assert.rejects(()=>runMonitorOwnerEmail({env,now,fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;
    if(path.endsWith("/issues"))return json([issue]);
    if(path.endsWith("/comments")&&options.method==="GET")
      return json([{id:1,body:attempt,user:{login:"github-actions[bot]"}}]);
    assert.fail("expired notice must not send");
  }}),error=>error instanceof MonitorOwnerEmailError&&
    error.code==="monitor_email_idempotency_window_expired");
});
