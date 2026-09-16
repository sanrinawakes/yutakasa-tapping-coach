import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { attestOpenAiProject } from "./openai-project-attest.mjs";

const key = "sk-proj-test-" + "x".repeat(40);
const project = "proj_pXs9WbSC0ttwUUoCCsmcbAUv";
const env = {
  YUTAKASA_OPENAI_API_KEY: key,
  YUTAKASA_OPENAI_PROJECT_ID: project,
  YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID: project,
  YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "20",
};

test("manual attestation reveals only a digest after a completed capped-project probe", async () => {
  const result = await attestOpenAiProject({ env, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.headers["OpenAI-Project"], project);
    assert.equal(JSON.stringify(options.body).includes(key), false);
    return new Response(JSON.stringify({ id: "resp_1234567890ABCDEF", status: "completed" }));
  } });
  assert.equal(result.key_sha256, crypto.createHash("sha256").update(key).digest("hex"));
  assert.equal(JSON.stringify(result).includes(key), false);
  await assert.rejects(() => attestOpenAiProject({
    env: { ...env, YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "100" },
    fetchImpl: async () => { throw new Error("must not probe"); },
  }));
});
