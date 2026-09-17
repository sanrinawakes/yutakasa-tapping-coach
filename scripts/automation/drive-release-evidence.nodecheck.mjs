import assert from "node:assert/strict";
import test from "node:test";

import { DriveIntakeError } from "./drive-intake.mjs";
import { driveResultEventId } from "./drive-intake-runtime.mjs";
import {
  driveReportSha256, verifyDriveReleaseEvidence,
} from "./drive-release-evidence.mjs";

const FILE = {
  id: "opaque_drive_file_1",
  name: "unused-private-name.pdf",
  mimeType: "application/pdf",
  modifiedTime: "2026-09-17T02:00:00.000Z",
  version: "42",
};
const PR_NUMBER = 52;
const HEAD_SHA = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const DEPLOYMENT_ID = "dpl_1234567890";
const TIMES = [
  "2026-09-17T02:00:00.000Z",
  "2026-09-17T02:10:00.000Z",
  "2026-09-17T02:20:00.000Z",
];
const KEY = {
  fileId: FILE.id,
  modifiedTime: FILE.modifiedTime,
  driveVersion: FILE.version,
  contentSha256: "c".repeat(64),
  eventId: driveResultEventId(FILE),
};
const REPORT = {
  eventId: KEY.eventId,
  completedAt: "2026-09-17T02:30:00.000Z",
  inputSource: "Google Drive 受付",
  classification: "技術障害",
  cause: "再現テストで保存処理の不具合を確認した。",
  change: "保存処理の修正を検証した。",
  prUrl: `https://github.com/sanrinawakes/yutakasa-tapping-coach/pull/${PR_NUMBER}`,
  productionSha: MERGE_SHA,
  deploymentId: DEPLOYMENT_ID,
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
  release_pr_number: PR_NUMBER,
  report: REPORT,
  status: "verified",
  verified_at: "2026-09-17T02:31:00.000Z",
};
const RELEASE = {
  pr_number: PR_NUMBER,
  head_sha: HEAD_SHA,
  merge_sha: MERGE_SHA,
  status: "verified",
  deployment_id: DEPLOYMENT_ID,
  healthy_count: 3,
  verified_at: "2026-09-17T02:20:30.000Z",
};
const OBSERVATIONS = TIMES.map((observed_at, index) => ({
  pr_number: PR_NUMBER,
  workflow_run_id: index + 1,
  observed_at,
  cron_slot: Math.floor(Date.parse(observed_at) / 600000),
  deployment_id: DEPLOYMENT_ID,
  healthy: true,
  error_code: null,
}));
const PRODUCTION = {
  observedAt: "2026-09-17T02:32:00.000Z",
  mainSha: MERGE_SHA,
  deploymentId: DEPLOYMENT_ID,
  ready: true,
};
const CHECKS = {
  headSha: HEAD_SHA,
  "source-repair-verify": "success",
  "ai-repair-independent-review": "success",
  monitor: "success",
  Vercel: "success",
};
const NOW = new Date("2026-09-17T02:33:00.000Z");

function bundle(overrides = {}) {
  return {
    key: { ...KEY, report: REPORT },
    binding: BINDING,
    release: RELEASE,
    observations: OBSERVATIONS,
    production: PRODUCTION,
    checks: CHECKS,
    now: NOW,
    ...overrides,
  };
}

function expectCode(call, code) {
  assert.throws(call, (error) =>
    error instanceof DriveIntakeError && error.code === code &&
    !error.message.includes(FILE.name) &&
    !error.message.includes(REPORT.cause));
}

test("canonical report digest is independent of object key order", () => {
  assert.equal(driveReportSha256(REPORT),
    driveReportSha256(Object.fromEntries(Object.entries(REPORT).reverse())));
  assert.equal(verifyDriveReleaseEvidence(bundle()), true);
});

test("unbound report and source revision fail before publication", () => {
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    key: { ...KEY, driveVersion: "43", report: REPORT },
  })), "drive_evidence_key_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    binding: { ...BINDING, content_sha256: "d".repeat(64) },
  })), "drive_evidence_binding_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    binding: { ...BINDING, status: "pending", verified_at: null },
  })), "drive_evidence_binding_invalid");
});

test("report text and report digest must match the owner binding", () => {
  const changed = { ...REPORT, change: "違う作業を書いた。" };
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    key: { ...KEY, report: changed },
  })), "drive_evidence_binding_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    key: { ...KEY, report: { ...REPORT, cause: "customer@example.com" } },
    binding: { ...BINDING, report: { ...REPORT, cause: "customer@example.com" },
      report_sha256: driveReportSha256({ ...REPORT, cause: "customer@example.com" }) },
  })), "drive_evidence_report_invalid");
  const malformedTime = { ...REPORT, completedAt: "2026-09-17T02:30:00Z" };
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    key: { ...KEY, report: malformedTime },
    binding: { ...BINDING, report: malformedTime,
      report_sha256: driveReportSha256(malformedTime) },
  })), "drive_evidence_report_invalid");
});

test("release, current production and exact CI head must agree", () => {
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    release: { ...RELEASE, status: "observing" },
  })), "drive_evidence_release_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    production: { ...PRODUCTION, mainSha: "e".repeat(40) },
  })), "drive_evidence_production_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    production: { ...PRODUCTION, observedAt: "2026-09-17T02:20:00.000Z" },
  })), "drive_evidence_production_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    checks: { ...CHECKS, monitor: "failed" },
  })), "drive_evidence_checks_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    checks: { ...CHECKS, headSha: "f".repeat(40) },
  })), "drive_evidence_checks_invalid");
});

test("three observations must be consecutive and same deployment", () => {
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    observations: OBSERVATIONS.map((row, index) =>
      index === 1 ? { ...row, healthy: false } : row),
  })), "drive_evidence_observations_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    observations: OBSERVATIONS.map((row, index) =>
      index === 1 ? { ...row, cron_slot: row.cron_slot + 2 } : row),
  })), "drive_evidence_observations_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    observations: OBSERVATIONS.map((row, index) =>
      index === 2 ? { ...row, deployment_id: "dpl_other123" } : row),
  })), "drive_evidence_observations_invalid");
  expectCode(() => verifyDriveReleaseEvidence(bundle({
    observations: OBSERVATIONS.map((row, index) =>
      index === 2 ? { ...row, workflow_run_id: 1 } : row),
  })), "drive_evidence_observations_invalid");
});

test("circular and deeply nested reports become fixed errors", () => {
  const cycle = {};
  cycle.self = cycle;
  expectCode(() => driveReportSha256(cycle), "drive_evidence_report_invalid");
  let deep = "end";
  for (let i = 0; i < 14; i += 1) deep = { inner: deep };
  expectCode(() => driveReportSha256(deep), "drive_evidence_report_invalid");
});

export { BINDING, CHECKS, KEY, NOW, OBSERVATIONS, PRODUCTION, RELEASE, REPORT };
