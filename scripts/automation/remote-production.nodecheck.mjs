import assert from "node:assert/strict";
import test from "node:test";
import {
  collectRemoteDeployment,
  collectRemoteLogs,
  parseBoundedLogQuery,
} from "./remote-production.mjs";

const sha = "9e30bbefd52eb03b67a95dcce7ed2120ee8defaa";
const id = "dpl_CnNGM63s3fmYAsHpe1RhkXqvJru4";
const deploymentUrl = "https://yutakasa-tapping-coach-example.vercel.app";

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
    runCommand: async (_command, args) => {
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
