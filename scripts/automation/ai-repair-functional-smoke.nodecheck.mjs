import assert from "node:assert/strict";
import test from "node:test";

import { FunctionalSmokeError, runProductionFunctionalSmoke } from "./ai-repair-functional-smoke.mjs";

const env = {
  JWT_SECRET: "j".repeat(40),
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "s".repeat(40),
};
const sha = "a".repeat(40);
const release = { merge_sha: sha };
const deployment = { mainSha: sha, deploymentId: "dpl_Abcdefghijklmnop", ready: true };
const id = "11111111-1111-4111-8111-111111111111";

function fakeDatabase({ preexisting = false, deleteFails = false } = {}) {
  let account = null;
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ method: init.method, pathname: url.pathname, query: url.searchParams, body: init.body });
    if (url.pathname === "/rest/v1/chat_threads" || url.pathname === "/rest/v1/otp_codes") {
      return Response.json([]);
    }
    assert.equal(url.pathname, "/rest/v1/subscribers");
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      account = { id, ...body };
      return Response.json([account], { status: 201 });
    }
    if (init.method === "DELETE") {
      assert.equal(url.searchParams.get("id"), `eq.${id}`);
      assert.equal(url.searchParams.get("myasp_data->>smoke_run_id"), `eq.${account.myasp_data.smoke_run_id}`);
      if (deleteFails) return Response.json([]);
      const removed = account;
      account = null;
      return Response.json([{ id: removed.id }]);
    }
    if (preexisting) return Response.json([{ id }]);
    if (url.searchParams.get("email")?.startsWith("like.")) return Response.json([]);
    return Response.json(account ? [account] : []);
  };
  return { fetchImpl, calls, getAccount: () => account };
}

test("missing trusted credentials stop before any production access", async () => {
  let calls = 0;
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env: { ...env, JWT_SECRET: "short" },
    fetchImpl: async () => { calls += 1; throw new Error("unexpected"); },
  }), (error) => error instanceof FunctionalSmokeError && error.code === "smoke_jwt_secret_not_configured");
  assert.equal(calls, 0);
});

test("a pre-existing synthetic identity is never overwritten or deleted", async () => {
  const db = fakeDatabase({ preexisting: true });
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env, fetchImpl: db.fetchImpl,
  }), (error) => error instanceof FunctionalSmokeError && error.code === "smoke_prior_test_data_remaining");
  assert.deepEqual(db.calls.map((call) => call.method), ["GET"]);
});

test("browser failure still deletes and reads back the exact isolated test subscriber", async () => {
  const db = fakeDatabase();
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env, fetchImpl: db.fetchImpl,
    chromiumImpl: { launch: async () => { throw new Error("browser unavailable"); } },
  }), /browser unavailable/u);
  assert.equal(db.getAccount(), null);
  assert.equal(db.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(db.calls.filter((call) => call.method === "DELETE").length, 1);
  const inserted = JSON.parse(db.calls.find((call) => call.method === "POST").body);
  assert.match(inserted.email, /^yutakasa-auto-smoke\+[0-9a-f-]+@example\.invalid$/u);
  assert.equal(inserted.first_payment_date, null);
  assert.equal(inserted.subscription_status, "active");
  assert.equal(inserted.myasp_data.source, "system_monitor_no_payment");
});

test("an unconfirmed cleanup prevents healthy evidence", async () => {
  const db = fakeDatabase({ deleteFails: true });
  await assert.rejects(() => runProductionFunctionalSmoke({
    release, deployment, env, fetchImpl: db.fetchImpl,
    chromiumImpl: { launch: async () => { throw new Error("browser unavailable"); } },
  }), (error) => error instanceof FunctionalSmokeError && error.code === "smoke_cleanup_incomplete");
  assert.notEqual(db.getAccount(), null);
});
