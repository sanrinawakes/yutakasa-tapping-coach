import assert from "node:assert/strict";
import test from "node:test";

import {
  MonitorAlertError,
  alertTitle,
  createAlertIssue,
  listOpenAlertTitles,
  normalizeAlertInput,
  runMonitorAlert,
} from "./monitor-alert.mjs";

const deploymentId = "dpl_CnNGM63s3fmYAsHpe1RhkXqvJru4";
const token = "github-test-token-long-enough";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("normalization emits only fixed codes and accepts unknown deployment", () => {
  assert.deepEqual(
    normalizeAlertInput('["pending_tickets","pending_tickets","drive_intake_items"]', "unknown"),
    { reasonCodes: ["drive_intake_items", "pending_tickets"], deploymentId: "unknown" },
  );
  const privateText = "customer@example.com: private ticket content";
  const normalized = normalizeAlertInput(JSON.stringify([privateText]), deploymentId);
  assert.deepEqual(normalized.reasonCodes, ["remote_monitor_failure"]);
  assert.equal(JSON.stringify(normalized).includes(privateText), false);
  assert.throws(
    () => normalizeAlertInput("not json", deploymentId),
    (error) => error instanceof MonitorAlertError && error.code === "alert_reason_codes_invalid",
  );
  assert.throws(
    () => normalizeAlertInput('["pending_tickets"]', "customer@example.com"),
    (error) => error instanceof MonitorAlertError && error.code === "alert_input_invalid",
  );
});

test("owner decision, technical review, and stale context retain distinct public alert reasons", () => {
  const reasons = [
    "support_owner_decision_required",
    "support_technical_review_required",
    "support_context_stale",
  ];
  assert.deepEqual(normalizeAlertInput(JSON.stringify(reasons), deploymentId).reasonCodes,
    [...reasons].sort());
  for (const reason of reasons) assert.equal(alertTitle(reason), `[Yutakasa monitor] ${reason}`);
});

test("historical production log reasons remain explicit without implying a current deployment repair", () => {
  const reasons = [
    "historical_production_log_fiveXx",
    "historical_production_log_levelError",
    "historical_production_log_timeout",
    "historical_production_log_gemini",
  ];
  assert.deepEqual(normalizeAlertInput(JSON.stringify(reasons), deploymentId).reasonCodes,
    [...reasons].sort());
});

test("issue listing checks all open issues and ignores PR titles", async () => {
  const rows = [
    { number: 1, title: alertTitle("pending_tickets") },
    { number: 2, title: alertTitle("drive_intake_items"), pull_request: { url: "ignored" } },
  ];
  const titles = await listOpenAlertTitles({
    token,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, "api.github.com");
      assert.equal(options.method, "GET");
      return jsonResponse(rows);
    },
  });
  assert.equal(titles.has(alertTitle("pending_tickets")), true);
  assert.equal(titles.has(alertTitle("drive_intake_items")), false);
});

test("issue listing reaches later pages before deciding an alert is missing", async () => {
  const pages = [];
  const titles = await listOpenAlertTitles({
    token,
    fetchImpl: async (url) => {
      const page = new URL(url).searchParams.get("page");
      pages.push(page);
      if (page === "1") {
        return jsonResponse(Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          title: `Other issue ${index + 1}`,
        })));
      }
      return jsonResponse([{ number: 101, title: alertTitle("production_log_timeout") }]);
    },
  });
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(titles.has(alertTitle("production_log_timeout")), true);
});

test("issue creation posts only fixed code and opaque deployment ID", async () => {
  const privateText = "private customer message";
  const number = await createAlertIssue({
    reasonCode: "pending_tickets",
    deploymentId,
    token,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.equal(body.title, alertTitle("pending_tickets"));
      assert.equal(body.body.includes(deploymentId), true);
      assert.equal(body.body.includes(privateText), false);
      assert.equal(Object.keys(body).sort().join(","), "body,title");
      return jsonResponse({ number: 17, title: body.title }, 201);
    },
  });
  assert.equal(number, 17);
});

test("second invocation does not create another issue for the same open reason", async () => {
  const issues = [];
  let posts = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/repos/sanrinawakes/yutakasa-tapping-coach/issues");
    if (options.method === "GET") return jsonResponse(issues);
    posts += 1;
    const body = JSON.parse(options.body);
    const issue = { number: posts, title: body.title };
    issues.push(issue);
    return jsonResponse(issue, 201);
  };
  const env = {
    GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach",
    GITHUB_TOKEN: token,
    ALERT_REASON_CODES: '["pending_tickets","drive_intake_items"]',
    ALERT_DEPLOYMENT_ID: deploymentId,
  };
  assert.deepEqual(await runMonitorAlert({ env, fetchImpl }), {
    ok: true,
    created: 2,
    existing: 0,
    reasonCodes: ["drive_intake_items", "pending_tickets"],
  });
  assert.deepEqual(await runMonitorAlert({ env, fetchImpl }), {
    ok: true,
    created: 0,
    existing: 2,
    reasonCodes: ["drive_intake_items", "pending_tickets"],
  });
  assert.equal(posts, 2);
});

test("GitHub failures stop without a false success or duplicate create", async () => {
  await assert.rejects(
    listOpenAlertTitles({ token, fetchImpl: async () => jsonResponse({ error: "no access" }, 403) }),
    (error) => error instanceof MonitorAlertError && error.code === "github_issue_list_failed",
  );
  await assert.rejects(
    createAlertIssue({ reasonCode: "pending_tickets", deploymentId, token, fetchImpl: async () => jsonResponse({ error: "conflict" }, 422) }),
    (error) => error instanceof MonitorAlertError && error.code === "github_issue_create_failed",
  );
  await assert.rejects(
    createAlertIssue({ reasonCode: "pending_tickets", deploymentId, token, fetchImpl: async () => jsonResponse({ number: 1, title: "wrong" }, 201) }),
    (error) => error instanceof MonitorAlertError && error.code === "github_issue_create_unverified",
  );
});
