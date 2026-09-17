import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const VERCEL_CLI = fileURLToPath(new URL("./node_modules/.bin/vercel", import.meta.url));
const REPO = "sanrinawakes/yutakasa-tapping-coach";
const ALIAS_HOST = "yutakasa-tapping-coach.vercel.app";
const PROJECT_ID = "prj_YJUFNmsjGF7hHFJ3A0BTNvrGTXBW";
const TEAM_ID = "team_H7RDZStJJtoqfh7pJ0OU4l5G";
const TEAM_SLUG = "sanrinawakes-projects";
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{8,160}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const LOG_FILTERS = Object.freeze({
  fiveXx: "--status-code=5xx",
  levelError: "--level=error",
  timeout: "--query=timeout",
  gemini: "--query=gemini",
});
// One authenticated production probe hit the intentionally disabled reply action.
// Match its immutable Vercel event identity and request metadata, never all 501s.
const KNOWN_DISABLED_REPLY_PROBE = Object.freeze({
  id: "khkhd-1789602181091-f3e1581be96c",
  timestamp: 1789602181091,
  deploymentId: "dpl_6Q4vydEuX5y4iyApkDV8gWyuXF4b",
  requestMethod: "PATCH",
  requestPath: "/api/internal/support-automation",
  responseStatusCode: 501,
  source: "serverless",
  level: "info",
});
const GEMINI_RETRY_PREFIX = "Retrying Gemini generation before response started:";
const GEMINI_RETRY_EVENT_KEYS = Object.freeze([
  "branch", "cache", "cacheReason", "deploymentId", "domain", "environment", "id",
  "level", "logs", "message", "pprState", "projectId", "requestMethod", "requestPath",
  "responseStatusCode", "source", "timestamp", "traceId",
].sort());
const FAILURE_LOG_WORDS = /\b(?:error|timeout|timed out|fail(?:ed|ure)?|exception|abort(?:ed)?|cancel(?:led)?)\b/iu;
const LOG_CHILD_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];

function fail(code) {
  throw new Error(code);
}

