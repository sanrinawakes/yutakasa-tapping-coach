import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { OpenAiProjectGateError, verifyOpenAiProjectKey } from "./openai-project-gate.mjs";

const KEY = "sk-proj-test-" + "x".repeat(40);
const PROJECT = "proj_pXs9WbSC0ttwUUoCCsmcbAUv";
const env = {
  YUTAKASA_OPENAI_API_KEY: KEY,
  YUTAKASA_OPENAI_PROJECT_ID: PROJECT,
  YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID: PROJECT,
  YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "20",
  YUTAKASA_OPENAI_KEY_SHA256: crypto.createHash("sha256").update(KEY).digest("hex"),
};

test("project gate binds key fingerprint and provider project before an AI call", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.headers["OpenAI-Project"], PROJECT);
    assert.equal(_url, "https://api.openai.com/v1/responses");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.deepEqual(body.tools, []);
    assert.equal(JSON.stringify(body).includes(KEY), false);
    return new Response(JSON.stringify({ id: "resp_1234567890ABCDEF", status: "completed" }), { status: 200 });
  };
  assert.deepEqual(await verifyOpenAiProjectKey({ env, fetchImpl }), { projectConfirmed: true });
  assert.equal(calls, 1);
  await assert.rejects(() => verifyOpenAiProjectKey({ env: { ...env, YUTAKASA_OPENAI_KEY_SHA256: "0".repeat(64) }, fetchImpl }), OpenAiProjectGateError);
  assert.equal(calls, 1);
  await assert.rejects(() => verifyOpenAiProjectKey({ env, fetchImpl: async () => new Response("{}", { status: 403 }) }), OpenAiProjectGateError);
});
