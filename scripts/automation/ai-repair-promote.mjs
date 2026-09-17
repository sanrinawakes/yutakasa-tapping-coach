#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { findTicketRegressionProof, readRegressionTriggerHead } from "./ticket-regression-proof-check.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const ANOMALY_BRANCH = /^codex\/yutakasa-ai-repair-[a-f0-9]{16}$/u;
const TICKET_BRANCH = /^codex\/yutakasa-support-ai-[a-f0-9]{16}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SOURCES = new Set([
  "src/lib/gemini.ts", "src/lib/chat-thread.ts", "src/app/chat/page.tsx",
  "src/app/chat/layout.tsx", "src/app/api/chat/route.ts",
]);
const TESTS = new Set([
  "src/lib/gemini.retry.test.ts", "src/lib/chat-thread.test.ts",
  "src/app/chat/page.test.tsx", "src/app/api/chat/route.test.ts",
]);
const REQUIRED_WORKFLOWS = [
  "source-repair-ci.yml",
  "ai-repair-independent-review.yml",
];
const REQUIRED_CHECK_CONTEXTS = new Set(["source-repair-verify", "ai-repair-independent-review", "Vercel"]);

export class AiRepairPromoteError extends Error {
  constructor(code) {
    super(code);
    this.name = "AiRepairPromoteError";
    this.code = code;
  }
}

function fail(code) {
  throw new AiRepairPromoteError(code);
}

export function verifyMainProtection(rules) {
  if (!Array.isArray(rules)) fail("main_protection_evidence_invalid");
  const statusRules = rules.filter((rule) => rule?.type === "required_status_checks");
  if (statusRules.length < 1) fail("main_protection_incomplete");
  const protectedContexts = new Set();
  let strict = false;
  for (const rule of statusRules) {
    if (rule?.parameters?.strict_required_status_checks_policy === true) strict = true;
    for (const check of rule?.parameters?.required_status_checks ?? []) {
      if (typeof check?.context === "string") protectedContexts.add(check.context);
    }
  }
  if (!strict || [...REQUIRED_CHECK_CONTEXTS].some((context) => !protectedContexts.has(context))) {
    fail("main_protection_incomplete");
  }
  return { protected: true };
}

function checkCandidate({ pr, files, runsByWorkflow, vercelStatus, expectedSha, mainSha }) {
  if (
    !SHA.test(expectedSha ?? "") || !SHA.test(mainSha ?? "") ||
    !Number.isSafeInteger(pr?.number) || pr.number < 1 ||
    pr?.state !== "open" || typeof pr?.draft !== "boolean" ||
    pr?.base?.ref !== "main" || pr.base.sha !== mainSha || pr?.head?.sha !== expectedSha ||
    pr?.head?.repo?.full_name !== REPO ||
    !(ANOMALY_BRANCH.test(pr?.head?.ref ?? "") || TICKET_BRANCH.test(pr?.head?.ref ?? "")) ||
    pr?.mergeable !== true || !["clean", "draft"].includes(pr?.mergeable_state) ||
    (pr.draft && !["draft", "clean"].includes(pr.mergeable_state)) ||
    (!pr.draft && pr.mergeable_state !== "clean") ||
    !Number.isSafeInteger(pr?.changed_files) || pr.changed_files < 2 || pr.changed_files > 20 ||
    !Array.isArray(files) || files.length !== pr.changed_files
  ) fail("repair_pr_not_safe_to_merge");
  const seen = new Set();
  let hasSource = false;
  let hasTest = false;
  for (const file of files) {
    if (
      !file || file.status !== "modified" || typeof file.filename !== "string" ||
      seen.has(file.filename) ||
      (!SOURCES.has(file.filename) && !TESTS.has(file.filename))
    ) fail("repair_pr_files_invalid");
    seen.add(file.filename);
    hasSource ||= SOURCES.has(file.filename);
    hasTest ||= TESTS.has(file.filename);
  }
  if (!hasSource || !hasTest) fail("repair_pr_regression_test_missing");
  for (const workflow of REQUIRED_WORKFLOWS) {
    const runs = runsByWorkflow?.[workflow];
    if (!Array.isArray(runs) || runs.length > 100) fail("repair_ci_evidence_invalid");
    const matching = runs.filter((run) =>
      run?.head_sha === expectedSha && run?.head_branch === pr.head.ref &&
      run?.event === "pull_request" &&
      run?.path === `.github/workflows/${workflow}` &&
      Number.isSafeInteger(run?.id),
    ).sort((a, b) => b.id - a.id);
    if (matching.length === 0 || matching[0].status !== "completed") fail("repair_ci_pending");
    if (matching[0].conclusion !== "success") {
      fail(`repair_ci_${workflow.replace(/\W/gu, "_")}_not_passed`);
    }
  }
  const status = vercelStatus?.statuses?.find((item) => item?.context === "Vercel");
  if (!status || status.state === "pending") fail("repair_ci_pending");
  if (vercelStatus?.sha !== expectedSha || status.state !== "success" ||
      status.description !== "Deployment has completed" ||
      typeof status.target_url !== "string" ||
      !status.target_url.startsWith("https://vercel.com/sanrinawakes-projects/yutakasa-tapping-coach/")) {
    fail("repair_vercel_preview_not_passed");
  }
  return { prNumber: pr.number, headSha: expectedSha };
}

