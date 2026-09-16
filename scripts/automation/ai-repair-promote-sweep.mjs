#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import path from "node:path";
import { AiRepairPromoteError, promoteAiRepair } from "./ai-repair-promote.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const BRANCH = /^codex\/yutakasa-(?:ai|ticket)-repair-[a-f0-9]{16}$/u;

export class PromoteSweepError extends Error {
  constructor(code) { super(code); this.name="PromoteSweepError"; this.code=code; }
}
function fail(code) { throw new PromoteSweepError(code); }

export async function retryPendingPromotions({
  env=process.env,fetchImpl=globalThis.fetch,promoteImpl=promoteAiRepair,
  now=Date.now,
}={}) {
  if (env.GITHUB_EVENT_NAME!=="schedule" || env.YUTAKASA_AUTO_MERGE_ENABLED!=="true" ||
      env.GITHUB_REPOSITORY!==REPO || typeof env.GH_TOKEN!=="string" ||
      env.GH_TOKEN.length<20) fail("promote_sweep_configuration_invalid");
  const response=await fetchImpl(`https://api.github.com/repos/${REPO}/pulls?state=open&per_page=100`,{
    headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${env.GH_TOKEN}`},
    redirect:"error",signal:AbortSignal.timeout(15_000),
  }).catch(()=>fail("promote_sweep_github_failed"));
  if (response.status!==200) fail("promote_sweep_github_failed");
  const raw=await response.text();
  if (Buffer.byteLength(raw)>1024*1024) fail("promote_sweep_response_large");
  let rows;
  try {rows=JSON.parse(raw);} catch {fail("promote_sweep_response_invalid");}
  if (!Array.isArray(rows) || rows.length>100) fail("promote_sweep_response_invalid");
  const candidates=rows.filter((pr)=>BRANCH.test(pr?.head?.ref??"") &&
    pr?.head?.repo?.full_name===REPO && SHA.test(pr?.head?.sha??"") &&
    pr?.base?.ref==="main" && Number.isFinite(Date.parse(pr?.created_at??"")) &&
    now()-Date.parse(pr.created_at)>=0 &&
    now()-Date.parse(pr.created_at)<=24*60*60*1000)
    .sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))
    .slice(0,5);
  let pending=0;
  let rejected=0;
  for (const pr of candidates) {
    try {
      const result=await promoteImpl({env:{...env,REPAIR_TRIGGER_SHA:pr.head.sha},fetchImpl});
      if (result?.mergeSha) return {examined:pending+rejected+1,merged:1,pending,rejected};
      if (result?.status==="pending_ci") {pending+=1;continue;}
      fail("promote_sweep_result_invalid");
    } catch (error) {
      if (error instanceof AiRepairPromoteError &&
          ["repair_pr_not_safe_to_merge","repair_pr_files_invalid",
            "repair_pr_regression_test_missing"].includes(error.code)) {
        rejected+=1;continue;
      }
      throw error;
    }
  }
  return {examined:candidates.length,merged:0,pending,rejected};
}

const isMain=process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(isMain){retryPendingPromotions().then(
  (result)=>process.stdout.write(`${JSON.stringify({ok:true,...result})}\n`),
  (error)=>{process.stdout.write(`${JSON.stringify({ok:false,
    code:error instanceof PromoteSweepError||error instanceof AiRepairPromoteError
      ?error.code:"promote_sweep_failed"})}\n`);process.exitCode=1;},
);}
