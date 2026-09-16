#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class OpenAiProjectGateError extends Error {
  constructor(code) {
    super(code);
    this.name = "OpenAiProjectGateError";
    this.code = code;
  }
}

function fail(code) {
  throw new OpenAiProjectGateError(code);
}

export async function probeOpenAiProject({ project, key, fetchImpl = globalThis.fetch }) {
  if (typeof project !== "string" || !/^proj_[A-Za-z0-9]{8,80}$/u.test(project) ||
      typeof key !== "string" || key.length < 30 || /[\r\n]/u.test(key)) {
    fail("openai_project_probe_configuration_invalid");
  }
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "OpenAI-Project": project,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-terra",
      input: "Return OK.",
      max_output_tokens: 128,
      reasoning: { effort: "low" },
      store: false,
      tools: [],
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => fail("openai_project_probe_failed"));
  if (response.status !== 200) fail("openai_project_probe_unconfirmed");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 256 * 1024) fail("openai_project_probe_response_large");
  let result;
  try { result = JSON.parse(raw); } catch { fail("openai_project_probe_response_invalid"); }
  if (typeof result?.id !== "string" || !/^resp_[A-Za-z0-9_-]{8,100}$/u.test(result.id) ||
      result.status !== "completed") fail("openai_project_probe_response_invalid");
  return { projectConfirmed: true };
}

export async function verifyOpenAiProjectKey({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const project = env.YUTAKASA_OPENAI_PROJECT_ID;
  const key = env.YUTAKASA_OPENAI_API_KEY;
  const expectedDigest = env.YUTAKASA_OPENAI_KEY_SHA256;
  if (
    typeof project !== "string" || !/^proj_[A-Za-z0-9]{8,80}$/u.test(project) ||
    project !== env.YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID ||
    env.YUTAKASA_OPENAI_CAP_CONFIRMED_USD !== "20" ||
    typeof key !== "string" || key.length < 30 || /[\r\n]/u.test(key) ||
    typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(expectedDigest)
  ) fail("openai_project_key_configuration_invalid");
  const actualDigest = crypto.createHash("sha256").update(key).digest();
  const expected = Buffer.from(expectedDigest, "hex");
  if (!crypto.timingSafeEqual(actualDigest, expected)) fail("openai_project_key_fingerprint_mismatch");
  // The project association is established when the key is created in the
  // capped project and its fingerprint is recorded, or by checking this
  // exact project's key last-used time during the one-time attestation.
  // OpenAI-Project selects that project; no response header identifies it.
  return probeOpenAiProject({ project, key, fetchImpl });
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  verifyOpenAiProjectKey().then(
    () => process.stdout.write('{"ok":true,"code":"project_confirmed"}\n'),
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof OpenAiProjectGateError ? error.code : "project_gate_failed" })}\n`);
      process.exitCode = 1;
    },
  );
}
