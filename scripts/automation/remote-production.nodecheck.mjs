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
const secondGeminiRetry = Object.freeze({
  level: "warn",
  message: "Retrying Gemini generation before response started: { attempt: 2, nextAttempt: 3, delayMs: 1200 }",
});
const benignGeminiFallbackRecovery = Object.freeze({
  ...benignGeminiRetry,
  logs: [
    ...benignGeminiRetry.logs,
    secondGeminiRetry,
    {
      level: "warn",
      message: "Recovered Gemini response with plain-text fallback after validation failures.",
    },
  ],
});

function fakeFetch({
  loginId = id,
  readyState = "READY",
  mainSha = sha,
  commitRef = "main",
} = {}) {
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
      meta: { githubCommitSha: sha, githubCommitRef: commitRef },
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

test("persistent deployment mismatch and terminal states fail closed", async () => {
  const waits = [];
  await assert.rejects(
    collectRemoteDeployment({ token: "x".repeat(30), fetchImpl: fakeFetch({ loginId: "dpl_12345678" }),
      waitImpl: async (milliseconds) => { waits.push(milliseconds); } }),
    /production_parity_mismatch/u,
  );
  assert.deepEqual(waits, [1_000, 15_000, 45_000, 150_000]);
  let terminalWaits = 0;
  await assert.rejects(
    collectRemoteDeployment({ token: "x".repeat(30), fetchImpl: fakeFetch({ readyState: "ERROR" }),
      waitImpl: async () => { terminalWaits += 1; } }),
    /vercel_deployment_invalid/u,
  );
  assert.equal(terminalWaits, 0);
});

test("deployment snapshot retries one transient read and rechecks every identifier", async () => {
  const fetchGood = fakeFetch();
  let mainReads = 0;
  const waits = [];
  const result = await collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/commits/main") && mainReads++ === 0) {
        throw new Error("temporary connection failure");
      }
      return fetchGood(url, options);
    },
    waitImpl: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.deploymentId, id);
  assert.equal(mainReads, 2);
  assert.deepEqual(waits, [1_000]);
});

test("deployment snapshot fails after the bounded transient retry budget", async () => {
  let reads = 0;
  const waits = [];
  await assert.rejects(collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/commits/main")) {
        reads += 1;
        return new Response("unavailable", { status: 503 });
      }
      return fakeFetch()(url, options);
    },
    waitImpl: async (milliseconds) => { waits.push(milliseconds); },
  }), /github_main_http_503/u);
  assert.equal(reads, 5);
  assert.deepEqual(waits, [1_000, 5_000, 15_000, 45_000]);
});

test("deployment convergence retries complete snapshots until parity agrees", async () => {
  const fetchGood = fakeFetch();
  const reads = new Map();
  let attempts = 0;
  const waits = [];
  const result = await collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      const key = url.endsWith("/commits/main") ? "main"
        : url.includes("/deployments?") ? "deployments"
        : url.includes("/v4/aliases/") ? "alias"
        : url.endsWith("/login") ? "login"
        : url.includes("/v13/deployments/") ? "deployment"
        : url.includes("/statuses?") ? "statuses" : "unknown";
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (key === "main") attempts += 1;
      if (key === "login" && attempts < 5) {
        return new Response('<html data-dpl-id="dpl_12345678"></html>', { status: 200 });
      }
      return fetchGood(url, options);
    },
    waitImpl: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.deploymentId, id);
  assert.equal(attempts, 5);
  assert.deepEqual(waits, [1_000, 15_000, 45_000, 150_000]);
  assert.deepEqual(Object.fromEntries(reads), {
    main: 5,
    deployments: 5,
    alias: 5,
    login: 5,
    deployment: 5,
    statuses: 5,
  });
});

test("pending provider deployment states retry but malformed identity fails immediately", async () => {
  const fetchGood = fakeFetch();
  let statusReads = 0;
  const waits = [];
  const result = await collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      if (url.includes("/statuses?") && statusReads++ === 0) {
        return new Response(JSON.stringify([{ state: "pending" }]), { status: 200 });
      }
      return fetchGood(url, options);
    },
    waitImpl: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.ready, true);
  assert.equal(statusReads, 2);
  assert.deepEqual(waits, [1_000]);

  let deploymentReads = 0;
  const deploymentWaits = [];
  const deploymentResult = await collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      if (url.includes("/v13/deployments/") && deploymentReads++ === 0) {
        return fakeFetch({ readyState: "BUILDING" })(url, options);
      }
      return fetchGood(url, options);
    },
    waitImpl: async (milliseconds) => { deploymentWaits.push(milliseconds); },
  });
  assert.equal(deploymentResult.ready, true);
  assert.equal(deploymentReads, 2);
  assert.deepEqual(deploymentWaits, [1_000]);

  let persistentStatusReads = 0;
  const persistentStatusWaits = [];
  await assert.rejects(collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      if (url.includes("/statuses?")) {
        persistentStatusReads += 1;
        return new Response(JSON.stringify([{ state: "pending" }]), { status: 200 });
      }
      return fetchGood(url, options);
    },
    waitImpl: async (milliseconds) => { persistentStatusWaits.push(milliseconds); },
  }), /production_deployment_converging/u);
  assert.equal(persistentStatusReads, 5);
  assert.deepEqual(persistentStatusWaits, [1_000, 15_000, 45_000, 150_000]);

  let invalidWaits = 0;
  await assert.rejects(collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      if (url.includes("/v4/aliases/")) {
        return new Response(JSON.stringify({
          alias: "yutakasa-tapping-coach.vercel.app",
          projectId: "prj_wrong",
          deploymentId: id,
        }), { status: 200 });
      }
      return fetchGood(url, options);
    },
    waitImpl: async () => { invalidWaits += 1; },
  }), /vercel_alias_invalid/u);
  assert.equal(invalidWaits, 0);

  let wrongRefWaits = 0;
  await assert.rejects(collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: fakeFetch({ commitRef: "feature" }),
    waitImpl: async () => { wrongRefWaits += 1; },
  }), /vercel_ref_invalid/u);
  assert.equal(wrongRefWaits, 0);

  let forbiddenWaits = 0;
  await assert.rejects(collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => url.endsWith("/commits/main")
      ? new Response("forbidden", { status: 403 })
      : fetchGood(url, options),
    waitImpl: async () => { forbiddenWaits += 1; },
  }), /github_main_http_403/u);
  assert.equal(forbiddenWaits, 0);

  let invalidShaWaits = 0;
  await assert.rejects(collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: fakeFetch({ mainSha: "invalid" }),
    waitImpl: async () => { invalidShaWaits += 1; },
  }), /github_main_invalid/u);
  assert.equal(invalidShaWaits, 0);
});

