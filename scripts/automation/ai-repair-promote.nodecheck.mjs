import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import { AiRepairPromoteError, checkCandidate, prepareReleaseLedger, promoteAiRepair, verifyMainProtection,
  verifyTicketPromotionLink } from "./ai-repair-promote.mjs";

const SHA = "a".repeat(40);
const BRANCH = "codex/yutakasa-ai-repair-0123456789abcdef";
const PR = {
  number: 42, state: "open", draft: true, mergeable: true, mergeable_state: "draft",
  changed_files: 2, base: { ref: "main", sha: "b".repeat(40) },
  head: { sha: SHA, ref: BRANCH, repo: { full_name: "sanrinawakes/yutakasa-tapping-coach" } },
};
const FILES = [
  { filename: "src/lib/gemini.ts", status: "modified" },
  { filename: "src/lib/gemini.retry.test.ts", status: "modified" },
];
const RUNS = Object.fromEntries(
  ["source-repair-ci.yml", "ai-repair-independent-review.yml"].map((workflow, index) => [
    workflow,
    [{ id: index + 1, head_sha: SHA, head_branch: BRANCH, event: "pull_request",
      path: `.github/workflows/${workflow}`, status: "completed", conclusion: "success" }],
  ]),
);
const VERCEL = { sha: SHA, statuses: [{ context: "Vercel", state: "success",
  description: "Deployment has completed",
  target_url: "https://vercel.com/sanrinawakes-projects/yutakasa-tapping-coach/preview123" }] };

test("promotion requires approved source CI and separate review on exact PR head", () => {
  assert.deepEqual(checkCandidate({ pr: PR, files: FILES, runsByWorkflow: RUNS,
    vercelStatus: VERCEL, expectedSha: SHA, mainSha: "b".repeat(40) }), {
    prNumber: 42, headSha: SHA,
  });
  assert.deepEqual(checkCandidate({ pr: { ...PR, mergeable_state: "clean" },
    files: FILES, runsByWorkflow: RUNS,
    vercelStatus: VERCEL, expectedSha: SHA, mainSha: "b".repeat(40) }), {
    prNumber: 42, headSha: SHA,
  });
  for (const invalid of [
    { pr: { ...PR, head: { ...PR.head, sha: "b".repeat(40) } }, files: FILES, runsByWorkflow: RUNS },
    { pr: { ...PR, base: { ref: "other" } }, files: FILES, runsByWorkflow: RUNS },
    { pr: PR, files: [FILES[0], { filename: ".github/workflows/ai-repair.yml", status: "modified" }], runsByWorkflow: RUNS },
    { pr: PR, files: FILES, runsByWorkflow: { ...RUNS, "source-repair-ci.yml": [{ ...RUNS["source-repair-ci.yml"][0], conclusion: "failure" }] } },
    { pr: PR, files: FILES, runsByWorkflow: { ...RUNS, "ai-repair-independent-review.yml": [{ ...RUNS["ai-repair-independent-review.yml"][0], head_sha: "b".repeat(40) }] } },
  ]) {
    assert.throws(() => checkCandidate({ ...invalid, vercelStatus: VERCEL,
      expectedSha: SHA, mainSha: "b".repeat(40) }), AiRepairPromoteError);
  }
});

