import { createHash } from "node:crypto";

import { DriveIntakeError } from "./drive-intake.mjs";
import { driveResultEventId } from "./drive-intake-runtime.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const DEPLOYMENT = /^dpl_[A-Za-z0-9]{8,160}$/u;
const EVENT = /^drive_[a-f0-9]{32}$/u;
const REQUIRED_CHECKS = Object.freeze([
  "source-repair-verify", "ai-repair-independent-review", "monitor", "Vercel",
]);
const REPORT_KEYS = Object.freeze([
  "eventId", "completedAt", "inputSource", "classification", "cause", "change",
  "prUrl", "productionSha", "deploymentId", "customerReply", "tests",
  "observations", "unverifiedItems",
].sort());
const PRIVATE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:sk-|gh[pousr]_|Bearer\s+)[A-Za-z0-9_-]{8,}/iu;

function fail(code) {
  throw new DriveIntakeError(code);
}

function timestamp(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(code);
  return Date.parse(value);
}

function sameTime(a, b) {
  return Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) &&
    Date.parse(a) === Date.parse(b);
}

function canonical(value, depth = 0) {
  if (depth > 12) fail("drive_evidence_report_invalid");
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]),
    );
  }
  if (typeof value === "string" || typeof value === "boolean" ||
      value === null || Number.isSafeInteger(value)) return value;
  fail("drive_evidence_report_invalid");
}

export function driveReportSha256(report) {
  try {
    if (!report || typeof report !== "object" || Array.isArray(report) ||
        JSON.stringify(report) === undefined ||
        Buffer.byteLength(JSON.stringify(report)) > 64 * 1024) {
      fail("drive_evidence_report_invalid");
    }
    const bytes = JSON.stringify(canonical(report));
    if (Buffer.byteLength(bytes) > 64 * 1024) fail("drive_evidence_report_invalid");
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    fail("drive_evidence_report_invalid");
  }
}

function checkedReport(report, binding, release, now) {
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      JSON.stringify(Object.keys(report).sort()) !== JSON.stringify(REPORT_KEYS) ||
      report.eventId !== binding.event_id ||
      report.inputSource !== "Google Drive 受付" ||
      report.classification !== "技術障害" ||
      report.customerReply !== "未送信" ||
      report.productionSha !== release.merge_sha ||
      report.deploymentId !== release.deployment_id ||
      report.prUrl !==
        `https://github.com/sanrinawakes/yutakasa-tapping-coach/pull/${release.pr_number}` ||
      !Array.isArray(report.unverifiedItems) || report.unverifiedItems.length !== 0 ||
      !Array.isArray(report.tests) || report.tests.length !== REQUIRED_CHECKS.length ||
      !Array.isArray(report.observations) || report.observations.length !== 3) {
    fail("drive_evidence_report_invalid");
  }
  for (const name of ["cause", "change"]) {
    if (typeof report[name] !== "string" || !report[name].trim() ||
        report[name].length > 1200 || PRIVATE.test(report[name])) {
      fail("drive_evidence_report_invalid");
    }
  }
  for (let i = 0; i < REQUIRED_CHECKS.length; i += 1) {
    const test = report.tests[i];
    if (test?.name !== REQUIRED_CHECKS[i] || test.passed !== 1 || test.failed !== 0 ||
        Object.keys(test).sort().join(",") !== "failed,name,passed") {
      fail("drive_evidence_report_invalid");
    }
  }
  const completed = timestamp(report.completedAt, "drive_evidence_report_invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(report.completedAt) ||
      completed > now.getTime() + 30000) {
    fail("drive_evidence_report_invalid");
  }
  if (completed < timestamp(release.verified_at, "drive_evidence_release_invalid")) {
    fail("drive_evidence_report_invalid");
  }
}

