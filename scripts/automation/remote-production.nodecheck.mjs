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
  assert.equal(result.logScope, "project_production");
  assert.equal(JSON.stringify(result).includes("private content"), false);
  assert.equal(invocations.length, 4);
  for (const args of invocations) {
    assert.equal(args[0], "logs");
    assert.equal(args.includes(id), false, "current deployment must not narrow the 24-hour log window");
    assert.equal(args.some((arg) => arg.startsWith("--deployment")), false);
    assert.ok(args.includes("--environment=production"));
    assert.ok(args.includes("--no-branch"));
    assert.ok(args.includes("--since=24h"));
    assert.ok(args.includes("--project=yutakasa-tapping-coach"));
  }
  assert.equal(parseBoundedLogQuery("{}\n".repeat(100)).truncated, true);
  await assert.rejects(
    collectRemoteLogs({
      deploymentId: id,
      token: "x".repeat(30),
      runCommand: async () => ({ stdout: "{}\n".repeat(100) }),
    }),
    /log_fiveXx_truncated/u,
  );
});