test("retry categories share one budget and terminal transitions stop immediately", async () => {
  const fetchGood = fakeFetch();
  let attempts = 0;
  const waits = [];
  const result = await collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/commits/main")) {
        attempts += 1;
        if (attempts === 1) return new Response("unavailable", { status: 503 });
      }
      if (url.endsWith("/login") && attempts === 2) {
        return new Response('<html data-dpl-id="dpl_12345678"></html>', { status: 200 });
      }
      if (url.includes("/statuses?") && attempts === 3) {
        return new Response(JSON.stringify([{ state: "pending" }]), { status: 200 });
      }
      return fetchGood(url, options);
    },
    waitImpl: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.ready, true);
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [1_000, 15_000, 45_000]);

  let deploymentReads = 0;
  const terminalWaits = [];
  await assert.rejects(collectRemoteDeployment({
    token: "x".repeat(30),
    fetchImpl: async (url, options) => {
      if (url.includes("/v13/deployments/")) {
        deploymentReads += 1;
        return fakeFetch({ readyState: deploymentReads === 1 ? "BUILDING" : "ERROR" })(url, options);
      }
      return fetchGood(url, options);
    },
    waitImpl: async (milliseconds) => { terminalWaits.push(milliseconds); },
  }), /vercel_deployment_invalid/u);
  assert.equal(deploymentReads, 2);
  assert.deepEqual(terminalWaits, [1_000]);
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
  let timeoutAttempts = 0;
  const timeoutWaits = [];
  await assert.rejects(collectRemoteLogs({
    deploymentId: id,
    token: "x".repeat(30),
    runCommand: async (_command, _args, options) => {
      assert.equal(options.timeout, 90_000);
      timeoutAttempts += 1;
      throw Object.assign(new Error("private CLI output must stay private"), { killed: true });
    },
    waitImpl: async (milliseconds) => { timeoutWaits.push(milliseconds); },
  }), /log_fiveXx_project_query_timeout/u);
  assert.equal(timeoutAttempts, 2);
  assert.deepEqual(timeoutWaits, [1_000]);
});

test("log queries retry one timeout with the exact same bounded query", async () => {
  const invocations = [];
  const waits = [];
  const result = await collectRemoteLogs({
    deploymentId: id,
    token: "x".repeat(30),
    runCommand: async (_command, args) => {
      invocations.push([...args]);
      if (invocations.length === 1) {
        throw Object.assign(new Error("private CLI output must stay private"), { killed: true });
      }
      return { stdout: "" };
    },
    waitImpl: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.queries.fiveXx.count, 0);
  assert.equal(invocations.length, 9);
  assert.deepEqual(invocations[0], invocations[1]);
  assert.deepEqual(waits, [1_000]);
});

test("log queries do not retry non-timeout command failures", async () => {
  let attempts = 0;
  let waits = 0;
  await assert.rejects(collectRemoteLogs({
    deploymentId: id,
    token: "x".repeat(30),
    runCommand: async () => {
      attempts += 1;
      throw new Error("private CLI output must stay private");
    },
    waitImpl: async () => { waits += 1; },
  }), /log_fiveXx_project_query_failed/u);
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
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

test("two bounded retries and an exact successful fallback are not treated as a failure", () => {
  const structuredThirdAttempt = {
    ...benignGeminiRetry,
    logs: [...benignGeminiRetry.logs, secondGeminiRetry],
  };
  assert.equal(parseBoundedLogQuery(
    `${JSON.stringify(structuredThirdAttempt)}\n`, { filterName: "gemini" },
  ).count, 0);
  assert.equal(parseBoundedLogQuery(
    `${JSON.stringify(benignGeminiFallbackRecovery)}\n`, { filterName: "gemini" },
  ).count, 0);

  for (const [name, logs] of [
    ["missing recovery", benignGeminiFallbackRecovery.logs.slice(0, 3).concat({
      level: "warn", message: "Gemini fallback outcome unknown",
    })],
    ["changed second retry", [
      ...benignGeminiRetry.logs,
      { ...secondGeminiRetry, message: `${secondGeminiRetry.message} changed` },
    ]],
    ["error recovery", [
      ...benignGeminiFallbackRecovery.logs.slice(0, 3),
      { level: "error", message: benignGeminiFallbackRecovery.logs[3].message },
    ]],
    ["extra log", [...benignGeminiFallbackRecovery.logs, {
      level: "warn", message: "unexpected",
    }]],
  ]) {
    const line = `${JSON.stringify({ ...benignGeminiRetry, logs })}\n`;
    assert.equal(parseBoundedLogQuery(line, { filterName: "gemini" }).count, 1, name);
  }
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