test("disabled auto merge never calls GitHub", async () => {
  let calls = 0;
  await assert.rejects(() => promoteAiRepair({
    env: { GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach" },
    fetchImpl: async () => { calls += 1; throw new Error("unexpected"); },
  }), AiRepairPromoteError);
  assert.equal(calls, 0);
});

test("main protection requires both exact check contexts and up-to-date enforcement", () => {
  const rules = [{ type: "required_status_checks", parameters: {
    strict_required_status_checks_policy: true,
    required_status_checks: [
      { context: "source-repair-verify" },
      { context: "ai-repair-independent-review" },
      { context: "Vercel" },
    ],
  } }];
  assert.deepEqual(verifyMainProtection(rules), { protected: true });
  assert.throws(() => verifyMainProtection([]), AiRepairPromoteError);
  assert.throws(() => verifyMainProtection([{ ...rules[0], parameters: { ...rules[0].parameters, strict_required_status_checks_policy: false } }]), AiRepairPromoteError);
  assert.throws(() => verifyMainProtection([{ ...rules[0], parameters: { ...rules[0].parameters, required_status_checks: [{ context: "source-repair-verify" }] } }]), AiRepairPromoteError);
});

test("unfinished independent review remains pending without a merge", () => {
  assert.throws(
    () => checkCandidate({
      pr: PR, files: FILES,
      runsByWorkflow: { ...RUNS, "ai-repair-independent-review.yml": [] },
      vercelStatus: VERCEL, expectedSha: SHA, mainSha: "b".repeat(40),
    }),
    (error) => error instanceof AiRepairPromoteError && error.code === "repair_ci_pending",
  );
});

test("Vercel preview must succeed for the same PR head before promotion", () => {
  assert.throws(() => checkCandidate({ pr: PR, files: FILES, runsByWorkflow: RUNS,
    vercelStatus: { sha: SHA, statuses: [] }, expectedSha: SHA, mainSha: "b".repeat(40) }),
  (error) => error instanceof AiRepairPromoteError && error.code === "repair_ci_pending");
  assert.throws(() => checkCandidate({ pr: PR, files: FILES, runsByWorkflow: RUNS,
    vercelStatus: { ...VERCEL, sha: "c".repeat(40) },
    expectedSha: SHA, mainSha: "b".repeat(40) }), AiRepairPromoteError);
  assert.throws(() => checkCandidate({ pr: PR, files: FILES, runsByWorkflow: RUNS,
    vercelStatus: { ...VERCEL, statuses: [{ ...VERCEL.statuses[0], state: "failure" }] },
    expectedSha: SHA, mainSha: "b".repeat(40) }), AiRepairPromoteError);
});

test("ticket PR requires an exact private live link immediately before merge",async()=>{
  const workId="e1aa3fb1-afae-43b8-b139-bc0fa4682255";
  const id=crypto.createHash("sha256").update(workId).digest("hex").slice(0,16);
  const pr={...PR,title:`Yutakasa support repair ${id}`,
    body:`Private support reference: ${id}\nCustomer content stays private.`,
    head:{...PR.head,ref:`codex/yutakasa-support-ai-${id}`}};
  const env={SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"s".repeat(40)};
  assert.deepEqual(checkCandidate({pr,files:FILES,
    runsByWorkflow:Object.fromEntries(Object.entries(RUNS).map(([name,runs])=>
      [name,runs.map((run)=>({...run,head_branch:pr.head.ref}))])),
    vercelStatus:VERCEL,expectedSha:SHA,mainSha:"b".repeat(40)}),
  {prNumber:42,headSha:SHA});
  const linked=async(url)=>new Response(JSON.stringify(String(url).includes("/rpc/")
    ? [{work_id:workId}]
    : [{work_id:workId,head_sha:SHA,status:"pr_open"}]),{status:200});
  assert.deepEqual(await verifyTicketPromotionLink(pr,env,linked),{ticketMode:true,workId});
  await assert.rejects(()=>verifyTicketPromotionLink(pr,env,async()=>
    new Response(JSON.stringify([]),{status:200})),AiRepairPromoteError);
  await assert.rejects(()=>verifyTicketPromotionLink({...pr,head:{...pr.head,sha:"b".repeat(40)}},env,
    linked),AiRepairPromoteError);
  await assert.rejects(()=>verifyTicketPromotionLink({...pr,
    title:`Yutakasa anomaly ${id}: fake`,body:"Production deployment: dpl_fake"},env,
    linked),AiRepairPromoteError);
  await assert.rejects(()=>verifyTicketPromotionLink({...pr,
    title:`Yutakasa anomaly ${id}: fake`,body:"Production deployment: dpl_fake",
    head:{...pr.head,ref:`codex/yutakasa-ai-repair-${id}`}},env,linked),AiRepairPromoteError);
});

test("exact synthetic allowlist and completed regression proof precede any merge request", async()=>{
  const workId="e1aa3fb1-afae-43b8-b139-bc0fa4682255";
  const id=crypto.createHash("sha256").update(workId).digest("hex").slice(0,16);
  const branch=`codex/yutakasa-support-ai-${id}`;
  const ticketId="123e4567-e89b-42d3-a456-426614174000";
  const messageId="223e4567-e89b-42d3-a456-426614174000";
  const ticketPr={...PR,title:`Yutakasa support repair ${id}`,
    body:`Private support reference: ${id}\nNo customer content.`,
    head:{...PR.head,ref:branch}};
  const env={YUTAKASA_AUTO_MERGE_ENABLED:"false",
    YUTAKASA_AUTO_MERGE_REHEARSAL_WORK_ID:workId,
    YUTAKASA_AUTO_MERGE_REHEARSAL_HEAD_SHA:SHA,
    GITHUB_REPOSITORY:"sanrinawakes/yutakasa-tapping-coach",REPAIR_TRIGGER_SHA:SHA,
    GH_TOKEN:"g".repeat(40),SUPABASE_URL:"https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY:"s".repeat(40)};
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const u=String(url);
    calls.push({url:u,method:options.method??"GET"});
    if(u.endsWith("/rules/branches/main"))return Response.json([{type:"required_status_checks",
      parameters:{strict_required_status_checks_policy:true,
        required_status_checks:[{context:"source-repair-verify"},
          {context:"ai-repair-independent-review"},{context:"Vercel"}]}}]);
    if(u.endsWith(`/commits/${SHA}/pulls`))return Response.json([{number:42}]);
    if(u.endsWith("/pulls/42"))return Response.json(ticketPr);
    if(u.endsWith("/commits/main"))return Response.json({sha:"b".repeat(40)});
    if(u.includes("/pulls/42/files?"))return Response.json([
      {filename:"src/lib/chat-thread.ts",status:"modified"},
      {filename:"src/lib/chat-thread.test.ts",status:"modified"}]);
    if(u.endsWith(`/commits/${SHA}/status`))return Response.json(VERCEL);
    if(u.includes("/actions/workflows/")){
      const wf=u.includes("source-repair-ci.yml")?"source-repair-ci.yml":"ai-repair-independent-review.yml";
      return Response.json({workflow_runs:RUNS[wf].map((run)=>({...run,head_branch:branch}))});
    }
    if(u.includes("/yutakasa_ticket_repair_jobs?pr_number="))return Response.json([
      {work_id:workId,head_sha:SHA,status:"pr_open"}]);
    if(u.endsWith("/rpc/verify_yutakasa_ticket_repair_pr"))return Response.json([{work_id:workId}]);
    if(u.includes("/yutakasa_ticket_repair_jobs?work_id="))return Response.json([
      {work_id:workId,ticket_id:ticketId,latest_user_message_id:messageId,
        pr_number:42,head_sha:SHA,status:"pr_open"}]);
    if(u.includes("/support_tickets?"))return Response.json([{id:ticketId,
      user_email:"yutakasa-auto-smoke+repair@example.invalid",
      subject:"チャットの見出しが空白になる",category:"technical",
      status:"in_progress",automation_status:"awaiting_repair",decision_required:false}]);
    if(u.includes("/support_messages?")&&u.includes("sender_type=eq.user"))return Response.json([
      {id:messageId,body:"チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。",
        created_at:"2026-09-17T12:00:00Z"}]);
    if(u.includes("/support_messages?")&&u.includes("sender_type=eq.admin"))return Response.json([]);
    if(u.includes("/support_attachments?"))return Response.json([]);
    assert.fail(`unexpected ${u}`);
  };
  let proofCalls=0;
  const missing=await promoteAiRepair({env,fetchImpl,proofImpl:async(params)=>{
    proofCalls+=1;
    assert.equal(params.workId,workId);
    assert.equal(params.headSha,SHA);
    return null;
  }});
  assert.equal(missing.status,"pending_evidence");
  assert.equal(proofCalls,1);
  assert.equal(calls.some((call)=>call.method==="PUT"||call.url.includes("yutakasa_repair_releases")),false);
  await assert.rejects(()=>promoteAiRepair({env:{...env,
    YUTAKASA_AUTO_MERGE_REHEARSAL_WORK_ID:"323e4567-e89b-42d3-a456-426614174000"},
    fetchImpl,proofImpl:async()=>assert.fail("wrong work must not load proof")}),
  (error)=>error instanceof AiRepairPromoteError&&error.code==="repair_pr_not_in_allowlist");
  await assert.rejects(()=>promoteAiRepair({env,fetchImpl:async(url,options)=>{
    if(String(url).includes("/support_messages?")&&
       String(url).includes("sender_type=eq.user"))return Response.json([
      {id:messageId,body:"チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。",
        created_at:"2026-09-17T12:00:00Z"},
      {id:"323e4567-e89b-42d3-a456-426614174000",body:"追加条件",
        created_at:"2026-09-17T11:00:00Z"},
    ]);
    return fetchImpl(url,options);
  },proofImpl:async()=>assert.fail("multiple messages must not load proof")}),
  (error)=>error instanceof AiRepairPromoteError&&error.code==="ticket_pr_condition_changed");
});

test("release ledger stores the exact regression run and digest before merge", async()=>{
  const env={SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"s".repeat(40)};
  const proof={beforeAfterRunId:12345,artifactSha256:"f".repeat(64)};
  const head="a".repeat(40);
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    calls.push({url:String(url),method:options.method??"GET",body:options.body});
    if((options.method??"GET")==="GET")return Response.json([]);
    return Response.json([{pr_number:42,head_sha:head,status:"pending_merge",
      ticket_before_after_run_id:proof.beforeAfterRunId,
      ticket_regression_artifact_sha256:proof.artifactSha256}],{status:201});
  };
  await prepareReleaseLedger(env,fetchImpl,42,head,proof);
  assert.equal(calls.length,2);
  assert.equal(calls[1].method,"POST");
  assert.equal(JSON.parse(calls[1].body).ticket_before_after_run_id,12345);
  assert.equal(JSON.parse(calls[1].body).ticket_regression_artifact_sha256,"f".repeat(64));
  const linkCalls=[];
  await prepareReleaseLedger(env,async(url,options={})=>{
    linkCalls.push({url:String(url),method:options.method??"GET",body:options.body});
    return Response.json((options.method??"GET")==="GET"
      ? [{pr_number:42,head_sha:head,merge_sha:null,status:"pending_merge",
        ticket_before_after_run_id:null,ticket_regression_artifact_sha256:null}]
      : [{pr_number:42,head_sha:head,merge_sha:null,status:"pending_merge",
        ticket_before_after_run_id:12345,ticket_regression_artifact_sha256:"f".repeat(64)}]);
  },42,head,proof);
  assert.equal(linkCalls.length,2);
  assert.equal(linkCalls[1].method,"PATCH");
  assert.ok(linkCalls[1].url.includes("ticket_before_after_run_id=is.null"));
  assert.ok(linkCalls[1].url.includes("ticket_regression_artifact_sha256=is.null"));
  await assert.rejects(()=>prepareReleaseLedger(env,async(_url,options={})=>
    Response.json((options.method??"GET")==="GET"
      ? [{pr_number:42,head_sha:head,merge_sha:null,status:"pending_merge",
        ticket_before_after_run_id:null,ticket_regression_artifact_sha256:null}]
      : []),42,head,proof),
  (error)=>error instanceof AiRepairPromoteError&&error.code==="release_ledger_provenance_unconfirmed");
  await assert.rejects(()=>prepareReleaseLedger(env,async()=>Response.json([{
    pr_number:42,head_sha:head,merge_sha:null,status:"pending_merge",
    ticket_before_after_run_id:12345,ticket_regression_artifact_sha256:"e".repeat(64),
  }]),42,head,proof),
  (error)=>error instanceof AiRepairPromoteError&&error.code==="release_ledger_conflict");
});
