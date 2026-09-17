#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT = "proj_pXs9WbSC0ttwUUoCCsmcbAUv";
const MODEL = "gpt-5.6-terra";
const MAX_RESPONSE_BYTES = 64 * 1024;

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTerraModel(value) {
  return typeof value === "string" &&
    /^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/u.test(value);
}

async function readBoundedJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function probeTerra({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const result = {
    ok: false,
    http_status: null,
    requested_model: MODEL,
    response_model: null,
    project_attestation_match: false,
    key_fingerprint_match: false,
    usage: null,
  };

  const project = env.YUTAKASA_OPENAI_PROJECT_ID;
  result.project_attestation_match = project === PROJECT &&
    env.YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID === PROJECT &&
    env.YUTAKASA_OPENAI_CAP_CONFIRMED_USD === "20";
  const key = env.YUTAKASA_OPENAI_API_KEY;
  const fingerprint = env.YUTAKASA_OPENAI_KEY_SHA256;
  if (typeof key === "string" && key.length >= 30 && !/[\r\n]/u.test(key) &&
      typeof fingerprint === "string" && /^[a-f0-9]{64}$/u.test(fingerprint)) {
    result.key_fingerprint_match = crypto.timingSafeEqual(
      crypto.createHash("sha256").update(key).digest(),
      Buffer.from(fingerprint, "hex"),
    );
  }
  if (!result.project_attestation_match || !result.key_fingerprint_match) return result;

  let response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "OpenAI-Project": PROJECT,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: "OK",
        max_output_tokens: 128,
        reasoning: { effort: "low" },
        store: false,
        tools: [],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return result;
  }
  result.http_status = response.status;
  if (response.status !== 200) return result;

  const data = await readBoundedJson(response);
  if (data?.status !== "completed" || !isTerraModel(data.model) ||
      !isNonnegativeInteger(data.usage?.input_tokens) ||
      !isNonnegativeInteger(data.usage?.output_tokens) ||
      !isNonnegativeInteger(data.usage?.total_tokens) ||
      data.usage.total_tokens !== data.usage.input_tokens + data.usage.output_tokens) return result;
  result.response_model = data.model;
  result.usage = {
    input_tokens: data.usage.input_tokens,
    output_tokens: data.usage.output_tokens,
    total_tokens: data.usage.total_tokens,
  };
  result.ok = true;
  return result;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  probeTerra().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    },
    () => {
      process.stdout.write(JSON.stringify({
        ok: false, http_status: null, requested_model: MODEL, response_model: null,
        project_attestation_match: false, key_fingerprint_match: false, usage: null,
      }) + "\n");
      process.exitCode = 1;
    },
  );
}
