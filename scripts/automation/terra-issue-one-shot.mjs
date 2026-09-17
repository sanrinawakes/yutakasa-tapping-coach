#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { probeTerra } from "./openai-terra-probe.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,17}$/u;
const ISSUE_PREFIX = "Yutakasa synthetic Terra issue probe ";
const ISSUE_BODY = [
  "One-shot synthetic integration check. No customer ticket or production database row was read.",
  "A capped Terra request containing only the fixed text OK completed before this issue was created.",
  "This issue is closed by the same workflow and must never enter a repair or release queue.",
].join("\n");

export class TerraIssueSmokeError extends Error {
  constructor(code) { super(code); this.name = "TerraIssueSmokeError"; this.code = code; }
}
function fail(code) { throw new TerraIssueSmokeError(code); }

function validateEnvironment(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      !SHA.test(env.GITHUB_SHA ?? "") || !RUN_ID.test(env.GITHUB_RUN_ID ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) ||
      !RUN_ID.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)) ||
      env.TICKET_REPAIR_ENABLED !== "false" || env.AUTO_MERGE_ENABLED !== "false" ||
      typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length < 20 ||
      /[\r\n]/u.test(env.GH_TOKEN)) fail("terra_issue_configuration_invalid");
}

function githubHeaders(env) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GH_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "yutakasa-terra-issue-one-shot/1",
  };
}

async function getJson(env, fetchImpl, url, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET", headers: githubHeaders(env), redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch { fail(`${code}_request_failed`); }
  if (response.status !== 200) fail(`${code}_http_failure`);
  const raw = await response.text().catch(() => fail(`${code}_body_failed`));
  if (Buffer.byteLength(raw) > 256 * 1024) fail(`${code}_response_large`);
  try { return JSON.parse(raw); } catch { fail(`${code}_response_invalid`); }
}

async function currentMainSha(env, fetchImpl) {
  const commit = await getJson(env, fetchImpl,
    `https://api.github.com/repos/${REPO}/commits/main`, "terra_issue_main");
  if (!SHA.test(commit?.sha ?? "")) fail("terra_issue_main_invalid");
  return commit.sha;
}

function exactIssue(issue, title) {
  return issue && Number.isSafeInteger(issue.number) && issue.number > 0 &&
    issue.title === title && issue.body === ISSUE_BODY &&
    ["open", "closed"].includes(issue.state) &&
    (issue.pull_request === null || issue.pull_request === undefined);
}

async function findIssue(env, fetchImpl, title, marker) {
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", `repo:${REPO} is:issue in:title ${marker}`);
  url.searchParams.set("per_page", "100");
  const result = await getJson(env, fetchImpl, url, "terra_issue_lookup");
  if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0 ||
      result.total_count > 100 || !Array.isArray(result.items) ||
      result.incomplete_results !== false ||
      result.items.length !== result.total_count) fail("terra_issue_lookup_invalid");
  if (result.items.length > 1 || result.items.some((item) => !exactIssue(item, title))) {
    fail("terra_issue_existing_mismatch");
  }
  return result.items[0] ?? null;
}

async function postIssue(env, fetchImpl, url, body, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST", headers: { ...githubHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { fail(`${code}_outcome_uncertain`); }
  if (response.status !== 201) fail(`${code}_http_failure`);
  const raw = await response.text().catch(() => fail(`${code}_body_failed`));
  if (Buffer.byteLength(raw) > 64 * 1024) fail(`${code}_response_large`);
  try { return JSON.parse(raw); } catch { fail(`${code}_response_invalid`); }
}

async function closeExactIssue(env, fetchImpl, issue, title) {
  if (!exactIssue(issue, title)) fail("terra_issue_existing_mismatch");
  const url = `https://api.github.com/repos/${REPO}/issues/${issue.number}`;
  const current = await getJson(env, fetchImpl, url, "terra_issue_current");
  if (!exactIssue(current, title) || current.number !== issue.number) {
    fail("terra_issue_existing_mismatch");
  }
  if (current.state === "closed") return issue.number;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "PATCH", headers: { ...githubHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { fail("terra_issue_close_outcome_uncertain"); }
  if (response.status !== 200) fail("terra_issue_close_http_failure");
  const confirmed = await getJson(env, fetchImpl, url, "terra_issue_readback");
  if (!exactIssue(confirmed, title) || confirmed.number !== issue.number ||
      confirmed.state !== "closed") fail("terra_issue_close_unconfirmed");
  return issue.number;
}

export async function runTerraIssueOneShot({
  env = process.env, fetchImpl = globalThis.fetch, terraImpl = probeTerra,
} = {}) {
  validateEnvironment(env);
  const marker = createHash("sha256").update(`${REPO}:${env.GITHUB_RUN_ID}`)
    .digest("hex").slice(0, 16);
  const title = `${ISSUE_PREFIX}${marker}`;
  if (await currentMainSha(env, fetchImpl) !== env.GITHUB_SHA) {
    fail("terra_issue_main_changed");
  }
  const existing = await findIssue(env, fetchImpl, title, marker);
  if (existing) {
    const issueNumber = await closeExactIssue(env, fetchImpl, existing, title);
    return { ok: true, issueNumber, issueClosed: true, terraCalled: false, recovered: true };
  }
  // GitHub Search can lag a successful but unacknowledged POST. A rerun may
  // recover an indexed issue, but must never create another one for this run.
  if (env.GITHUB_RUN_ATTEMPT !== "1") {
    fail("terra_issue_retry_requires_manual_reconciliation");
  }

  const terra = await terraImpl({ env, fetchImpl }).catch(() => fail("terra_issue_terra_failed"));
  if (terra?.ok !== true || terra.project_attestation_match !== true ||
      terra.key_fingerprint_match !== true ||
      !/^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/u.test(terra.response_model ?? "")) {
    fail("terra_issue_terra_unconfirmed");
  }
  if (await currentMainSha(env, fetchImpl) !== env.GITHUB_SHA) {
    fail("terra_issue_main_changed");
  }
  // The model output never enters the issue. An uncertain creation is never
  // blindly retried; a rerun searches the exact marker before another call.
  const created = await postIssue(env, fetchImpl,
    `https://api.github.com/repos/${REPO}/issues`,
    { title, body: ISSUE_BODY }, "terra_issue_create");
  if (!exactIssue(created, title) || created.state !== "open") {
    fail("terra_issue_create_unconfirmed");
  }
  const issueNumber = await closeExactIssue(env, fetchImpl, created, title);
  return { ok: true, issueNumber, issueClosed: true, terraCalled: true, recovered: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runTerraIssueOneShot().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const code = error instanceof TerraIssueSmokeError ? error.code : "terra_issue_failed";
      process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    },
  );
}
