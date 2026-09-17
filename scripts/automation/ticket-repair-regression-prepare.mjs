#!/usr/bin/env node

// The privileged half of automatic ticket regression evidence. This process
// reads the private ticket on trusted main; the following test job receives
// only an opaque work ID, PR number, and fixed scenario, with no secrets.
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const BRANCH = /^codex\/yutakasa-support-ai-[a-f0-9]{16}$/u;
const SUBJECT = "チャットの見出しが空白になる";
const BODY = "チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。";
const OWNER_TERMS = /(返金|払い戻し|解約|契約|請求|決済|課金|料金|支払|領収|法律|訴訟|補償|個人情報|削除|refund|billing|payment|cancel|contract|legal)/iu;

export class RegressionPrepareError extends Error {
  constructor(code) { super(code); this.name = "RegressionPrepareError"; this.code = code; }
}
function fail(code) { throw new RegressionPrepareError(code); }

async function json(fetchImpl, url, headers, code, maxBytes = 64 * 1024) {
  const response = await fetchImpl(url, {
    headers, redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail(code));
  if (response.status !== 200) fail(code);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) fail(code);
  try { return JSON.parse(raw); } catch { fail(code); }
}

function exactOne(rows, code) {
  if (!Array.isArray(rows) || rows.length !== 1) fail(code);
  return rows[0];
}

export function selectEligibleTicketRepair({ sourceRun, main, linked, pr, jobs, ticket,
  messages, attachments, links, adminMessages, headSha, sourceRunId, rehearsalWorkId = null }) {
  if (sourceRun?.id !== sourceRunId || sourceRun?.head_sha !== headSha ||
      sourceRun?.status !== "completed" || sourceRun?.conclusion !== "success" ||
      sourceRun?.run_attempt !== 1 || sourceRun?.event !== "pull_request" ||
      sourceRun?.path !== ".github/workflows/ai-repair-independent-review.yml" ||
      sourceRun?.repository?.full_name !== REPO ||
      sourceRun?.head_repository?.full_name !== REPO ||
      main?.sha !== pr?.base?.sha || !SHA.test(main?.sha ?? "") ||
      !Array.isArray(linked) || linked.length !== 1 || linked[0]?.number !== pr?.number ||
      pr?.state !== "open" || pr?.draft !== true || pr?.base?.ref !== "main" ||
      pr?.head?.sha !== headSha || pr?.head?.repo?.full_name !== REPO ||
      !BRANCH.test(pr?.head?.ref ?? "") ||
      sourceRun.head_branch !== pr.head.ref ||
      !Number.isSafeInteger(pr.number) || pr.number < 1) {
    fail("regression_prepare_pr_untrusted");
  }
  const job = exactOne(jobs, "regression_prepare_work_unlinked");
  const support = exactOne(ticket, "regression_prepare_ticket_unavailable");
  const user = exactOne(messages, "regression_prepare_message_unavailable");
  const link = exactOne(links, "regression_prepare_link_unavailable");
  if (!UUID.test(job?.work_id ?? "") || !UUID.test(job?.ticket_id ?? "") ||
      !UUID.test(job?.latest_user_message_id ?? "") ||
      job.pr_number !== pr.number || job.head_sha !== headSha || job.status !== "pr_open" ||
      createHash("sha256").update(job.work_id).digest("hex").slice(0, 16) !== pr.head.ref.slice(-16) ||
      pr.title !== `Yutakasa support repair ${pr.head.ref.slice(-16)}` ||
      !pr.body?.startsWith(`Private support reference: ${pr.head.ref.slice(-16)}\n`) ||
      support?.id !== job.ticket_id || support?.subject !== SUBJECT ||
      (rehearsalWorkId !== null && (job.work_id !== rehearsalWorkId ||
        !/^yutakasa-auto-smoke\+[^@]+@example\.invalid$/iu.test(support?.user_email ?? ""))) ||
      support?.category !== "technical" || support?.status !== "in_progress" ||
      support?.automation_status !== "awaiting_repair" || support?.decision_required !== false ||
      user?.id !== job.latest_user_message_id || user?.body !== BODY ||
      !Number.isFinite(Date.parse(user?.created_at ?? "")) ||
      !Array.isArray(attachments) || attachments.length !== 0 ||
      !Array.isArray(adminMessages) || adminMessages.length > 1 ||
      adminMessages.some((message) => !Number.isFinite(Date.parse(message?.created_at ?? "")) ||
        Date.parse(message.created_at) >= Date.parse(user.created_at)) ||
      link?.pr_number !== pr.number || link?.ticket_id !== job.ticket_id ||
      link?.latest_user_message_id !== job.latest_user_message_id ||
      OWNER_TERMS.test(SUBJECT) || OWNER_TERMS.test(BODY)) {
    fail("regression_prepare_condition_not_exact");
  }
  return { eligible: true, workId: job.work_id, prNumber: pr.number,
    scenarioKey: "chat_title_zero_width" };
}

