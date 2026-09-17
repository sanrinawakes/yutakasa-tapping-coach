import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TEST_SUPPORT_ACK, TEST_SUPPORT_BODY, TEST_SUPPORT_SUBJECT } from
  "./ai-repair-functional-smoke.mjs";
import { rescueTicketTerraIssueSmoke, runTicketTerraIssueSmoke } from
  "./ticket-terra-issue-smoke.mjs";

const TICKET = "11111111-1111-4111-8111-111111111111";
const WORK = "22222222-2222-4222-8222-222222222222";
const USER_MESSAGE = "33333333-3333-4333-8333-333333333333";
const SYSTEM_MESSAGE = "44444444-4444-4444-8444-444444444444";
const DEPLOYMENT = "dpl_testterra12345678";

function environment(overrides = {}) {
  return { GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach",
    GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    TICKET_REPAIR_ENABLED: "false", AUTO_MERGE_ENABLED: "false",
    GH_TOKEN: "scoped-repair-token-at-least-20-characters",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key-at-least-20-chars",
    ...overrides };
}

function fixture({ issueFailure = false, contextChanged = false,
  manualReviewChanged = false } = {}) {
  const events = [];
  let failureRecorded = false;
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.host, "test.supabase.co");
    const route = url.pathname.slice("/rest/v1/".length);
    events.push(route);
    if (route === "rpc/claim_yutakasa_ticket_repair_context") {
      assert.deepEqual(JSON.parse(init.body), { p_work_id: WORK, p_run_id: 123 });
      return Response.json({ work_id: WORK, ticket_id: TICKET,
        latest_user_message_id: USER_MESSAGE, category: "technical",
        subject: TEST_SUPPORT_SUBJECT,
        messages: [
          { id: USER_MESSAGE, sender_type: "user",
            body: contextChanged ? "changed" : TEST_SUPPORT_BODY },
          { id: SYSTEM_MESSAGE, sender_type: "system", body: TEST_SUPPORT_ACK },
        ] });
    }
    if (route === "rpc/fail_yutakasa_ticket_repair_work") {
      assert.deepEqual(JSON.parse(init.body), {
        p_work_id: WORK, p_run_id: 123,
        p_reason_code: "synthetic_terra_issue_probe",
      });
      failureRecorded = true;
      return Response.json([{ status: "failed" }]);
    }
    if (route === "yutakasa_ticket_repair_jobs") {
      assert.equal(url.searchParams.get("work_id"), `eq.${WORK}`);
      return Response.json([{ work_id: WORK, ticket_id: TICKET,
        status: "failed", attempt_count: 1, claimed_run_id: 123,
        pr_number: null, head_sha: null }]);
    }
    if (route === "support_tickets") {
      assert.equal(url.searchParams.get("id"), `eq.${TICKET}`);
      return Response.json([{ id: TICKET, category: "technical", status: "in_progress",
        automation_status: manualReviewChanged ? "awaiting_repair" : "manual_review",
        decision_required: false }]);
    }
    throw new Error(`unexpected database route ${route}`);
  };
  const handoffImpl = async ({ cleanupRpcName, afterQueued }) => {
    assert.equal(cleanupRpcName, "cleanup_yutakasa_ticket_terra_issue_smoke");
    assert.equal(typeof afterQueued, "function");
    try {
      await afterQueued({ ticketId: TICKET, workId: WORK,
        latestUserMessageId: USER_MESSAGE });
    } finally { events.push("synthetic_cleanup"); }
    return { mainSha: "a".repeat(40), deploymentId: DEPLOYMENT,
      syntheticDataCleaned: true };
  };
  const issueImpl = async ({ env, issueMode }) => {
    assert.equal(issueMode, "synthetic_ticket");
    assert.equal(env.GH_TOKEN, environment().GH_TOKEN);
    events.push("capped_terra_and_fixed_issue");
    if (issueFailure) throw new Error("provider unavailable");
    return { ok: true, issueNumber: 42, issueClosed: true,
      terraCalled: true, recovered: false };
  };
  return { events, fetchImpl, handoffImpl, issueImpl,
    get failureRecorded() { return failureRecorded; } };
}

test("non-main, enabled repair, or missing scoped token stops before handoff", async () => {
  for (const override of [
    { GITHUB_REF: "refs/heads/feature" },
    { TICKET_REPAIR_ENABLED: "true" },
    { AUTO_MERGE_ENABLED: "true" },
    { GH_TOKEN: "" },
  ]) {
    const f = fixture();
    await assert.rejects(() => runTicketTerraIssueSmoke({
      env: environment(override), ...f,
    }), { code: "ticket_terra_issue_configuration_invalid" });
    assert.deepEqual(f.events, []);
  }
});

