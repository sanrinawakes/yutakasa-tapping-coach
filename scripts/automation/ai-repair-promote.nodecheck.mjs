import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import { AiRepairPromoteError, checkCandidate, promoteAiRepair, verifyMainProtection,
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
    head:{...PR.head,ref:`codex/yutakasa-ticket-repair-${id}`}};
  const env={SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"s".repeat(40)};
  assert.deepEqual(checkCandidate({pr,files:FILES,
    runsByWorkflow:Object.fromEntries(Object.entries(RUNS).map(([name,runs])=>
      [name,runs.map((run)=>({...run,head_branch:pr.head.ref}))])),
    vercelStatus:VERCEL,expectedSha:SHA,mainSha:"b".repeat(40)}),
  {prNumber:42,headSha:SHA});
  const linked=async(url)=>new Response(JSON.stringify(String(url).includes("/rpc/")
    ? [{work_id:workId}]
    : [{work_id:workId,head_sha:SHA,status:"pr_open"}]),{status:200});
  assert.deepEqual(await verifyTicketPromotionLink(pr,env,linked),{ticketMode:true});
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
