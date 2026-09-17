import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { RegressionPrepareError, selectEligibleTicketRepair,
  prepareTicketRegression } from "./ticket-repair-regression-prepare.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const workId = "e1aa3fb1-afae-43b8-b139-bc0fa4682255";
const fingerprint = createHash("sha256").update(workId).digest("hex").slice(0, 16);
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const sourceRunId = 1234567;
const pr = { number: 82, title: `Yutakasa support repair ${fingerprint}`,
  body: `Private support reference: ${fingerprint}\nNo customer text.`,
  state: "open", draft: true, base: { ref: "main", sha: baseSha },
  head: { ref: `codex/yutakasa-support-ai-${fingerprint}`, sha: headSha,
    repo: { full_name: REPO } } };
const ticketId = "223e4567-e89b-42d3-a456-426614174000";
const messageId = "323e4567-e89b-42d3-a456-426614174000";
const message = { id: messageId,
  body: "チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。",
  created_at: "2026-09-17T12:00:00Z" };
const fixture = {
  sourceRun: { id: sourceRunId, head_sha: headSha, status: "completed",
    conclusion: "success", run_attempt: 1, event: "pull_request",
    path: ".github/workflows/ai-repair-independent-review.yml",
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    head_branch: pr.head.ref },
  main: { sha: baseSha }, linked: [{ number: pr.number }], pr,
  jobs: [{ work_id: workId, ticket_id: ticketId, latest_user_message_id: messageId,
    pr_number: pr.number, head_sha: headSha, status: "pr_open" }],
  ticket: [{ id: ticketId, subject: "チャットの見出しが空白になる",
    user_email: "yutakasa-auto-smoke+rehearsal@example.invalid",
    category: "technical", status: "in_progress", automation_status: "awaiting_repair",
    decision_required: false }],
  messages: [message], attachments: [],
  links: [{ pr_number: pr.number, ticket_id: ticketId,
    latest_user_message_id: messageId }],
  adminMessages: [], headSha, sourceRunId,
};

test("a private exact condition and trusted independent review can start one regression", () => {
  assert.deepEqual(selectEligibleTicketRepair(fixture), {
    eligible: true, workId, prNumber: pr.number, scenarioKey: "chat_title_zero_width",
  });
  assert.deepEqual(selectEligibleTicketRepair({ ...fixture, rehearsalWorkId: workId }),
    { eligible: true, workId, prNumber: pr.number, scenarioKey: "chat_title_zero_width" });
});

test("free text, appended conditions, attachments, stale conversation, and review rerun fail closed", () => {
  for (const changed of [
    { messages: [{ ...message, body: `${message.body}ほかの端末でも起こります。` }] },
    { messages: [{ ...message, body: message.body.replace("（U+200B）", "") }] },
    { messages: [message, { ...message, id: "523e4567-e89b-42d3-a456-426614174000",
      body: "追加条件です。" }] },
    { attachments: [{ id: "423e4567-e89b-42d3-a456-426614174000" }] },
    { adminMessages: [{ created_at: "2026-09-17T12:01:00Z" }] },
    { sourceRun: { ...fixture.sourceRun, run_attempt: 2 } },
    { sourceRun: { ...fixture.sourceRun, head_repository: { full_name: "another/repo" } } },
    { jobs: [{ ...fixture.jobs[0], latest_user_message_id:
      "423e4567-e89b-42d3-a456-426614174000" }] },
    { pr: { ...pr, base: { ...pr.base, sha: "c".repeat(40) } } },
    { rehearsalWorkId: "00000000-0000-4000-8000-000000000000" },
    { rehearsalWorkId: workId, ticket: [{ ...fixture.ticket[0], user_email: "customer@example.com" }] },
  ]) {
    assert.throws(() => selectEligibleTicketRepair({ ...fixture, ...changed }),
      RegressionPrepareError);
  }
});

test("disabled automation makes no private or GitHub request", async () => {
  await assert.rejects(() => prepareTicketRegression({ env: {
    GITHUB_EVENT_NAME: "workflow_run", GITHUB_REPOSITORY: REPO,
    GITHUB_REF: "refs/heads/main", YUTAKASA_AUTO_MERGE_ENABLED: "false",
  }, fetchImpl: () => assert.fail("no request allowed") }),
  (error) => error instanceof RegressionPrepareError &&
    error.code === "regression_prepare_configuration_invalid");
});

test("rehearsal requires exact work and head before any request", async () => {
  const env = { GITHUB_EVENT_NAME: "workflow_run", GITHUB_REPOSITORY: REPO,
    GITHUB_REF: "refs/heads/main", YUTAKASA_AUTO_MERGE_ENABLED: "false",
    YUTAKASA_AUTO_MERGE_REHEARSAL_WORK_ID: workId,
    YUTAKASA_AUTO_MERGE_REHEARSAL_HEAD_SHA: "c".repeat(40),
    REPAIR_TRIGGER_SHA: headSha, REVIEW_RUN_ID: String(sourceRunId),
    GITHUB_TOKEN: "g".repeat(32), SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "s".repeat(32) };
  await assert.rejects(() => prepareTicketRegression({ env,
    fetchImpl: () => assert.fail("unexpected request") }),
  RegressionPrepareError);
});

test("the prepare step never prints customer text or sends it to the test job", async () => {
  const env = { GITHUB_EVENT_NAME: "workflow_run", GITHUB_REPOSITORY: REPO,
    GITHUB_REF: "refs/heads/main", YUTAKASA_AUTO_MERGE_ENABLED: "true",
    REPAIR_TRIGGER_SHA: headSha, REVIEW_RUN_ID: String(sourceRunId),
    GITHUB_TOKEN: "g".repeat(32), SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "s".repeat(32) };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith(`/actions/runs/${sourceRunId}`)) return Response.json(fixture.sourceRun);
    if (u.pathname.endsWith("/commits/main")) return Response.json(fixture.main);
    if (u.pathname.endsWith(`/commits/${headSha}/pulls`)) return Response.json(fixture.linked);
    if (u.pathname.endsWith(`/pulls/${pr.number}`)) return Response.json(fixture.pr);
    const table = u.pathname.split("/").at(-1);
    if (table === "yutakasa_ticket_repair_jobs") return Response.json(fixture.jobs);
    if (table === "support_tickets") return Response.json(fixture.ticket);
    if (table === "support_messages") return Response.json(u.searchParams.get("sender_type") === "eq.user"
      ? fixture.messages : fixture.adminMessages);
    if (table === "support_attachments") return Response.json(fixture.attachments);
    if (table === "yutakasa_repair_ticket_links") return Response.json(fixture.links);
    assert.fail(`unexpected ${u.pathname}`);
  };
  const result = await prepareTicketRegression({ env, fetchImpl });
  assert.deepEqual(result, selectEligibleTicketRepair(fixture));
  assert.equal(JSON.stringify(result).includes(message.body), false);
});
