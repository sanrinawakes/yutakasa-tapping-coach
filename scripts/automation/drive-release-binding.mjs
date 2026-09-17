import { DriveIntakeError } from "./drive-intake.mjs";
import { verifyDriveReleaseEvidence } from "./drive-release-evidence.mjs";
import { collectRemoteDeployment } from "./remote-production.mjs";
import { driveResultEventId } from "./drive-intake-runtime.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const RESPONSE_LIMIT = 256 * 1024;
const TIMEOUT_MS = 12_000;
const HEAD_SHA = /^[a-f0-9]{40}$/u;

function fail(code) {
  throw new DriveIntakeError(code);
}

function checkedConfig(secrets) {
  let base;
  try { base = new URL(secrets?.SUPABASE_URL); }
  catch { fail("drive_evidence_config_invalid"); }
  if (base.protocol !== "https:" || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash ||
      !/^[a-z0-9-]+\.supabase\.co$/u.test(base.hostname) ||
      typeof secrets?.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
      secrets.SUPABASE_SERVICE_ROLE_KEY.length < 20 ||
      /[\r\n]/u.test(secrets.SUPABASE_SERVICE_ROLE_KEY) ||
      typeof secrets.GITHUB_DISPATCH_TOKEN !== "string" ||
      secrets.GITHUB_DISPATCH_TOKEN.length < 20 ||
      /[\r\n]/u.test(secrets.GITHUB_DISPATCH_TOKEN) ||
      typeof secrets.VERCEL_TOKEN !== "string" ||
      secrets.VERCEL_TOKEN.length < 20 ||
      /[\r\n]/u.test(secrets.VERCEL_TOKEN)) {
    fail("drive_evidence_config_invalid");
  }
  return {
    base: base.origin,
    serviceKey: secrets.SUPABASE_SERVICE_ROLE_KEY,
    githubToken: secrets.GITHUB_DISPATCH_TOKEN,
    vercelToken: secrets.VERCEL_TOKEN,
  };
}

async function getJson(url, headers, code, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET", headers, redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    fail(`${code}_request_failed`);
  }
  if (response?.status !== 200) fail(`${code}_http_failure`);
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > RESPONSE_LIMIT) {
    fail(`${code}_response_invalid`);
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    fail(`${code}_response_invalid`);
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) fail(`${code}_response_invalid`);
      total += chunk.byteLength;
      if (total > RESPONSE_LIMIT) fail(`${code}_response_invalid`);
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail(`${code}_response_invalid`);
  }
}

