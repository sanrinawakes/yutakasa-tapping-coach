import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectRemoteDeployment,
  collectRemoteLogs,
  parseBoundedLogQuery,
} from "./remote-production.mjs";

const sha = "9e30bbefd52eb03b67a95dcce7ed2120ee8defaa";
const id = "dpl_CnNGM63s3fmYAsHpe1RhkXqvJru4";
const deploymentUrl = "https://yutakasa-tapping-coach-example.vercel.app";
const knownDisabledReplyProbe = Object.freeze({
  id: "khkhd-1789602181091-f3e1581be96c",
  timestamp: 1789602181091,
  deploymentId: "dpl_6Q4vydEuX5y4iyApkDV8gWyuXF4b",
  requestMethod: "PATCH",
  requestPath: "/api/internal/support-automation",
  responseStatusCode: 501,
  source: "serverless",
  level: "info",
});
const benignGeminiRetry = Object.freeze({
  id: "retry-event-123",
  timestamp: 1789607733203,
  deploymentId: "dpl_5BUmhZLu9vWgdHsFQMArYEcxWJti",
  projectId: "prj_YJUFNmsjGF7hHFJ3A0BTNvrGTXBW",
  level: "info",
  message: "POST /api/chat",
  source: "serverless",
  domain: "yutakasa-tapping-coach.vercel.app",
  cache: null,
  cacheReason: null,
  pprState: null,
  traceId: "trace-id-123",
  requestMethod: "POST",
  requestPath: "/api/chat",
  responseStatusCode: 200,
  environment: "production",
  branch: "main",
  logs: [
    { level: "info", message: "Chat request received" },
    { level: "warn", message: "Retrying Gemini generation before response started: { attempt: 1, nextAttempt: 2, delayMs: 400 }" },
  ],
});

function fakeFetch({ loginId = id, readyState = "READY", mainSha = sha } = {}) {
  return async (url) => {
    let value;
    if (url.endsWith("/commits/main")) value = { sha: mainSha };
    else if (url.includes("/deployments?")) value = [{ id: 123, sha, environment: "Production" }];
    else if (url.includes("/v4/aliases/")) value = {
      alias: "yutakasa-tapping-coach.vercel.app",
      projectId: "prj_YJUFNmsjGF7hHFJ3A0BTNvrGTXBW",
      deploymentId: id,
    };
    else if (url.includes("/v13/deployments/")) value = {
      id,
      readyState,
      target: "production",
      projectId: "prj_YJUFNmsjGF7hHFJ3A0BTNvrGTXBW",
      alias: ["yutakasa-tapping-coach.vercel.app"],
      meta: { githubCommitSha: sha, githubCommitRef: "main" },
      url: deploymentUrl.replace(/^https:\/\//u, ""),
    };
    else if (url.includes("/statuses?")) value = [{ state: "success", environment_url: deploymentUrl }];
    else if (url.endsWith("/login")) value = `<html data-dpl-id="${loginId}"></html>`;
    else throw new Error("unexpected URL");
    const body = typeof value === "string" ? value : JSON.stringify(value);
    return new Response(body, { status: 200 });
  };
}

test("deployment parity requires all production identifiers to agree", async () => {
  const result = await collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: fakeFetch(),
  });
  assert.equal(result.mainSha, sha);
  assert.equal(result.deploymentId, id);
});

test("deployment mismatch and not-ready states fail closed", async () => {
  await assert.rejects(
    collectRemoteDeployment({ token: "x".repeat(30), fetchImpl: fakeFetch({ loginId: "dpl_12345678" }) }),
    /production_parity_mismatch/u,
  );
  await assert.rejects(
    collectRemoteDeployment({ token: "x".repeat(30), fetchImpl: fakeFetch({ readyState: "BUILDING" }) }),
    /vercel_deployment_invalid/u,
  );
});

