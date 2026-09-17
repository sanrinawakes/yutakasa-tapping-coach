import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { probeTerra } from "./openai-terra-probe.mjs";

const key = "sk-proj-test-" + "x".repeat(40);
const project = "proj_pXs9WbSC0ttwUUoCCsmcbAUv";
const env = {
  YUTAKASA_OPENAI_API_KEY: key,
  YUTAKASA_OPENAI_PROJECT_ID: project,
  YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID: project,
  YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "20",
  YUTAKASA_OPENAI_KEY_SHA256: crypto.createHash("sha256").update(key).digest("hex"),
};

function completedResponse(overrides = {}) {
  return new Response(JSON.stringify({
    status: "completed", model: "gpt-5.6-terra",
    usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 },
    output_text: "SECRET GENERATED TEXT",
    ...overrides,
  }), { status: 200 });
}

test("one small Terra request has no tools, storage, or customer content; report omits output and key", async () => {
  let calls = 0;
  const result = await probeTerra({ env, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["OpenAI-Project"], project);
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.redirect, "error");
    const request = JSON.parse(options.body);
    assert.deepEqual(request, {
      model: "gpt-5.6-terra", input: "OK", max_output_tokens: 128,
      reasoning: { effort: "low" }, store: false, tools: [],
    });
    return completedResponse();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: true, http_status: 200, requested_model: "gpt-5.6-terra", response_model: "gpt-5.6-terra",
    project_attestation_match: true, key_fingerprint_match: true,
    usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 },
  });
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(JSON.stringify(result).includes("SECRET GENERATED TEXT"), false);
});

test("wrong project, cap, or key fingerprint fails closed before network access", async () => {
  for (const changed of [
    { YUTAKASA_OPENAI_PROJECT_ID: "proj_wrong12345678" },
    { YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "100" },
    { YUTAKASA_OPENAI_KEY_SHA256: "0".repeat(64) },
    { YUTAKASA_OPENAI_API_KEY: "" },
  ]) {
    const result = await probeTerra({ env: { ...env, ...changed }, fetchImpl: async () => {
      throw new Error("network must not be called");
    } });
    assert.equal(result.ok, false);
    assert.equal(result.http_status, null);
  }
});

test("provider error status never reads or logs the error body", async () => {
  const result = await probeTerra({ env, fetchImpl: async () => new Response(
    "SECRET ERROR BODY", { status: 401 },
  ) });
  assert.equal(result.ok, false);
  assert.equal(result.http_status, 401);
  assert.equal(JSON.stringify(result).includes("SECRET ERROR BODY"), false);
});

test("wrong response model, incomplete result, and invalid usage cannot pass", async () => {
  for (const changed of [
    { model: "another-model" },
    { status: "incomplete" },
    { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 4 } },
  ]) {
    const result = await probeTerra({ env, fetchImpl: async () => completedResponse(changed) });
    assert.equal(result.ok, false);
    assert.equal(result.usage, null);
  }
});

test("a dated Terra snapshot returned for the alias is accepted and reported", async () => {
  const result = await probeTerra({ env, fetchImpl: async () => completedResponse({
    model: "gpt-5.6-terra-2026-09-17",
  }) });
  assert.equal(result.ok, true);
  assert.equal(result.response_model, "gpt-5.6-terra-2026-09-17");
});

test("oversized response and network failure return only bounded status fields", async () => {
  const oversized = await probeTerra({ env, fetchImpl: async () => new Response(
    "x".repeat(64 * 1024 + 1), { status: 200 },
  ) });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.http_status, 200);
  const failed = await probeTerra({ env, fetchImpl: async () => {
    throw new Error("SECRET NETWORK MESSAGE");
  } });
  assert.equal(failed.ok, false);
  assert.equal(failed.http_status, null);
  assert.equal(JSON.stringify(failed).includes("SECRET NETWORK MESSAGE"), false);
});