async function githubJson(url, token, fetchImpl, method = "GET", body) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}${url}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("github_request_failed"));
  if (response.status !== 200) fail(`github_http_${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > 1024 * 1024) fail("github_response_too_large");
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) fail("github_response_too_large");
  try {
    return JSON.parse(text);
  } catch {
    fail("github_response_invalid");
  }
}

async function markReady(nodeId, token, fetchImpl) {
  if (typeof nodeId !== "string" || !/^PR_[A-Za-z0-9_-]{10,100}$/u.test(nodeId)) {
    fail("repair_pr_node_invalid");
  }
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id,isDraft}}}",
      variables: { id: nodeId },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("github_ready_request_failed"));
  if (response.status !== 200) fail("github_ready_http_failure");
  const text = await response.text();
  if (Buffer.byteLength(text) > 64 * 1024) fail("github_ready_response_too_large");
  let data;
  try { data = JSON.parse(text); } catch { fail("github_ready_response_invalid"); }
  if (
    data?.errors?.length || data?.data?.markPullRequestReadyForReview?.pullRequest?.id !== nodeId ||
    data.data.markPullRequestReadyForReview.pullRequest.isDraft !== false
  ) fail("github_ready_confirmation_invalid");
}

async function releaseLedgerRequest(env, fetchImpl, method, query, body) {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof base !== "string" || !/^https:\/\/[^/]+$/u.test(base) ||
      typeof key !== "string" || key.length < 20) fail("release_ledger_configuration_invalid");
  const response = await fetchImpl(`${base}/rest/v1/yutakasa_repair_releases${query}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body ? { "content-type": "application/json", Prefer: "return=representation" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("release_ledger_request_failed"));
  if (![200, 201].includes(response.status)) fail(`release_ledger_http_${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 64 * 1024) fail("release_ledger_response_too_large");
  try { return JSON.parse(text); } catch { fail("release_ledger_response_invalid"); }
}

export async function prepareReleaseLedger(env, fetchImpl, number, sha, proof) {
  if (!Number.isSafeInteger(proof?.beforeAfterRunId) || proof.beforeAfterRunId < 1 ||
      !/^[a-f0-9]{64}$/u.test(proof?.artifactSha256 ?? "")) {
    fail("release_ledger_provenance_invalid");
  }
  const rows = await releaseLedgerRequest(env, fetchImpl, "GET", `?pr_number=eq.${number}&select=pr_number,head_sha,merge_sha,status,ticket_before_after_run_id,ticket_regression_artifact_sha256`, null);
  if (!Array.isArray(rows) || rows.length > 1) fail("release_ledger_rows_invalid");
  if (rows.length === 1) {
    const row = rows[0];
    if (row.pr_number !== number || row.head_sha !== sha ||
        row.merge_sha !== null || row.status !== "pending_merge") {
      fail("release_ledger_conflict");
    }
    if (row.ticket_before_after_run_id === null &&
        row.ticket_regression_artifact_sha256 === null) {
      const updated = await releaseLedgerRequest(env, fetchImpl, "PATCH",
        `?pr_number=eq.${number}&head_sha=eq.${sha}&status=eq.pending_merge&merge_sha=is.null&ticket_before_after_run_id=is.null&ticket_regression_artifact_sha256=is.null`,
        { ticket_before_after_run_id: proof.beforeAfterRunId,
          ticket_regression_artifact_sha256: proof.artifactSha256 });
      if (!Array.isArray(updated) || updated.length !== 1 ||
          updated[0].pr_number !== number || updated[0].head_sha !== sha ||
          updated[0].status !== "pending_merge" || updated[0].merge_sha !== null ||
          updated[0].ticket_before_after_run_id !== proof.beforeAfterRunId ||
          updated[0].ticket_regression_artifact_sha256 !== proof.artifactSha256) {
        fail("release_ledger_provenance_unconfirmed");
      }
      return;
    }
    if (row.ticket_before_after_run_id !== proof.beforeAfterRunId ||
        row.ticket_regression_artifact_sha256 !== proof.artifactSha256) {
      fail("release_ledger_conflict");
    }
    return;
  }
  const inserted = await releaseLedgerRequest(env, fetchImpl, "POST", "", {
    pr_number: number, head_sha: sha, status: "pending_merge",
    ticket_before_after_run_id: proof.beforeAfterRunId,
    ticket_regression_artifact_sha256: proof.artifactSha256,
  });
  if (!Array.isArray(inserted) || inserted.length !== 1 ||
      inserted[0].pr_number !== number || inserted[0].head_sha !== sha ||
      inserted[0].status !== "pending_merge" ||
      inserted[0].ticket_before_after_run_id !== proof.beforeAfterRunId ||
      inserted[0].ticket_regression_artifact_sha256 !== proof.artifactSha256) {
    fail("release_ledger_prepare_unconfirmed");
  }
}

export async function verifyTicketPromotionLink(pr, env, fetchImpl) {
  const branch=pr?.head?.ref??"";
  const id=branch.slice(-16);
  if (!/^[a-f0-9]{16}$/u.test(id??"")) fail("repair_pr_type_invalid");
  if (typeof env.SUPABASE_URL!=="string" || !/^https:\/\/[^/]+$/u.test(env.SUPABASE_URL) ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY!=="string" ||
      env.SUPABASE_SERVICE_ROLE_KEY.length<20) fail("ticket_pr_private_check_unavailable");
  const rowsResponse=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/yutakasa_ticket_repair_jobs?pr_number=eq.${pr.number}&select=work_id,head_sha,status&limit=2`,{
    headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,Accept:"application/json"},
    redirect:"error",signal:AbortSignal.timeout(15_000),
  }).catch(()=>fail("ticket_pr_private_check_unavailable"));
  if(rowsResponse.status!==200)fail("ticket_pr_private_check_unavailable");
  const rowsRaw=await rowsResponse.text();
  if(Buffer.byteLength(rowsRaw)>4096)fail("ticket_pr_private_check_invalid");
  let linkedRows;
  try{linkedRows=JSON.parse(rowsRaw);}catch{fail("ticket_pr_private_check_invalid");}
  if(!Array.isArray(linkedRows)||linkedRows.length>1||
      linkedRows.some((row)=>!UUID.test(row?.work_id??"") ||
        !SHA.test(row?.head_sha??"") || row.status!=="pr_open")) {
    fail("ticket_pr_private_check_invalid");
  }
  const ticketTitle=`Yutakasa support repair ${id}`;
  const anomalyTitle=`Yutakasa anomaly ${id}:`;
  if (ANOMALY_BRANCH.test(branch)) {
    if(linkedRows.length!==0)fail("ticket_pr_branch_mismatch");
    if (!pr.title?.startsWith(anomalyTitle) ||
        !pr.body?.startsWith("Production deployment:")) fail("repair_pr_type_invalid");
    return {ticketMode:false};
  }
  if (!TICKET_BRANCH.test(branch)) fail("repair_pr_type_invalid");
  if(linkedRows.length!==1||linkedRows[0].head_sha!==pr?.head?.sha) {
    fail("ticket_pr_private_check_invalid");
  }
  if (pr.title!==ticketTitle) fail("ticket_pr_public_metadata_invalid");
  if (typeof pr.body!=="string" ||
      !pr.body.startsWith(`Private support reference: ${id}\n`)) {
    fail("ticket_pr_public_metadata_invalid");
  }
  const response=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/verify_yutakasa_ticket_repair_pr`,{
    method:"POST",headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept:"application/json","content-type":"application/json"},
    body:JSON.stringify({p_pr_number:pr.number,p_head_sha:pr.head.sha}),
    redirect:"error",signal:AbortSignal.timeout(15_000),
  }).catch(()=>fail("ticket_pr_private_check_unavailable"));
  if(response.status!==200)fail("ticket_pr_private_check_unavailable");
  const raw=await response.text();
  if(Buffer.byteLength(raw)>4096)fail("ticket_pr_private_check_invalid");
  let rows;
  try{rows=JSON.parse(raw);}catch{fail("ticket_pr_private_check_invalid");}
  if(!Array.isArray(rows)||rows.length!==1||!UUID.test(rows[0]?.work_id??"")||
      rows[0].work_id!==linkedRows[0].work_id||
      crypto.createHash("sha256").update(rows[0].work_id).digest("hex").slice(0,16)!==id) {
    fail("ticket_pr_private_check_invalid");
  }
  return {ticketMode:true,workId:linkedRows[0].work_id};
}

async function verifyExactTicketCondition(workId, env, fetchImpl) {
  const key=env.SUPABASE_SERVICE_ROLE_KEY;
  const read=async(table,params)=>{
    const url=new URL(`/rest/v1/${table}`,env.SUPABASE_URL);
    for(const [name,value] of Object.entries(params))url.searchParams.set(name,value);
    const response=await fetchImpl(url,{headers:{apikey:key,Authorization:`Bearer ${key}`,
      Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(15_000)})
      .catch(()=>fail("ticket_pr_condition_unavailable"));
    if(response.status!==200)fail("ticket_pr_condition_unavailable");
    const raw=await response.text();
    if(Buffer.byteLength(raw)>16*1024)fail("ticket_pr_condition_invalid");
    let rows;
    try{rows=JSON.parse(raw);}catch{fail("ticket_pr_condition_invalid");}
    if(!Array.isArray(rows)||rows.length>2)fail("ticket_pr_condition_invalid");
    return rows;
  };
  const jobs=await read("yutakasa_ticket_repair_jobs",{work_id:`eq.${workId}`,
    select:"work_id,ticket_id,latest_user_message_id,status,pr_number,head_sha",limit:"2"});
  if(jobs.length!==1||!UUID.test(jobs[0]?.ticket_id??"")||
      !UUID.test(jobs[0]?.latest_user_message_id??"")||jobs[0].status!=="pr_open"){
    fail("ticket_pr_condition_changed");
  }
  const job=jobs[0];
  const [tickets,messages,admin,attachments]=await Promise.all([
    read("support_tickets",{id:`eq.${job.ticket_id}`,
      select:"id,user_email,subject,category,status,automation_status,decision_required",limit:"2"}),
    read("support_messages",{ticket_id:`eq.${job.ticket_id}`,sender_type:"eq.user",
      select:"id,body,created_at",order:"created_at.desc,id.desc",limit:"2"}),
    read("support_messages",{ticket_id:`eq.${job.ticket_id}`,sender_type:"eq.admin",
      select:"id,created_at",order:"created_at.desc,id.desc",limit:"1"}),
    read("support_attachments",{ticket_id:`eq.${job.ticket_id}`,select:"id",limit:"1"}),
  ]);
  const ticket=tickets[0],latest=messages[0];
  if(tickets.length!==1||messages.length!==1||admin.length!==0||
      attachments.length!==0||ticket?.id!==job.ticket_id||
      ticket?.subject!=="チャットの見出しが空白になる"||
      ticket?.category!=="technical"||ticket?.status!=="in_progress"||
      ticket?.automation_status!=="awaiting_repair"||ticket?.decision_required!==false||
      latest?.id!==job.latest_user_message_id||
      latest?.body!=="チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。"||
      !Number.isFinite(Date.parse(latest?.created_at??""))){
    fail("ticket_pr_condition_changed");
  }
  return {ticket,job};
}

async function requireNoCompetingRelease(env,fetchImpl,number){
  const rows=await releaseLedgerRequest(env,fetchImpl,"GET",
    "?status=in.(pending_merge,observing)&select=pr_number,status&limit=3",null);
  if(!Array.isArray(rows)||rows.length>3||rows.some((row)=>
    !Number.isSafeInteger(row?.pr_number)||
    !["pending_merge","observing"].includes(row?.status))){
    fail("repair_active_release_ledger_invalid");
  }
  return rows.some((row)=>row.pr_number!==number);
}

async function recordMergedRelease(env, fetchImpl, number, sha, mergeSha) {
  const rows = await releaseLedgerRequest(
    env, fetchImpl, "PATCH",
    `?pr_number=eq.${number}&head_sha=eq.${sha}&status=eq.pending_merge`,
    { merge_sha: mergeSha, status: "observing", merge_recorded_at: new Date().toISOString() },
  );
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].pr_number !== number ||
      rows[0].merge_sha !== mergeSha || rows[0].status !== "observing") {
    fail("release_ledger_merge_unconfirmed");
  }
}

export async function promoteAiRepair({
  env = process.env,
  fetchImpl = globalThis.fetch,
  proofImpl = findTicketRegressionProof,
  triggerImpl = readRegressionTriggerHead,
} = {}) {
  const configured=env.YUTAKASA_AUTO_MERGE_ENABLED==="true" ||
    UUID.test(env.YUTAKASA_AUTO_MERGE_REHEARSAL_WORK_ID??"") &&
    SHA.test(env.YUTAKASA_AUTO_MERGE_REHEARSAL_HEAD_SHA??"");
  if(!configured)fail("auto_merge_not_enabled");
  if (env.GITHUB_REPOSITORY !== REPO ||
      typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length < 20 ||
      !SHA.test(env.REPAIR_TRIGGER_SHA ?? "")) fail("promote_configuration_invalid");
  if(env.REPAIR_REGRESSION_RUN_ID &&
      !/^[1-9][0-9]{0,17}$/u.test(env.REPAIR_REGRESSION_RUN_ID)){
    fail("regression_proof_run_id_invalid");
  }
  const runId=env.REPAIR_REGRESSION_RUN_ID
    ? Number(env.REPAIR_REGRESSION_RUN_ID):null;
  const trigger=runId===null?null:await triggerImpl({runId,token:env.GH_TOKEN,fetchImpl});
  if (runId !== null && trigger === null) return {status:"unrelated_regression_run"};
  if(trigger&&trigger.baseSha!==env.REPAIR_TRIGGER_SHA)fail("regression_trigger_main_changed");
  const sha=trigger?.headSha??env.REPAIR_TRIGGER_SHA;
  const rehearsal=env.YUTAKASA_AUTO_MERGE_ENABLED!=="true"&&
    env.YUTAKASA_AUTO_MERGE_REHEARSAL_HEAD_SHA===sha;
  if(env.YUTAKASA_AUTO_MERGE_ENABLED!=="true"&&!rehearsal)fail("auto_merge_not_enabled");
  verifyMainProtection(await githubJson("/rules/branches/main", env.GH_TOKEN, fetchImpl));
  const linked = await githubJson(`/commits/${sha}/pulls`, env.GH_TOKEN, fetchImpl);
  if (!Array.isArray(linked) || linked.length !== 1 || !Number.isSafeInteger(linked[0]?.number)) {
    fail("repair_pr_link_invalid");
  }
  const number = linked[0].number;
  const pr = await githubJson(`/pulls/${number}`, env.GH_TOKEN, fetchImpl);
  const main = await githubJson("/commits/main", env.GH_TOKEN, fetchImpl);
  const files = await githubJson(`/pulls/${number}/files?per_page=100`, env.GH_TOKEN, fetchImpl);
  const vercelStatus = await githubJson(`/commits/${sha}/status`, env.GH_TOKEN, fetchImpl);
  const runsByWorkflow = {};
  for (const workflow of REQUIRED_WORKFLOWS) {
    const result = await githubJson(
      `/actions/workflows/${workflow}/runs?head_sha=${sha}&event=pull_request&per_page=100`,
      env.GH_TOKEN, fetchImpl,
    );
    if (!Array.isArray(result?.workflow_runs)) fail("repair_ci_evidence_invalid");
    runsByWorkflow[workflow] = result.workflow_runs;
  }
  try {
    checkCandidate({ pr, files, runsByWorkflow, vercelStatus,
      expectedSha: sha, mainSha: main?.sha });
  } catch (error) {
    if (error instanceof AiRepairPromoteError && error.code === "repair_ci_pending") {
      return { status: "pending_ci", prNumber: number, headSha: sha };
    }
    throw error;
  }
  if (!TICKET_BRANCH.test(pr.head.ref)) fail("repair_pr_type_not_enabled");
  const privateLink=await verifyTicketPromotionLink(pr,env,fetchImpl);
  if (!privateLink.ticketMode ||
      rehearsal && privateLink.workId!==env.YUTAKASA_AUTO_MERGE_REHEARSAL_WORK_ID) {
    fail("repair_pr_not_in_allowlist");
  }
  const exact=await verifyExactTicketCondition(privateLink.workId,env,fetchImpl);
  if(exact.job.pr_number!==number||exact.job.head_sha!==sha||
      rehearsal && !/^yutakasa-auto-smoke\+[^@]+@example\.invalid$/iu.test(exact.ticket.user_email??"")){
    fail("ticket_pr_condition_changed");
  }
  const proof=await proofImpl({workId:privateLink.workId,prNumber:number,headSha:sha,
    baseSha:main.sha,token:env.GH_TOKEN,fetchImpl,runId});
  if(!proof)return {status:"pending_evidence",prNumber:number,headSha:sha};
  if(proof.workId!==privateLink.workId||proof.prNumber!==number||
      proof.headSha!==sha||proof.baseSha!==main.sha||
      proof.scenarioKey!=="chat_title_zero_width")fail("regression_proof_untrusted");
  if(trigger && (trigger.workId!==privateLink.workId || trigger.prNumber!==number)){
    fail("regression_trigger_pr_mismatch");
  }
  if(await requireNoCompetingRelease(env,fetchImpl,number)){
    return {status:"pending_observation",prNumber:number,headSha:sha};
  }
  await prepareReleaseLedger(env, fetchImpl, number, sha, proof);
  if (pr.draft) await markReady(pr.node_id, env.GH_TOKEN, fetchImpl);
  // GitHub may compute mergeability asynchronously after leaving draft. A
  // different head or base appearing at this boundary must never be merged.
  let ready;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    ready = await githubJson(`/pulls/${number}`, env.GH_TOKEN, fetchImpl);
    if (ready?.mergeable_state !== "unknown") break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const currentMain = await githubJson("/commits/main", env.GH_TOKEN, fetchImpl);
  if (
    ready?.draft !== false || ready?.state !== "open" ||
    ready?.head?.sha !== sha || ready?.base?.ref !== "main" ||
    ready.base.sha !== main?.sha || currentMain?.sha !== main?.sha ||
    ready?.mergeable !== true || ready?.mergeable_state !== "clean"
  ) fail("repair_pr_ready_confirmation_invalid");
  const readyLink=await verifyTicketPromotionLink(ready, env, fetchImpl);
  if(readyLink.workId!==privateLink.workId ||
      (await verifyExactTicketCondition(privateLink.workId,env,fetchImpl)).job.head_sha!==sha ||
      await requireNoCompetingRelease(env,fetchImpl,number)){
    fail("repair_pr_ready_confirmation_invalid");
  }
  const merged = await githubJson(`/pulls/${number}/merge`, env.GH_TOKEN, fetchImpl, "PUT", {
    sha,
    merge_method: "squash",
    commit_title: `Verified AI repair for anomaly ${pr.head.ref.slice(-16)}`,
  });
  if (merged?.merged !== true || !SHA.test(merged?.sha ?? "")) fail("repair_merge_confirmation_invalid");
  await recordMergedRelease(env, fetchImpl, number, sha, merged.sha);
  return { prNumber: number, headSha: sha, mergeSha: merged.sha };
}

export { checkCandidate };

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  promoteAiRepair().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof AiRepairPromoteError ? error.code : "promote_failed" })}\n`);
      process.exitCode = 1;
    },
  );
}