function requireMatch(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

async function readBounded(response, limit, code) {
  if (response.status !== 200) fail(`${code}_http_${response.status}`);
  if (!response.body) fail(`${code}_body_missing`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) fail(`${code}_too_large`);
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function getText(url, headers, limit, code, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    return await readBounded(response, limit, code);
  } catch (error) {
    if (error.message?.startsWith(`${code}_`)) throw error;
    fail(`${code}_request_failed`);
  }
}

async function getJson(url, headers, code, fetchImpl) {
  const body = await getText(url, headers, 2 * 1024 * 1024, code, fetchImpl);
  try {
    return JSON.parse(body);
  } catch {
    fail(`${code}_json_invalid`);
  }
}

export async function collectRemoteDeployment({
  token = process.env.VERCEL_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (typeof token !== "string" || token.length < 20) fail("vercel_token_missing");
  const githubHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "yutakasa-remote-monitor/1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const vercelHeaders = { Authorization: `Bearer ${token}` };
  const [commit, deployments, alias, login] = await Promise.all([
    getJson(`https://api.github.com/repos/${REPO}/commits/main`, githubHeaders, "github_main", fetchImpl),
    getJson(`https://api.github.com/repos/${REPO}/deployments?environment=Production&per_page=10`, githubHeaders, "github_deployments", fetchImpl),
    getJson(`https://api.vercel.com/v4/aliases/${ALIAS_HOST}?teamId=${TEAM_ID}`, vercelHeaders, "vercel_alias", fetchImpl),
    getText(`https://${ALIAS_HOST}/login`, { Accept: "text/html" }, 8 * 1024 * 1024, "login", fetchImpl),
  ]);

  const mainSha = requireMatch(commit?.sha, SHA, "github_main_invalid");
  if (!Array.isArray(deployments) || deployments.length === 0) fail("github_deployments_invalid");
  const latest = deployments.find((deployment) => deployment?.environment === "Production");
  if (!Number.isSafeInteger(latest?.id) || latest.id < 1) fail("github_deployment_invalid");
  const githubSha = requireMatch(latest.sha, SHA, "github_deployment_sha_invalid");
  if (alias?.alias !== ALIAS_HOST || alias?.projectId !== PROJECT_ID || alias?.redirect) {
    fail("vercel_alias_invalid");
  }
  const id = requireMatch(alias.deploymentId, DEPLOYMENT_ID, "vercel_alias_id_invalid");
  const [deployment, statuses] = await Promise.all([
    getJson(`https://api.vercel.com/v13/deployments/${id}?teamId=${TEAM_ID}`, vercelHeaders, "vercel_deployment", fetchImpl),
    getJson(`https://api.github.com/repos/${REPO}/deployments/${latest.id}/statuses?per_page=10`, githubHeaders, "github_status", fetchImpl),
  ]);
  if (
    deployment?.id !== id ||
    deployment?.readyState !== "READY" ||
    deployment?.target !== "production" ||
    deployment?.projectId !== PROJECT_ID ||
    !Array.isArray(deployment?.alias) ||
    !deployment.alias.includes(ALIAS_HOST)
  ) fail("vercel_deployment_invalid");
  const vercelSha = requireMatch(
    deployment.meta?.githubCommitSha ?? deployment.meta?.gitCommitSha,
    SHA,
    "vercel_sha_invalid",
  );
  if (
    deployment.meta?.githubCommitSha &&
    deployment.meta?.gitCommitSha &&
    deployment.meta.githubCommitSha !== deployment.meta.gitCommitSha
  ) fail("vercel_sha_ambiguous");
  if (!/^[a-z0-9-]+\.vercel\.app$/u.test(deployment.url ?? "")) {
    fail("vercel_deployment_url_invalid");
  }
  const vercelUrl = `https://${deployment.url}`;
  if (!Array.isArray(statuses) || statuses[0]?.state !== "success") fail("github_status_invalid");
  const statusUrl = statuses[0].environment_url;
  const loginIds = [...login.matchAll(/data-dpl-id="(dpl_[A-Za-z0-9]{8,160})"/gu)].map((match) => match[1]);
  if (
    mainSha !== githubSha ||
    mainSha !== vercelSha ||
    (deployment.meta?.githubCommitRef ?? deployment.meta?.gitCommitRef) !== "main" ||
    statusUrl !== vercelUrl ||
    loginIds.length === 0 ||
    loginIds.some((loginId) => loginId !== id)
  ) fail("production_parity_mismatch");
  return Object.freeze({
    observedAt: new Date().toISOString(),
    mainSha,
    deploymentId: id,
    deploymentUrl: vercelUrl,
    ready: true,
  });
}

function isKnownDisabledReplyProbe(entry) {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
    Object.entries(KNOWN_DISABLED_REPLY_PROBE).every(([key, value]) => entry[key] === value);
}

function hasOnlyLogFields(log) {
  return log !== null && typeof log === "object" && !Array.isArray(log) &&
    Object.keys(log).sort().join(",") === "level,message";
}

function isBenignGeminiRetry(entry) {
  if (
    entry === null || typeof entry !== "object" || Array.isArray(entry) ||
    Object.keys(entry).sort().join(",") !== GEMINI_RETRY_EVENT_KEYS.join(",") ||
    typeof entry.id !== "string" || entry.id.length < 1 || entry.id.length > 160 ||
    !Number.isSafeInteger(entry.timestamp) || entry.timestamp < 1 ||
    !DEPLOYMENT_ID.test(entry.deploymentId) || entry.projectId !== PROJECT_ID ||
    entry.level !== "info" || entry.source !== "serverless" ||
    entry.environment !== "production" || entry.branch !== "main" ||
    entry.requestMethod !== "POST" || entry.requestPath !== "/api/chat" ||
    entry.responseStatusCode !== 200 ||
    typeof entry.message !== "string" || entry.message.length > 2_048 ||
    FAILURE_LOG_WORDS.test(entry.message) ||
    !Array.isArray(entry.logs) || entry.logs.length !== 2
  ) return false;

  const [info, retry] = entry.logs;
  if (
    !hasOnlyLogFields(info) || !hasOnlyLogFields(retry) ||
    info.level !== "info" || typeof info.message !== "string" ||
    info.message.length > 2_048 ||
    /gemini/iu.test(info.message) || FAILURE_LOG_WORDS.test(info.message) ||
    retry.level !== "warn" || typeof retry.message !== "string" ||
    !retry.message.startsWith(GEMINI_RETRY_PREFIX)
  ) return false;

  const detail = retry.message.slice(GEMINI_RETRY_PREFIX.length);
  const match = /^ \{ attempt: ([12]), nextAttempt: ([23]), delayMs: (400|1200) \}$/u.exec(detail);
  if (!match) return false;
  return (match[1] === "1" && match[2] === "2" && match[3] === "400") ||
    (match[1] === "2" && match[2] === "3" && match[3] === "1200");
}

export function parseBoundedLogQuery(stdout, { filterName } = {}) {
  if (typeof stdout !== "string") fail("log_output_invalid");
  let count = 0;
  let rawCount = 0;
  let excludedKnownProbe = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      fail("log_json_invalid");
    }
    rawCount += 1;
    if (filterName === "fiveXx" && isKnownDisabledReplyProbe(entry)) {
      if (excludedKnownProbe) fail("known_reply_probe_duplicate");
      excludedKnownProbe = true;
      continue;
    }
    if (filterName === "gemini" && isBenignGeminiRetry(entry)) continue;
    count += 1;
  }
  if (rawCount > 100) fail("log_limit_exceeded");
  return { count, truncated: rawCount === 100 };
}

