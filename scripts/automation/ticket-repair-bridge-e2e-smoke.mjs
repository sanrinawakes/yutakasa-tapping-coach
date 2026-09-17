#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { BRIDGE_SUPPORT_BODY, TEST_SUPPORT_ACK, TEST_SUPPORT_SUBJECT } from
  "./ai-repair-functional-smoke.mjs";
import { cleanupTicketRepairSmoke, runTicketRepairHandoffSmoke } from
  "./ticket-repair-handoff-smoke.mjs";
import { runTicketRepairInvestigation } from "./ticket-repair-investigate.mjs";
import { parseProposal, runAiRepairPublish, validatePatch } from "./ai-repair-publish.mjs";
import { verifyMainProtection } from "./ai-repair-promote.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const RPC = "cleanup_yutakasa_ticket_bridge_e2e_smoke";
const SOURCE = "src/lib/chat-thread.ts";
const TEST = "src/lib/chat-thread.test.ts";
const SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUN_ID = /^[1-9][0-9]{0,17}$/u;
const CI = ["source-repair-ci.yml", "ai-repair-independent-review.yml"];

export class BridgeE2eSmokeError extends Error {
  constructor(code) { super(code); this.name = "BridgeE2eSmokeError"; this.code = code; }
}
function fail(code) { throw new BridgeE2eSmokeError(code); }
function command(binary, args, options = {}) {
  try { return execFileSync(binary, args, { encoding: "utf8", maxBuffer: 512 * 1024,
    timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], ...options }).trim(); }
  catch { fail("bridge_command_failed"); }
}
function branchFor(workId) {
  if (!UUID.test(workId ?? "")) fail("bridge_work_id_invalid");
  const id = crypto.createHash("sha256").update(workId).digest("hex").slice(0, 16);
  return { id, branch: `codex/yutakasa-support-ai-${id}`,
    title: `Yutakasa support repair ${id}`,
    body: `Private support reference: ${id}\nCustomer content and identifiers are stored only in the private support database.\nThis draft is unverified. Do not send a customer reply until the exact release passes production observation.` };
}
function statePath(env) {
  if (!RUN_ID.test(env.GITHUB_RUN_ID ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))) fail("bridge_run_id_invalid");
  return path.join(os.tmpdir(), `yutakasa-ticket-bridge-e2e-${env.GITHUB_RUN_ID}.json`);
}
function readState(file, env) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; fail("bridge_state_unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 || stat.size > 512 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    fail("bridge_state_unsafe");
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail("bridge_state_invalid"); }
  if (Object.keys(state ?? {}).sort().join(",") !== "ghRunId,lockToken,runId,version,workId" ||
      state.version !== 1 || state.ghRunId !== Number(env.GITHUB_RUN_ID) ||
      !UUID.test(state.runId ?? "") || !UUID.test(state.workId ?? "") ||
      !UUID.test(state.lockToken ?? "")) fail("bridge_state_invalid");
  return state;
}
function attemptedFile(env) { return `${statePath(env)}.publish`; }
function readPublishState(env, workId) {
  const file = attemptedFile(env);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; fail("bridge_publish_state_unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 || stat.size > 256) fail("bridge_publish_state_unsafe");
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail("bridge_publish_state_invalid"); }
  if (Object.keys(saved ?? {}).sort().join(",") !== "branch,headSha,prNumber,workId" ||
      saved.workId !== workId || saved.branch !== branchFor(workId).branch ||
      (saved.prNumber === null) !== (saved.headSha === null) ||
      (saved.prNumber !== null && (!Number.isSafeInteger(saved.prNumber) ||
        saved.prNumber < 1 || !SHA.test(saved.headSha ?? "")))) {
    fail("bridge_publish_state_invalid");
  }
  return saved;
}
function markPublisherAttempt(env, workId) {
  fs.writeFileSync(attemptedFile(env),
    `${JSON.stringify({ branch: branchFor(workId).branch, workId,
      prNumber: null, headSha: null })}\n`,
    { mode: 0o600, flag: "wx" });
}
function markPrObserved(env, workId, pr) {
  const prior = readPublishState(env, workId);
  if (!prior || (prior.prNumber !== null &&
      (prior.prNumber !== pr.number || prior.headSha !== pr.head.sha))) {
    fail("bridge_publish_state_changed");
  }
  fs.writeFileSync(attemptedFile(env), `${JSON.stringify({ ...prior,
    prNumber: pr.number, headSha: pr.head.sha })}\n`, { mode: 0o600 });
}
export function checkGate(env, headSha, branch, clean) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" ||
      env.YUTAKASA_BRIDGE_E2E_SMOKE_ENABLED !== "true" ||
      env.TICKET_REPAIR_ENABLED !== "false" || env.AUTO_MERGE_ENABLED !== "false" ||
      !RUN_ID.test(env.GITHUB_RUN_ID ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) ||
      !RUN_ID.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      !SHA.test(headSha ?? "") || env.GITHUB_SHA !== headSha || branch !== "main" || !clean ||
      typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length < 20 ||
      typeof env.GH_READ_TOKEN !== "string" || env.GH_READ_TOKEN.length < 20) {
    fail("bridge_gate_closed");
  }
}
function checkKnownDefect() {
  const program = [
    `import { createChatTitle, DEFAULT_CHAT_TITLE } from './${SOURCE}';`,
    "const actual = createChatTitle('\\u200B');",
    "if (actual === DEFAULT_CHAT_TITLE || actual !== '\\u200B') process.exit(1);",
  ].join("\n");
  command(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program],
    { env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), NODE_ENV: "test" } });
}
async function api(env, fetchImpl, route, options = {}) {
  const method = options.method ?? "GET";
  const token = method === "GET" ? env.GH_READ_TOKEN : env.GH_TOKEN;
  if (typeof token !== "string" || token.length < 20) fail("bridge_github_credential_missing");
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}${route}`, {
    method, headers: { Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "content-type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("bridge_github_request_failed"));
  if (options.allow404 && response.status === 404) return null;
  if (response.status !== (options.expected ?? 200)) fail(`bridge_github_http_${response.status}`);
  if (options.expected === 204) return true;
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 512 * 1024) fail("bridge_github_response_large");
  try { return JSON.parse(raw); } catch { fail("bridge_github_response_invalid"); }
}
async function databaseRows(env, fetchImpl, table, query) {
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { method: "GET",
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("bridge_database_request_failed"));
  if (response.status !== 200) fail("bridge_database_http_failure");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 64 * 1024) fail("bridge_database_response_large");
  let rows;
  try { rows = JSON.parse(raw); } catch { fail("bridge_database_response_invalid"); }
  if (!Array.isArray(rows) || rows.length > 2) fail("bridge_database_rows_invalid");
  return rows;
}
function validatePr(pr, identity, headSha = null) {
  if (!Number.isSafeInteger(pr?.number) || pr.number < 1 ||
      pr.title !== identity.title || pr.body !== identity.body || pr.draft !== true ||
      pr.base?.ref !== "main" || pr.head?.ref !== identity.branch ||
      pr.head?.repo?.full_name !== REPO || !SHA.test(pr.head?.sha ?? "") ||
      (headSha && pr.head.sha !== headSha) || pr.merged_at !== null) {
    fail("bridge_pr_identity_changed");
  }
  return pr;
}
async function findPr(env, fetchImpl, identity) {
  const query = new URLSearchParams({ state: "all", head: `sanrinawakes:${identity.branch}`,
    per_page: "10" });
  const rows = await api(env, fetchImpl, `/pulls?${query}`);
  if (!Array.isArray(rows) || rows.length > 10) fail("bridge_pr_lookup_invalid");
  if (rows.length > 1) fail("bridge_pr_ambiguous");
  return rows.length ? validatePr(rows[0], identity) : null;
}
async function findPrBounded(env, fetchImpl, identity, sleep) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pr = await findPr(env, fetchImpl, identity);
    if (pr) return pr;
    if (attempt < 3) await sleep(5_000);
  }
  return null;
}
function validateClaimedContext(context, identity) {
  if (context?.work_id !== identity.workId || context?.ticket_id !== identity.ticketId ||
      context?.latest_user_message_id !== identity.latestUserMessageId ||
      context?.category !== "technical" || context?.subject !== TEST_SUPPORT_SUBJECT ||
      !Array.isArray(context.messages) || context.messages.length !== 2 ||
      context.messages.filter((message) => message?.sender_type === "user" &&
        message.id === identity.latestUserMessageId && message.body === BRIDGE_SUPPORT_BODY).length !== 1 ||
      context.messages.filter((message) => message?.sender_type === "system" &&
        message.body === TEST_SUPPORT_ACK).length !== 1) fail("bridge_claimed_context_changed");
}
export function inspectChecks({ runs, status, branch, sha }) {
  if (!SHA.test(sha ?? "") || !/^codex\/yutakasa-support-ai-[a-f0-9]{16}$/u.test(branch ?? "") ||
      !Array.isArray(runs) || runs.length !== CI.length) fail("bridge_check_evidence_invalid");
  let pending = false;
  for (let index = 0; index < CI.length; index += 1) {
    const list = runs[index]?.workflow_runs;
    if (!Array.isArray(list) || list.length > 100) fail("bridge_check_evidence_invalid");
    const matching = list.filter((run) => run.head_sha === sha &&
      run.head_branch === branch && run.event === "pull_request" &&
      run.path === `.github/workflows/${CI[index]}`)
      .sort((a, b) => b.id - a.id);
    if (!matching.length || matching[0].status !== "completed") pending = true;
    else if (matching[0].conclusion !== "success") fail("bridge_ci_failed");
  }
  const vercel = status?.statuses?.find((item) => item.context === "Vercel");
  if (status?.sha !== sha || !Array.isArray(status?.statuses)) fail("bridge_vercel_evidence_invalid");
  if (!vercel || vercel.state === "pending") pending = true;
  else if (vercel.state !== "success" ||
      vercel.description !== "Deployment has completed" ||
      typeof vercel.target_url !== "string" ||
      !vercel.target_url.startsWith("https://vercel.com/sanrinawakes-projects/yutakasa-tapping-coach/")) {
    fail("bridge_vercel_preview_failed");
  }
  return pending ? { status: "pending" } : { status: "passed" };
}
async function waitForChecks(env, fetchImpl, identity, sha, sleep, now) {
  const deadline = now() + 10 * 60 * 1000;
  while (now() < deadline) {
    const runs = [];
    for (const workflow of CI) {
      const query = new URLSearchParams({ head_sha: sha, event: "pull_request", per_page: "100" });
      runs.push(await api(env, fetchImpl, `/actions/workflows/${workflow}/runs?${query}`));
    }
    const status = await api(env, fetchImpl, `/commits/${sha}/status`);
    const result = inspectChecks({ runs, status, branch: identity.branch, sha });
    if (result.status === "passed") return;
    await sleep(15_000);
  }
  fail("bridge_ci_timeout");
}
function deleteUnchangedBranch(env, identity, sha) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yutakasa-bridge-delete-"));
  fs.chmodSync(temp, 0o700);
  try {
    const askpass = path.join(temp, "askpass.sh");
    fs.writeFileSync(askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf %s x-access-token ;; *Password*) printf %s "$GH_TOKEN" ;; *) exit 1 ;; esac\n',
      { mode: 0o700, flag: "wx" });
    command("git", ["-c", "core.hooksPath=/dev/null", "push",
      `--force-with-lease=refs/heads/${identity.branch}:${sha}`,
      `https://github.com/${REPO}.git`, `:refs/heads/${identity.branch}`],
    { env: { PATH: process.env.PATH ?? "", GH_TOKEN: env.GH_TOKEN,
      GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" } });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
export async function cleanupRemote({ env, fetchImpl = globalThis.fetch, workId,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deleteRef = deleteUnchangedBranch } = {}) {
  const identity = branchFor(workId);
  const saved = readPublishState(env, workId);
  const jobs = await databaseRows(env, fetchImpl, "yutakasa_ticket_repair_jobs", {
    work_id: `eq.${workId}`, select: "work_id,status,claimed_run_id,pr_number,head_sha", limit: "2",
  });
  if (jobs.length > 1 || (jobs.length === 1 &&
      (jobs[0].work_id !== workId || !["queued", "investigating", "pr_open"].includes(jobs[0].status) ||
       (jobs[0].status !== "queued" && jobs[0].claimed_run_id !== Number(env.GITHUB_RUN_ID))))) {
    fail("bridge_job_identity_changed");
  }
  const job = jobs[0] ?? null;
  if (saved && job?.status === "queued") fail("bridge_job_identity_changed");
  const pr = saved?.prNumber ? validatePr(await api(env, fetchImpl,
    `/pulls/${saved.prNumber}`), identity, saved.headSha) : saved ?
    await findPrBounded(env, fetchImpl, identity, sleep) : await findPr(env, fetchImpl, identity);
  const ref = await api(env, fetchImpl, `/git/ref/heads/${identity.branch}`, { allow404: true });
  if (job?.status === "pr_open" &&
      (!pr || job.pr_number !== pr.number || job.head_sha !== pr.head.sha)) {
    fail("bridge_private_link_changed");
  }
  if (job && job.status !== "pr_open" &&
      (job.pr_number !== null || job.head_sha !== null)) fail("bridge_job_identity_changed");
  if (!pr && !ref) {
    if (saved || job?.status === "pr_open") fail("bridge_publication_uncertain");
    return { prClosed: false, branchDeleted: false };
  }
  if (pr && !ref && saved?.prNumber === pr.number &&
      saved.headSha === pr.head.sha && pr.state === "closed") {
    return { prClosed: true, branchDeleted: true,
      prNumber: pr.number, headSha: pr.head.sha };
  }
  if (!pr || !ref || !saved || ref.ref !== `refs/heads/${identity.branch}` ||
      ref.object?.sha !== pr.head.sha) {
    fail("bridge_remote_identity_uncertain");
  }
  if (saved.prNumber === null) markPrObserved(env, workId, pr);
  if (pr.state === "open") {
    if (pr.draft !== true) fail("bridge_pr_not_draft");
    const closed = await api(env, fetchImpl, `/pulls/${pr.number}`, {
      method: "PATCH", body: { state: "closed" },
    });
    if (closed?.number !== pr.number || closed?.state !== "closed" ||
        closed?.merged_at !== null) fail("bridge_pr_close_unconfirmed");
  } else if (pr.state !== "closed") fail("bridge_pr_state_invalid");
  const direct = validatePr(await api(env, fetchImpl, `/pulls/${pr.number}`), identity, pr.head.sha);
  if (direct.state !== "closed") fail("bridge_pr_close_unconfirmed");
  await deleteRef(env, identity, pr.head.sha);
  const remaining = await api(env, fetchImpl, `/git/ref/heads/${identity.branch}`, { allow404: true });
  const finalPr = validatePr(await api(env, fetchImpl, `/pulls/${pr.number}`), identity, pr.head.sha);
  if (remaining !== null || finalPr.state !== "closed") fail("bridge_remote_cleanup_unconfirmed");
  return { prClosed: true, branchDeleted: true, prNumber: pr.number, headSha: pr.head.sha };
}
export async function runBridgeE2eSmoke({ env = process.env, fetchImpl = globalThis.fetch,
  handoff = runTicketRepairHandoffSmoke,
  investigator = runTicketRepairInvestigation,
  publisher = runAiRepairPublish,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now,
  remoteCleanup = cleanupRemote } = {}) {
  const mainSha = command("git", ["rev-parse", "HEAD"]);
  checkGate(env, mainSha, command("git", ["branch", "--show-current"]),
    command("git", ["status", "--porcelain"]) === "");
  checkKnownDefect();
  verifyMainProtection(await api(env, fetchImpl, "/rules/branches/main"));
  let proof = null;
  const result = await handoff({ env, fetchImpl, cleanupRpcName: RPC,
    supportBody: BRIDGE_SUPPORT_BODY, statePath: statePath(env),
    afterQueued: async (identity) => {
      const expected = branchFor(identity.workId);
      if (await api(env, fetchImpl, `/git/ref/heads/${expected.branch}`, { allow404: true }) ||
          await findPr(env, fetchImpl, expected)) fail("bridge_remote_preexisting");
      const investigatorFetch = async (url, init) => {
        const response = await fetchImpl(url, init);
        if (String(url) === `${env.SUPABASE_URL}/rest/v1/rpc/claim_yutakasa_ticket_repair_context` &&
            response.status === 200) {
          const raw = await response.clone().text().catch(() =>
            fail("bridge_claimed_context_invalid"));
          if (Buffer.byteLength(raw) > 512 * 1024) fail("bridge_claimed_context_invalid");
          let context;
          try { context = JSON.parse(raw); } catch { fail("bridge_claimed_context_invalid"); }
          validateClaimedContext(context, identity);
        }
        return response;
      };
      const investigation = await investigator({ env: { ...env, WORK_ID: identity.workId,
        TICKET_REPAIR_ENABLED: "true" }, fetchImpl: investigatorFetch,
      publisher: (publisherEnv) => {
        const proposal = parseProposal(publisherEnv.AI_REPAIR_PROPOSAL);
        if (!proposal.patch.trim()) fail("bridge_terra_patch_missing");
        const files = validatePatch(proposal.patch).sort();
        if (JSON.stringify(files) !== JSON.stringify([SOURCE, TEST].sort())) {
          fail("bridge_terra_patch_scope_invalid");
        }
        markPublisherAttempt(env, identity.workId);
        return publisher(publisherEnv);
      } });
      if (investigation?.status !== "draft_pr_linked") fail("bridge_pr_link_unconfirmed");
      const branch = branchFor(identity.workId);
      const pr = await findPrBounded(env, fetchImpl, branch, sleep);
      if (!pr || pr.state !== "open" || pr.draft !== true ||
          pr.base?.sha !== mainSha) fail("bridge_draft_pr_unconfirmed");
      markPrObserved(env, identity.workId, pr);
      const job = await databaseRows(env, fetchImpl, "yutakasa_ticket_repair_jobs", {
        work_id: `eq.${identity.workId}`, select: "work_id,ticket_id,latest_user_message_id,status,claimed_run_id,pr_number,head_sha", limit: "2",
      });
      const links = await databaseRows(env, fetchImpl, "yutakasa_repair_ticket_links", {
        pr_number: `eq.${pr.number}`, select: "pr_number,ticket_id,latest_user_message_id", limit: "2",
      });
      const releases = await databaseRows(env, fetchImpl, "yutakasa_repair_releases", {
        pr_number: `eq.${pr.number}`, select: "pr_number,head_sha,status,merge_sha", limit: "2",
      });
      if (job.length !== 1 || job[0].status !== "pr_open" ||
          job[0].ticket_id !== identity.ticketId ||
          job[0].latest_user_message_id !== identity.latestUserMessageId ||
          job[0].claimed_run_id !== Number(env.GITHUB_RUN_ID) ||
          job[0].pr_number !== pr.number || job[0].head_sha !== pr.head.sha ||
          links.length !== 1 || links[0].ticket_id !== identity.ticketId ||
          links[0].latest_user_message_id !== identity.latestUserMessageId ||
          releases.length !== 1 || releases[0].head_sha !== pr.head.sha ||
          releases[0].status !== "pending_merge" || releases[0].merge_sha !== null) {
        fail("bridge_private_link_changed");
      }
      await waitForChecks(env, fetchImpl, branch, pr.head.sha, sleep, now);
      proof = { prNumber: pr.number, headSha: pr.head.sha, ciPassed: true,
        vercelPreview: true, linked: true };
    },
    beforeDatabaseCleanup: async ({ workId }) => {
      await remoteCleanup({ env, fetchImpl, workId, sleep });
    },
  });
  if (!proof || result?.syntheticDataCleaned !== true) fail("bridge_proof_incomplete");
  fs.rmSync(attemptedFile(env), { force: true });
  return { ok: true, mainSha, ...proof, syntheticDataCleaned: true,
    prClosed: true, branchDeleted: true, productionMerged: false, customerSent: false };
}
export async function rescueBridgeE2eSmoke({ env = process.env, fetchImpl = globalThis.fetch,
  remoteCleanup = cleanupRemote, cleanup = cleanupTicketRepairSmoke,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REPOSITORY !== REPO ||
      env.GITHUB_REF !== "refs/heads/main" ||
      typeof env.SUPABASE_URL !== "string" ||
      !/^https:\/\/[a-z0-9-]+\.supabase\.co$/u.test(env.SUPABASE_URL) ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
      env.SUPABASE_SERVICE_ROLE_KEY.length < 20) fail("bridge_rescue_gate_closed");
  const file = statePath(env);
  const saved = readState(file, env);
  if (!saved) return { ok: true, rescued: false };
  await remoteCleanup({ env, fetchImpl, workId: saved.workId, sleep });
  const email = `yutakasa-auto-smoke+${saved.runId}@example.invalid`;
  await cleanup(env, fetchImpl, email, saved.runId, null, saved.workId, saved.lockToken,
    { rpcName: RPC, ghRunId: saved.ghRunId, postInvestigation: true });
  fs.unlinkSync(file);
  fs.rmSync(attemptedFile(env), { force: true });
  return { ok: true, rescued: true };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const task = process.argv[2] === "rescue" ? rescueBridgeE2eSmoke() :
    process.argv.length === 2 ? runBridgeE2eSmoke() :
      Promise.reject(new BridgeE2eSmokeError("bridge_usage_invalid"));
  task.then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const code = typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code)
        ? error.code : "bridge_smoke_failed";
      process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    },
  );
}
