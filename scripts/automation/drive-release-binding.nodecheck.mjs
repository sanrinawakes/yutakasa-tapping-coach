import assert from "node:assert/strict";
import test from "node:test";

import { DriveIntakeError } from "./drive-intake.mjs";
import { createDriveReleaseEvidenceAdapter } from "./drive-release-binding.mjs";
import { driveReportSha256 } from "./drive-release-evidence.mjs";
import { driveResultEventId } from "./drive-intake-runtime.mjs";

const SECRETS = {
  SUPABASE_URL: "https://example-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-at-least-20",
  GITHUB_DISPATCH_TOKEN: "test-github-token-at-least-20",
  VERCEL_TOKEN: "test-vercel-token-at-least-20",
};
const PR = 52;
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const DPL = "dpl_1234567890";
const TIMES = [
  "2026-09-17T02:00:00.000Z",
  "2026-09-17T02:10:00.000Z",
  "2026-09-17T02:20:00.000Z",
];
const KEY = {
  fileId: "opaque_drive_file_1",
  modifiedTime: TIMES[0],
  driveVersion: "42",
  contentSha256: "c".repeat(64),
};
KEY.eventId = driveResultEventId({
  id: KEY.fileId, name: "private.pdf", mimeType: "application/pdf",
  modifiedTime: KEY.modifiedTime, version: KEY.driveVersion,
});
const REPORT = {
  eventId: KEY.eventId,
  completedAt: "2026-09-17T02:30:00.000Z",
  inputSource: "Google Drive 受付",
  classification: "技術障害",
  cause: "再現テストで保存処理の不具合を確認した。",
  change: "保存処理の修正を検証した。",
  prUrl: `https://github.com/sanrinawakes/yutakasa-tapping-coach/pull/${PR}`,
  productionSha: MERGE,
  deploymentId: DPL,
  customerReply: "未送信",
  tests: [
    "source-repair-verify", "ai-repair-independent-review", "monitor", "Vercel",
  ].map((name) => ({ name, passed: 1, failed: 0 })),
  observations: TIMES,
  unverifiedItems: [],
};
const BINDING = {
  event_id: KEY.eventId,
  file_id: KEY.fileId,
  modified_time: KEY.modifiedTime,
  drive_version: KEY.driveVersion,
  content_sha256: KEY.contentSha256,
  report_sha256: driveReportSha256(REPORT),
  release_pr_number: PR,
  report: REPORT,
  status: "verified",
  verified_at: "2026-09-17T02:31:00.000Z",
};
const RELEASE = {
  pr_number: PR,
  head_sha: HEAD,
  merge_sha: MERGE,
  status: "verified",
  deployment_id: DPL,
  healthy_count: 3,
  verified_at: "2026-09-17T02:20:30.000Z",
};
const OBSERVATIONS = TIMES.map((observed_at, index) => ({
  pr_number: PR,
  workflow_run_id: index + 1,
  observed_at,
  cron_slot: Math.floor(Date.parse(observed_at) / 600000),
  deployment_id: DPL,
  healthy: true,
  error_code: null,
}));
const PRODUCTION = {
  observedAt: "2026-09-17T02:32:00.000Z",
  mainSha: MERGE,
  deploymentId: DPL,
  ready: true,
};
const NOW = new Date("2026-09-17T02:33:00.000Z");