test("interrupted run is rescued from a private run-bound state file", async () => {
  const ghRunId = String(Date.now() + randomInt(1000));
  const env = environment({ GITHUB_RUN_ID: ghRunId });
  const file = path.join(os.tmpdir(), `yutakasa-ticket-terra-issue-${ghRunId}.json`);
  const runId = "55555555-5555-4555-8555-555555555555";
  const lockToken = "66666666-6666-4666-8666-666666666666";
  fs.writeFileSync(file, JSON.stringify({ version: 1, ghRunId: Number(ghRunId),
    runId, workId: WORK, lockToken }), { mode: 0o600, flag: "wx" });
  try {
    const result = await rescueTicketTerraIssueSmoke({ env,
      cleanupImpl: async (_env, _fetch, email, savedRun, ticketId, workId,
        savedLock, options) => {
        assert.equal(email, `yutakasa-auto-smoke+${runId}@example.invalid`);
        assert.equal(savedRun, runId);
        assert.equal(ticketId, null);
        assert.equal(workId, WORK);
        assert.equal(savedLock, lockToken);
        assert.deepEqual(options, {
          rpcName: "cleanup_yutakasa_ticket_terra_issue_smoke",
          ghRunId: Number(ghRunId), postInvestigation: true,
        });
      },
    });
    assert.deepEqual(result, { ok: true, rescued: true });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await rescueTicketTerraIssueSmoke({ env }),
      { ok: true, rescued: false });
  } finally { fs.rmSync(file, { force: true }); }
});

test("an unsafe or uncleaned rescue state is retained for investigation", async () => {
  const ghRunId = String(Date.now() + randomInt(1000));
  const env = environment({ GITHUB_RUN_ID: ghRunId });
  const file = path.join(os.tmpdir(), `yutakasa-ticket-terra-issue-${ghRunId}.json`);
  const contents = JSON.stringify({ version: 1, ghRunId: Number(ghRunId),
    runId: "55555555-5555-4555-8555-555555555555", workId: WORK,
    lockToken: "66666666-6666-4666-8666-666666666666" });
  fs.writeFileSync(file, contents, { mode: 0o644, flag: "wx" });
  try {
    await assert.rejects(() => rescueTicketTerraIssueSmoke({ env }),
      { code: "ticket_terra_issue_rescue_state_unsafe" });
    fs.chmodSync(file, 0o600);
    await assert.rejects(() => rescueTicketTerraIssueSmoke({ env,
      cleanupImpl: async () => { throw new Error("uncertain cleanup"); },
    }), /uncertain cleanup/u);
    assert.equal(fs.existsSync(file), true);
  } finally { fs.rmSync(file, { force: true }); }
});

test("fixed synthetic context, scoped issue, and manual-review receipt precede cleanup", async () => {
  const f = fixture();
  const result = await runTicketTerraIssueSmoke({ env: environment(), ...f });
  assert.deepEqual(f.events, [
    "rpc/claim_yutakasa_ticket_repair_context",
    "capped_terra_and_fixed_issue",
    "rpc/fail_yutakasa_ticket_repair_work",
    "yutakasa_ticket_repair_jobs", "support_tickets", "synthetic_cleanup",
  ]);
  assert.equal(f.failureRecorded, true);
  assert.deepEqual(result, { ok: true, mainSha: "a".repeat(40),
    deploymentId: DEPLOYMENT, issueNumber: 42, terraCalled: true,
    issueClosed: true, manualReviewVerified: true, syntheticDataCleaned: true });
});

test("GitHub issue failure still records private manual review before cleanup", async () => {
  const f = fixture({ issueFailure: true });
  await assert.rejects(() => runTicketTerraIssueSmoke({ env: environment(), ...f }),
    /provider unavailable/u);
  assert.equal(f.failureRecorded, true);
  assert.equal(f.events.at(-1), "synthetic_cleanup");
});

test("changed private context never calls Terra or GitHub", async () => {
  const f = fixture({ contextChanged: true });
  await assert.rejects(() => runTicketTerraIssueSmoke({ env: environment(), ...f }),
    { code: "ticket_terra_issue_context_mismatch" });
  assert.equal(f.events.includes("capped_terra_and_fixed_issue"), false);
  assert.equal(f.failureRecorded, true);
  assert.equal(f.events.at(-1), "synthetic_cleanup");
});

test("manual-review readback failure prevents a success receipt", async () => {
  const f = fixture({ manualReviewChanged: true });
  await assert.rejects(() => runTicketTerraIssueSmoke({ env: environment(), ...f }),
    { code: "ticket_terra_issue_manual_review_unconfirmed" });
  assert.equal(f.events.at(-1), "synthetic_cleanup");
});
