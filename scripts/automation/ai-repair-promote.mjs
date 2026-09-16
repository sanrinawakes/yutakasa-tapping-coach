#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const BRANCH = /^codex\/yutakasa-ai-repair-[a-f0-9]{16}$/u;
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
const REQUIRED_CHECK_CONTEXTS = new Set(["source-repair-verify", "ai-repair-independent-review"]);

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

function checkCandidate({ pr, files, runsByWorkflow, expectedSha, mainSha }) {
  if (
    !SHA.test(expectedSha ?? "") || !SHA.test(mainSha ?? "") ||
    !Number.isSafeInteger(pr?.number) || pr.number < 1 ||
    pr?.state !== "open" || typeof pr?.draft !== "boolean" ||
    pr?.base?.ref !== "main" || pr.base.sha !== mainSha || pr?.head?.sha !== expectedSha ||
    pr?.head?.repo?.full_name !== REPO || !BRANCH.test(pr?.head?.ref ?? "") ||
    pr?.mergeable !== true || !["clean", "draft"].includes(pr?.mergeable_state) ||
    (pr.draft && pr.mergeable_state !== "draft") ||
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

async function prepareReleaseLedger(env, fetchImpl, number, sha) {
  const rows = await releaseLedgerRequest(env, fetchImpl, "GET", `?pr_number=eq.${number}&select=pr_number,head_sha,merge_sha,status`, null);
  if (!Array.isArray(rows) || rows.length > 1) fail("release_ledger_rows_invalid");
  if (rows.length === 1) {
    if (rows[0].pr_number !== number || rows[0].head_sha !== sha ||
        rows[0].merge_sha !== null || rows[0].status !== "pending_merge") {
      fail("release_ledger_conflict");
    }
    return;
  }
  const inserted = await releaseLedgerRequest(env, fetchImpl, "POST", "", {
    pr_number: number, head_sha: sha, status: "pending_merge",
  });
  if (!Array.isArray(inserted) || inserted.length !== 1 ||
      inserted[0].pr_number !== number || inserted[0].head_sha !== sha ||
      inserted[0].status !== "pending_merge") fail("release_ledger_prepare_unconfirmed");
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
} = {}) {
  if (env.YUTAKASA_AUTO_MERGE_ENABLED !== "true") fail("auto_merge_not_enabled");
  if (env.GITHUB_REPOSITORY !== REPO ||
      typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length < 20 ||
      !SHA.test(env.REPAIR_TRIGGER_SHA ?? "")) fail("promote_configuration_invalid");
  const sha = env.REPAIR_TRIGGER_SHA;
  verifyMainProtection(await githubJson("/rules/branches/main", env.GH_TOKEN, fetchImpl));
  const linked = await githubJson(`/commits/${sha}/pulls`, env.GH_TOKEN, fetchImpl);
  if (!Array.isArray(linked) || linked.length !== 1 || !Number.isSafeInteger(linked[0]?.number)) {
    fail("repair_pr_link_invalid");
  }
  const number = linked[0].number;
  const pr = await githubJson(`/pulls/${number}`, env.GH_TOKEN, fetchImpl);
  const main = await githubJson("/commits/main", env.GH_TOKEN, fetchImpl);
  const files = await githubJson(`/pulls/${number}/files?per_page=100`, env.GH_TOKEN, fetchImpl);
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
    checkCandidate({ pr, files, runsByWorkflow, expectedSha: sha, mainSha: main?.sha });
  } catch (error) {
    if (error instanceof AiRepairPromoteError && error.code === "repair_ci_pending") {
      return { status: "pending_ci", prNumber: number, headSha: sha };
    }
    throw error;
  }
  await prepareReleaseLedger(env, fetchImpl, number, sha);
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