function mockFetch({ binding = BINDING, checksPass = true, bindingStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ url, init });
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
    if (url.hostname === "example-project.supabase.co") {
      assert.equal(init.headers.apikey, SECRETS.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(init.headers.Authorization,
        `Bearer ${SECRETS.SUPABASE_SERVICE_ROLE_KEY}`);
      if (url.pathname.endsWith("/yutakasa_drive_release_bindings")) {
        assert.equal(url.searchParams.get("event_id"), `eq.${KEY.eventId}`);
        return Response.json(bindingStatus === 200 ? [binding] : { error: "denied" },
          { status: bindingStatus });
      }
      if (url.pathname.endsWith("/yutakasa_repair_releases")) {
        assert.equal(url.searchParams.get("pr_number"), `eq.${PR}`);
        return Response.json([RELEASE]);
      }
      if (url.pathname.endsWith("/yutakasa_repair_observations")) {
        assert.equal(url.searchParams.get("pr_number"), `eq.${PR}`);
        assert.equal(url.searchParams.get("limit"), "3");
        return Response.json([...OBSERVATIONS].reverse());
      }
    }
    if (url.hostname === "api.github.com") {
      assert.equal(init.headers.Authorization, `Bearer ${SECRETS.GITHUB_DISPATCH_TOKEN}`);
      assert.ok(url.pathname.includes(`/commits/${HEAD}/`));
      if (url.pathname.endsWith("/check-runs")) {
        return Response.json({
          total_count: 3,
          check_runs: [
            "source-repair-verify", "ai-repair-independent-review", "monitor",
          ].map((name, index) => ({
            id: index + 1, name, head_sha: HEAD, app: { slug: "github-actions" },
            status: "completed", conclusion: checksPass ? "success" : "failure",
          })),
        });
      }
      if (url.pathname.endsWith("/status")) {
        return Response.json({
          sha: HEAD,
          statuses: [{
            context: "Vercel", state: "success",
            description: "Deployment has completed",
          }],
        });
      }
    }
    assert.fail(`unexpected read path: ${url.pathname}`);
  };
  return { calls, fetchImpl };
}

function adapter(fetchImpl) {
  return createDriveReleaseEvidenceAdapter({
    secrets: SECRETS, fetchImpl,
    deploymentImpl: async ({ token }) => {
      assert.equal(token, SECRETS.VERCEL_TOKEN);
      return PRODUCTION;
    },
    now: () => NOW,
  });
}

test("fixed read-only adapter binds the file hash to verified live evidence", async () => {
  const { calls, fetchImpl } = mockFetch();
  const evidence = adapter(fetchImpl);
  const bound = await evidence.loadVerifiedResult(KEY);
  assert.deepEqual(bound, { ...KEY, report: REPORT });
  assert.equal(await evidence.verifyReleaseEvidence({ ...KEY, report: bound.report }), true);
  assert.equal(calls.filter(({ url }) =>
    url.pathname.endsWith("/yutakasa_drive_release_bindings")).length, 2);
  assert.ok(calls.every(({ url }) =>
    !url.toString().includes(SECRETS.SUPABASE_SERVICE_ROLE_KEY)));
  assert.ok(calls.every(({ url }) => !url.toString().includes(REPORT.cause)));
});

test("missing or inaccessible owner binding never becomes an empty healthy result", async () => {
  const { fetchImpl } = mockFetch({ bindingStatus: 403 });
  await assert.rejects(adapter(fetchImpl).loadVerifiedResult(KEY), (error) =>
    error instanceof DriveIntakeError &&
    error.code === "drive_evidence_binding_http_failure");
});

test("pending binding and failed exact-head CI cannot publish", async () => {
  const pending = mockFetch({ binding: { ...BINDING, status: "pending" } });
  await assert.rejects(adapter(pending.fetchImpl).loadVerifiedResult(KEY), (error) =>
    error instanceof DriveIntakeError &&
    error.code === "drive_evidence_binding_invalid");
  const failed = mockFetch({ checksPass: false });
  await assert.rejects(adapter(failed.fetchImpl).verifyReleaseEvidence({
    ...KEY, report: REPORT,
  }), (error) => error instanceof DriveIntakeError &&
    error.code === "drive_evidence_checks_invalid");
});

test("no trusted credentials stops before any network request", () => {
  let calls = 0;
  assert.throws(() => createDriveReleaseEvidenceAdapter({
    secrets: { ...SECRETS, SUPABASE_SERVICE_ROLE_KEY: "" },
    fetchImpl: async () => { calls += 1; },
  }), (error) => error instanceof DriveIntakeError &&
    error.code === "drive_evidence_config_invalid");
  assert.equal(calls, 0);
});