export async function collectRemoteLogs({
  deploymentId,
  token = process.env.VERCEL_TOKEN,
  runCommand = execFile,
  deploymentOnly = false,
  since = null,
} = {}) {
  requireMatch(deploymentId, DEPLOYMENT_ID, "deployment_id_invalid");
  if (typeof token !== "string" || token.length < 20) fail("vercel_token_missing");
  if (deploymentOnly && (typeof since !== "string" ||
      !Number.isFinite(Date.parse(since)) ||
      Date.parse(since) > Date.now() + 60_000)) fail("log_since_invalid");
  const queries = {};
  const historicalQueries = {};
  const observedAt = new Date();
  const windowStart = deploymentOnly
    ? since
    : new Date(observedAt.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const until = observedAt.toISOString();
  const childEnv = { CI: "1", NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" };
  for (const name of LOG_CHILD_ENV_NAMES) {
    if (typeof process.env[name] === "string") childEnv[name] = process.env[name];
  }
  for (const [name, filter] of Object.entries(LOG_FILTERS)) {
    const counts = [];
    for (const scope of deploymentOnly ? ["current"] : ["project", "current"]) {
      let stdout;
      try {
        ({ stdout } = await runCommand(VERCEL_CLI, [
          "logs",
          ...(scope === "current" ? [`--deployment=${deploymentId}`] : []),
          `--since=${windowStart}`, `--until=${until}`, "--limit=100", "--no-follow", "--json",
          "--environment=production",
          "--project=yutakasa-tapping-coach", `--scope=${TEAM_SLUG}`,
          filter, "--token", token,
        ], {
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: "utf8",
          env: childEnv,
        }));
      } catch (error) {
        if (error?.killed || error?.signal === "SIGTERM") {
          fail(`log_${name}_${scope}_query_timeout`);
        }
        fail(`log_${name}_${scope}_query_failed`);
      }
      const parsed = parseBoundedLogQuery(stdout, { filterName: name });
      if (parsed.truncated) fail(`log_${name}_${scope}_truncated`);
      counts.push(parsed.count);
    }
    if (deploymentOnly) {
      queries[name] = { count: counts[0], truncated: false };
      continue;
    }
    const [projectCount, currentCount] = counts;
    if (currentCount > projectCount) fail(`log_${name}_scope_inconsistent`);
    queries[name] = { count: currentCount, truncated: false };
    historicalQueries[name] = { count: projectCount - currentCount, truncated: false };
  }
  return Object.freeze({
    observedAt: until,
    deploymentId,
    logScope: deploymentOnly ? "deployment_post_merge" : "project_production_split_by_current_deployment",
    since: deploymentOnly ? since : null,
    queries: Object.freeze(queries),
    historicalQueries: Object.freeze(historicalQueries),
  });
}
