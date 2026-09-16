#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { probeOpenAiProject } from "./openai-project-gate.mjs";

export async function attestOpenAiProject({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const project = env.YUTAKASA_OPENAI_PROJECT_ID;
  const key = env.YUTAKASA_OPENAI_API_KEY;
  if (project !== env.YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID ||
      env.YUTAKASA_OPENAI_CAP_CONFIRMED_USD !== "20") {
    throw new Error("cap_attestation_missing");
  }
  await probeOpenAiProject({ project, key, fetchImpl });
  return {
    ok: true, code: "probe_confirmed",
    key_sha256: crypto.createHash("sha256").update(key).digest("hex"),
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  attestOpenAiProject().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => {
      process.stdout.write('{"ok":false,"code":"probe_unconfirmed"}\n');
      process.exitCode = 1;
    },
  );
}