test("log queries discard content and reject truncated results", async () => {
  const invocations = [];
  const result = await collectRemoteLogs({
    deploymentId: id,
    token: "x".repeat(30),
    runCommand: async (command, args) => {
      assert.equal(command, fileURLToPath(new URL("./node_modules/.bin/vercel", import.meta.url)));
      invocations.push(args);
      return { stdout: '{"message":"private content"}\n' };
    },
  });
  assert.deepEqual(Object.values(result.queries).map(({ count }) => count), [1, 1, 1, 1]);
  assert.deepEqual(Object.values(result.historicalQueries).map(({ count }) => count), [0, 0, 0, 0]);
  assert.equal(result.logScope, "project_production_split_by_current_deployment");
  assert.equal(JSON.stringify(result).includes("private content"), false);
  assert.equal(invocations.length, 8);
  for (const [index, args] of invocations.entries()) {
    assert.equal(args[0], "logs");
    assert.equal(args.includes(id), false, "current deployment must not narrow the 24-hour log window");
    assert.equal(args.includes(`--deployment=${id}`), index % 2 === 1);
    assert.ok(args.includes("--environment=production"));
    assert.equal(args.some((arg) => arg.startsWith("--branch")), false);
    assert.ok(args.some((arg) => arg.startsWith("--since=202")));
    assert.ok(args.some((arg) => arg.startsWith("--until=202")));
    assert.ok(args.includes("--project=yutakasa-tapping-coach"));
  }
  assert.equal(new Set(invocations.map((args) => args.find((arg) => arg.startsWith("--since=")))).size, 1);
  assert.equal(new Set(invocations.map((args) => args.find((arg) => arg.startsWith("--until=")))).size, 1);
  assert.equal(parseBoundedLogQuery("{}\n".repeat(100)).truncated, true);
  await assert.rejects(
    collectRemoteLogs({
      deploymentId: id,
      token: "x".repeat(30),
      runCommand: async () => ({ stdout: "{}\n".repeat(100) }),
    }),
    /log_fiveXx_project_truncated/u,
  );
  await assert.rejects(collectRemoteLogs({
    deploymentId: id,
    token: "x".repeat(30),
    runCommand: async (_command, _args, options) => {
      assert.equal(options.timeout, 90_000);
      throw Object.assign(new Error("private CLI output must stay private"), { killed: true });
    },
  }), /log_fiveXx_project_query_timeout/u);
});

test("repair observations read only the current deployment after merge", async () => {
  const argsSeen = [];
  const result = await collectRemoteLogs({
    deploymentId: id,
    token: "x".repeat(30),
    deploymentOnly: true,
    since: "2026-09-16T20:00:00.000Z",
    runCommand: async (_command, args) => {
      argsSeen.push(args);
      return { stdout: "" };
    },
  });
  assert.equal(argsSeen.length, 4);
  assert.equal(result.logScope, "deployment_post_merge");
  assert.equal(result.since, "2026-09-16T20:00:00.000Z");
  for (const args of argsSeen) {
    assert.ok(args.includes(`--deployment=${id}`));
    assert.ok(args.includes("--since=2026-09-16T20:00:00.000Z"));
  }
});

test("older deployment errors are counted separately from current deployment errors", async () => {
  const result = await collectRemoteLogs({
    deploymentId: id, token: "x".repeat(30),
    runCommand: async (_command, args) => ({
      stdout: args.includes(`--deployment=${id}`)
        ? '{"message":"current private log"}\n'
        : '{"message":"old private log"}\n{"message":"current private log"}\n',
    }),
  });
  assert.equal(result.queries.fiveXx.count, 1);
  assert.equal(result.historicalQueries.fiveXx.count, 1);
  assert.equal(JSON.stringify(result).includes("private log"), false);
  await assert.rejects(collectRemoteLogs({
    deploymentId: id, token: "x".repeat(30),
    runCommand: async (_command, args) => ({
      stdout: args.includes(`--deployment=${id}`) ? '{}\n' : '',
    }),
  }), /log_fiveXx_scope_inconsistent/u);
});

test("only the known disabled-reply probe is excluded from 5xx counts", async () => {
  const probeLine = `${JSON.stringify(knownDisabledReplyProbe)}\n`;
  assert.deepEqual(parseBoundedLogQuery(probeLine, { filterName: "fiveXx" }), {
    count: 0, truncated: false,
  });
  assert.equal(parseBoundedLogQuery(probeLine, { filterName: "levelError" }).count, 1);
  for (const [field, changed] of [
    ["id", "another-event"],
    ["timestamp", knownDisabledReplyProbe.timestamp + 1],
    ["deploymentId", id],
    ["requestMethod", "GET"],
    ["requestPath", "/api/other"],
    ["responseStatusCode", 503],
    ["source", "edge"],
    ["level", "error"],
  ]) {
    const line = `${JSON.stringify({ ...knownDisabledReplyProbe, [field]: changed })}\n`;
    assert.equal(parseBoundedLogQuery(line, { filterName: "fiveXx" }).count, 1, field);
  }
  assert.equal(parseBoundedLogQuery(
    probeLine + "{}\n".repeat(99), { filterName: "fiveXx" },
  ).truncated, true, "the raw 100-row limit must not be hidden by an exclusion");
  assert.throws(
    () => parseBoundedLogQuery(probeLine.repeat(2), { filterName: "fiveXx" }),
    /known_reply_probe_duplicate/u,
  );

  const newFailure = JSON.stringify({
    ...knownDisabledReplyProbe, id: "new-503", deploymentId: id, responseStatusCode: 503,
  });
  const result = await collectRemoteLogs({
    deploymentId: knownDisabledReplyProbe.deploymentId,
    token: "x".repeat(30),
    runCommand: async (_command, args) => ({
      stdout: args.includes("--status-code=5xx")
        ? args.includes(`--deployment=${knownDisabledReplyProbe.deploymentId}`)
          ? probeLine
          : `${probeLine}${newFailure}\n`
        : "",
    }),
  });
  assert.equal(result.queries.fiveXx.count, 0);
  assert.equal(result.historicalQueries.fiveXx.count, 1);
});