export async function prepareTicketRegression({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const rehearsal = env.YUTAKASA_AUTO_MERGE_ENABLED !== "true" &&
    UUID.test(env.YUTAKASA_AUTO_MERGE_REHEARSAL_WORK_ID ?? "") &&
    SHA.test(env.YUTAKASA_AUTO_MERGE_REHEARSAL_HEAD_SHA ?? "") &&
    env.YUTAKASA_AUTO_MERGE_REHEARSAL_HEAD_SHA === env.REPAIR_TRIGGER_SHA;
  if (env.GITHUB_EVENT_NAME !== "workflow_run" || env.GITHUB_REPOSITORY !== REPO ||
      env.GITHUB_REF !== "refs/heads/main" ||
      !(env.YUTAKASA_AUTO_MERGE_ENABLED === "true" || rehearsal) ||
      !SHA.test(env.REPAIR_TRIGGER_SHA ?? "") ||
      !/^[1-9][0-9]{0,17}$/u.test(env.REVIEW_RUN_ID ?? "") ||
      !Number.isSafeInteger(Number(env.REVIEW_RUN_ID)) ||
      typeof env.GITHUB_TOKEN !== "string" || env.GITHUB_TOKEN.length < 20 ||
      typeof env.SUPABASE_URL !== "string" || !/^https:\/\/[^/]+\.supabase\.co$/u.test(env.SUPABASE_URL) ||
      typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
      env.SUPABASE_SERVICE_ROLE_KEY.length < 20) fail("regression_prepare_configuration_invalid");
  const headSha = env.REPAIR_TRIGGER_SHA;
  const sourceRunId = Number(env.REVIEW_RUN_ID);
  const ghHeaders = { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}` };
  const gh = (suffix) => json(fetchImpl, `https://api.github.com/repos/${REPO}/${suffix}`,
    ghHeaders, "regression_prepare_github_unavailable", 256 * 1024);
  const [sourceRun, main, linked] = await Promise.all([
    gh(`actions/runs/${sourceRunId}`), gh("commits/main"), gh(`commits/${headSha}/pulls`),
  ]);
  if (!Array.isArray(linked) || linked.length !== 1 ||
      !Number.isSafeInteger(linked[0]?.number) || linked[0].number < 1) {
    return { eligible: false, code: "regression_prepare_not_ticket_pr" };
  }
  const pr = await gh(`pulls/${linked[0].number}`);
  if (!BRANCH.test(pr?.head?.ref ?? "")) return { eligible: false, code: "regression_prepare_not_ticket_pr" };
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const dbHeaders = { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" };
  const rows = (table, values) => {
    const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
    for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
    return json(fetchImpl, url, dbHeaders, "regression_prepare_database_unavailable", 16 * 1024);
  };
  const jobs = await rows("yutakasa_ticket_repair_jobs", {
    pr_number: `eq.${pr.number}`, select: "work_id,ticket_id,latest_user_message_id,pr_number,head_sha,status", limit: "2",
  });
  const job = exactOne(jobs, "regression_prepare_work_unlinked");
  const [ticket, messages, attachments, links, adminMessages] = await Promise.all([
    rows("support_tickets", { id: `eq.${job.ticket_id}`,
      select: "id,user_email,subject,category,status,automation_status,decision_required", limit: "2" }),
    rows("support_messages", { ticket_id: `eq.${job.ticket_id}`, sender_type: "eq.user",
      select: "id,body,created_at", order: "created_at.desc,id.desc", limit: "2" }),
    rows("support_attachments", { ticket_id: `eq.${job.ticket_id}`, select: "id", limit: "1" }),
    rows("yutakasa_repair_ticket_links", { pr_number: `eq.${pr.number}`,
      select: "pr_number,ticket_id,latest_user_message_id", limit: "2" }),
    rows("support_messages", { ticket_id: `eq.${job.ticket_id}`, sender_type: "eq.admin",
      select: "id,created_at", order: "created_at.desc,id.desc", limit: "1" }),
  ]);
  // The second newest user message is accepted only if it is older than the
  // linked message. The exact latest ID is checked below.
  if (!Array.isArray(messages) || messages.length !== 1) {
    fail("regression_prepare_message_unavailable");
  }
  const result = selectEligibleTicketRepair({ sourceRun, main, linked, pr, jobs, ticket,
    messages, attachments, links, adminMessages, headSha, sourceRunId,
    rehearsalWorkId: rehearsal ? env.YUTAKASA_AUTO_MERGE_REHEARSAL_WORK_ID : null });
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT,
      `eligible=true\nwork_id=${result.workId}\npr_number=${result.prNumber}\nscenario_key=${result.scenarioKey}\n`,
      { encoding: "utf8" });
  }
  return result;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  prepareTicketRegression().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, eligible: result.eligible,
      code: result.eligible ? "regression_prepare_eligible" : result.code })}\n`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, code:
        error instanceof RegressionPrepareError ? error.code : "regression_prepare_failed" })}\n`);
      process.exitCode = 1;
    },
  );
}
