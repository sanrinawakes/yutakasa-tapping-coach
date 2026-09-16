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
  const response = await fetchImpl("https://api.openai.com/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "OpenAI-Project": project,
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => fail("openai_project_probe_failed"));
  // The project association is established when the key is created in the
  // capped project and its fingerprint is recorded. OpenAI-Project selects
  // the intended project for legacy user keys; the API does not document a
  // project-identifying response header.
  if (response.status !== 200) {
    fail("openai_project_probe_unconfirmed");
  }
  await response.body?.cancel?.().catch(() => {});
  return { projectConfirmed: true };
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