// All arguments are metadata. The binding must come from the owner-controlled,
// read-only table, never from the Drive file or a model response. This is used
// at every existing PDF publication evidence check, including immediately
// before POST and before confirming an existing result.
export function verifyDriveReleaseEvidence({
  key, binding, release, observations, production, checks, now = new Date(),
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !key || typeof key !== "object" ||
      !/^[A-Za-z0-9_-]{1,256}$/u.test(key.fileId ?? "") ||
      !/^[0-9]{1,20}$/u.test(key.driveVersion ?? "") ||
      !HASH.test(key.contentSha256 ?? "") ||
      !EVENT.test(key.eventId ?? "") ||
      !key.report || driveResultEventId({
        id: key.fileId, name: "bound-source", mimeType: "application/pdf",
        modifiedTime: key.modifiedTime, version: key.driveVersion,
      }) !== key.eventId) {
    fail("drive_evidence_key_invalid");
  }
  if (!binding || typeof binding !== "object" ||
      binding.status !== "verified" ||
      binding.event_id !== key.eventId ||
      binding.file_id !== key.fileId ||
      !sameTime(binding.modified_time, key.modifiedTime) ||
      binding.drive_version !== key.driveVersion ||
      binding.content_sha256 !== key.contentSha256 ||
      !HASH.test(binding.report_sha256 ?? "") ||
      binding.report_sha256 !== driveReportSha256(key.report) ||
      binding.report_sha256 !== driveReportSha256(binding.report) ||
      !Number.isSafeInteger(binding.release_pr_number) ||
      binding.release_pr_number < 1 ||
      typeof binding.verified_at !== "string" ||
      !Number.isFinite(Date.parse(binding.verified_at))) {
    fail("drive_evidence_binding_invalid");
  }
  if (!release || typeof release !== "object" ||
      release.pr_number !== binding.release_pr_number ||
      release.status !== "verified" ||
      !SHA.test(release.head_sha ?? "") ||
      !SHA.test(release.merge_sha ?? "") ||
      !DEPLOYMENT.test(release.deployment_id ?? "") ||
      !Number.isSafeInteger(release.healthy_count) || release.healthy_count < 3 ||
      timestamp(release.verified_at, "drive_evidence_release_invalid") > now.getTime() ||
      timestamp(binding.verified_at, "drive_evidence_binding_invalid") >
        now.getTime()) {
    fail("drive_evidence_release_invalid");
  }
  checkedReport(key.report, binding, release, now);
  if (!Array.isArray(observations) || observations.length !== 3) {
    fail("drive_evidence_observations_invalid");
  }
  const times = observations.map((row, index) => {
    if (row?.pr_number !== release.pr_number || row.healthy !== true ||
        row.deployment_id !== release.deployment_id ||
        row.error_code !== null ||
        !Number.isSafeInteger(row.workflow_run_id) || row.workflow_run_id < 1 ||
        !Number.isSafeInteger(row.cron_slot) ||
        !sameTime(row.observed_at, key.report.observations[index]) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
          key.report.observations[index] ?? "")) {
      fail("drive_evidence_observations_invalid");
    }
    const ms = timestamp(row.observed_at, "drive_evidence_observations_invalid");
    if (Math.floor(ms / 600000) !== row.cron_slot) fail("drive_evidence_observations_invalid");
    return ms;
  });
  if (new Set(observations.map((row) => row.workflow_run_id)).size !== 3 ||
      observations[0].cron_slot + 1 !== observations[1].cron_slot ||
      observations[1].cron_slot + 1 !== observations[2].cron_slot ||
      times[2] - times[0] < 20 * 60 * 1000 ||
      times[2] > timestamp(release.verified_at, "drive_evidence_release_invalid") ||
      times[2] > now.getTime()) {
    fail("drive_evidence_observations_invalid");
  }
  const observed = timestamp(production?.observedAt, "drive_evidence_production_invalid");
  if (production.ready !== true ||
      production.mainSha !== release.merge_sha ||
      production.deploymentId !== release.deployment_id ||
      observed > now.getTime() + 30000 ||
      now.getTime() - observed > 5 * 60 * 1000) {
    fail("drive_evidence_production_invalid");
  }
  if (checks?.headSha !== release.head_sha ||
      !REQUIRED_CHECKS.every((name) => checks[name] === "success")) {
    fail("drive_evidence_checks_invalid");
  }
  return true;
}