test("a bounded successful Gemini retry is not treated as a production failure", async () => {
  const line = `${JSON.stringify(benignGeminiRetry)}\n`;
  assert.deepEqual(parseBoundedLogQuery(line, { filterName: "gemini" }), {
    count: 0, truncated: false,
  });
  const secondAttempt = {
    ...benignGeminiRetry,
    logs: [benignGeminiRetry.logs[0], {
      level: "warn",
      message: "Retrying Gemini generation before response started: { attempt: 2, nextAttempt: 3, delayMs: 1200 }",
    }],
  };
  assert.equal(parseBoundedLogQuery(`${JSON.stringify(secondAttempt)}\n`, { filterName: "gemini" }).count, 0);
  assert.equal(parseBoundedLogQuery(line, { filterName: "levelError" }).count, 1);
  assert.equal(parseBoundedLogQuery(line, { filterName: "timeout" }).count, 1);
  const result = await collectRemoteLogs({
    deploymentId: id,
    token: "x".repeat(30),
    runCommand: async (_command, args) => ({
      stdout: args.includes("--query=gemini") && !args.includes(`--deployment=${id}`)
        ? line
        : "",
    }),
  });
  assert.equal(result.queries.gemini.count, 0);
  assert.equal(result.historicalQueries.gemini.count, 0);
});

test("Gemini retry exemption fails closed on any changed request or failure signal", () => {
  const changes = [
    ["responseStatusCode", 500],
    ["responseStatusCode", 206],
    ["responseStatusCode", "200"],
    ["requestPath", "/api/other"],
    ["requestMethod", "GET"],
    ["source", "edge"],
    ["level", "error"],
    ["environment", "preview"],
    ["branch", "other"],
    ["projectId", "another-project"],
    ["message", "Gemini streaming error"],
    ["logs", [{ level: "error", message: "Gemini streaming error" }]],
    ["logs", [...benignGeminiRetry.logs, { level: "error", message: "Gemini streaming error" }]],
    ["logs", [{ level: "info", message: "Gemini timeout" }, benignGeminiRetry.logs[1]]],
    ["logs", [benignGeminiRetry.logs[0], { level: "warn", message: "Gemini streaming error" }]],
    ["logs", [benignGeminiRetry.logs[0], { level: "warn", message: `${benignGeminiRetry.logs[1].message} Gemini timeout` }]],
    ["logs", [benignGeminiRetry.logs[0], { level: "warn", message: "Retrying Gemini generation before response started: { attempt: 1, nextAttempt: 2, delayMs: 1200 }" }]],
    ["logs", [benignGeminiRetry.logs[0], { level: "warn", message: "Retrying Gemini generation before response started: { attempt: 1, nextAttempt: 2, delayMs: 400 }\nGemini streaming error" }]],
  ];
  for (const [field, changed] of changes) {
    const line = `${JSON.stringify({ ...benignGeminiRetry, [field]: changed })}\n`;
    assert.equal(parseBoundedLogQuery(line, { filterName: "gemini" }).count, 1, field);
  }
  assert.equal(parseBoundedLogQuery('{}\n', { filterName: "gemini" }).count, 1);
  assert.equal(parseBoundedLogQuery(`${JSON.stringify({ ...benignGeminiRetry, unknown: true })}\n`, {
    filterName: "gemini",
  }).count, 1);
  assert.equal(parseBoundedLogQuery(
    `${JSON.stringify(benignGeminiRetry)}\n`.repeat(100), { filterName: "gemini" },
  ).truncated, true);
  assert.throws(() => parseBoundedLogQuery('{invalid\n', { filterName: "gemini" }), /log_json_invalid/u);
});