function supabaseUrl(config, table, params) {
  const url = new URL(`${config.base}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function oneRow(config, table, params, code, fetchImpl) {
  const result = await getJson(supabaseUrl(config, table, {
    ...params, limit: "2",
  }), {
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
  }, code, fetchImpl);
  if (!Array.isArray(result) || result.length !== 1) fail(`${code}_missing_or_ambiguous`);
  return result[0];
}

async function readBinding(config, eventId, fetchImpl) {
  if (typeof eventId !== "string" || !/^drive_[a-f0-9]{32}$/u.test(eventId)) {
    fail("drive_evidence_event_invalid");
  }
  return oneRow(config, "yutakasa_drive_release_bindings", {
    select: "event_id,file_id,modified_time,drive_version,content_sha256,report_sha256,release_pr_number,report,status,verified_at",
    event_id: `eq.${eventId}`,
  }, "drive_evidence_binding", fetchImpl);
}

async function readBindingHeader(config, key, fetchImpl) {
  if (!key || typeof key !== "object" ||
      !/^drive_[a-f0-9]{32}$/u.test(key.eventId ?? "") ||
      key.eventId !== driveResultEventId({
        id: key.fileId, name: "bound-source", mimeType: "application/pdf",
        modifiedTime: key.modifiedTime, version: key.driveVersion,
      })) fail("drive_evidence_event_invalid");
  const result = await getJson(supabaseUrl(config, "yutakasa_drive_release_bindings", {
    select: "event_id,file_id,modified_time,drive_version,content_sha256,status",
    event_id: `eq.${key.eventId}`,
    limit: "2",
  }), {
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
  }, "drive_evidence_binding", fetchImpl);
  if (!Array.isArray(result) || result.length > 1) fail("drive_evidence_binding_invalid");
  if (result.length === 0 || result[0]?.status !== "verified") return null;
  const binding = result[0];
  if (binding.event_id !== key.eventId || binding.file_id !== key.fileId ||
      binding.drive_version !== key.driveVersion ||
      !Number.isFinite(Date.parse(binding.modified_time)) ||
      Date.parse(binding.modified_time) !== Date.parse(key.modifiedTime) ||
      !/^[a-f0-9]{64}$/u.test(binding.content_sha256 ?? "")) {
    fail("drive_evidence_binding_invalid");
  }
  return { eventId: key.eventId, contentSha256: binding.content_sha256 };
}

async function readRelease(config, prNumber, fetchImpl) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) fail("drive_evidence_release_invalid");
  return oneRow(config, "yutakasa_repair_releases", {
    select: "pr_number,head_sha,merge_sha,status,deployment_id,healthy_count,verified_at",
    pr_number: `eq.${prNumber}`,
  }, "drive_evidence_release", fetchImpl);
}

async function readObservations(config, prNumber, fetchImpl) {
  const result = await getJson(supabaseUrl(config, "yutakasa_repair_observations", {
    select: "pr_number,workflow_run_id,observed_at,cron_slot,deployment_id,healthy,error_code",
    pr_number: `eq.${prNumber}`,
    order: "observed_at.desc",
    limit: "3",
  }), {
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
  }, "drive_evidence_observations", fetchImpl);
  if (!Array.isArray(result) || result.length !== 3) {
    fail("drive_evidence_observations_invalid");
  }
  return result.reverse();
}

async function readChecks(config, headSha, fetchImpl) {
  if (!HEAD_SHA.test(headSha ?? "")) fail("drive_evidence_checks_invalid");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.githubToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const [runs, status] = await Promise.all([
    getJson(`https://api.github.com/repos/${REPO}/commits/${headSha}/check-runs?per_page=100`,
      headers, "drive_evidence_checks", fetchImpl),
    getJson(`https://api.github.com/repos/${REPO}/commits/${headSha}/status`,
      headers, "drive_evidence_status", fetchImpl),
  ]);
  if (!Number.isSafeInteger(runs?.total_count) || runs.total_count > 100 ||
      !Array.isArray(runs.check_runs) ||
      runs.check_runs.length !== runs.total_count ||
      status?.sha !== headSha || !Array.isArray(status.statuses)) {
    fail("drive_evidence_checks_invalid");
  }
  const checks = { headSha };
  for (const name of ["source-repair-verify", "ai-repair-independent-review", "monitor"]) {
    const rows = runs.check_runs.filter((row) =>
      row?.name === name && row.head_sha === headSha &&
      row.app?.slug === "github-actions" && Number.isSafeInteger(row.id));
    const latest = rows.sort((a, b) => b.id - a.id)[0];
    checks[name] = latest?.status === "completed" &&
      latest.conclusion === "success" ? "success" : "failed";
  }
  const vercel = status.statuses.find((item) => item?.context === "Vercel");
  checks.Vercel = vercel?.state === "success" &&
    vercel.description === "Deployment has completed" ? "success" : "failed";
  return checks;
}

// The owner-controlled binding table is read-only to service_role. These
// callbacks fit processVerifiedDriveIntake; absent approval rows fail closed.
// There is deliberately no report writer or Drive access in this adapter.
export function createDriveReleaseEvidenceAdapter({
  secrets = process.env,
  fetchImpl = globalThis.fetch,
  deploymentImpl = collectRemoteDeployment,
  now = () => new Date(),
} = {}) {
  const config = checkedConfig(secrets);
  if (typeof fetchImpl !== "function" || typeof deploymentImpl !== "function" ||
      typeof now !== "function") fail("drive_evidence_config_invalid");
  return {
    async inspectVerifiedBinding(key) {
      return readBindingHeader(config, key, fetchImpl);
    },
    async loadVerifiedResult(key) {
      const binding = await readBinding(config, key?.eventId, fetchImpl);
      if (binding.status !== "verified" ||
          binding.file_id !== key.fileId ||
          binding.drive_version !== key.driveVersion ||
          binding.content_sha256 !== key.contentSha256 ||
          !Number.isFinite(Date.parse(binding.modified_time)) ||
          Date.parse(binding.modified_time) !== Date.parse(key.modifiedTime) ||
          binding.report?.eventId !== key.eventId) {
        fail("drive_evidence_binding_invalid");
      }
      return {
        eventId: key.eventId,
        fileId: key.fileId,
        modifiedTime: key.modifiedTime,
        driveVersion: key.driveVersion,
        contentSha256: key.contentSha256,
        report: binding.report,
      };
    },
    async verifyReleaseEvidence(key) {
      const binding = await readBinding(config, key?.eventId, fetchImpl);
      if (!Number.isSafeInteger(binding.release_pr_number)) {
        fail("drive_evidence_binding_invalid");
      }
      const [release, observations, production] = await Promise.all([
        readRelease(config, binding.release_pr_number, fetchImpl),
        readObservations(config, binding.release_pr_number, fetchImpl),
        deploymentImpl({ token: config.vercelToken, fetchImpl }),
      ]);
      const checks = await readChecks(config, release.head_sha, fetchImpl);
      return verifyDriveReleaseEvidence({
        key, binding, release, observations, production, checks, now: now(),
      });
    },
  };
}
