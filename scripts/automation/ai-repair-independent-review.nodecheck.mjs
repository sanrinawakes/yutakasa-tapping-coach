import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runIndependentReview } from "./ai-repair-independent-review.mjs";

const KEY = "sk-proj-test-" + "x".repeat(40);
const PROJECT = "proj_pXs9WbSC0ttwUUoCCsmcbAUv";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repair-review-test-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "review.diff");
  fs.writeFileSync(file, "diff --git a/src/lib/gemini.ts b/src/lib/gemini.ts\n+const fixed = true;\n", { mode: 0o600 });
  return {
    directory,
    env: {
      BASE_SHA: BASE, AI_REPAIR_HEAD_SHA: HEAD, AI_REPAIR_DIFF_PATH: file,
      YUTAKASA_OPENAI_API_KEY: KEY,
      YUTAKASA_OPENAI_PROJECT_ID: PROJECT,
      YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID: PROJECT,
      YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "20",
      YUTAKASA_OPENAI_KEY_SHA256: crypto.createHash("sha256").update(KEY).digest("hex"),
    },
  };
}

test("review executes trusted code only and never sends API key inside model input", async () => {
  const { directory, env } = setup();
  try {
    const calls = [];
    const result = await runIndependentReview({ env, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Response(JSON.stringify({
        id: "resp_1234567890ABCDEF", status: "completed",
      }), { status: 200 });
      const body = JSON.parse(options.body);
      assert.equal(body.tools.length, 0);
      assert.equal(body.store, false);
      assert.equal(JSON.stringify(body).includes(KEY), false);
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{
          type: "output_text", text: JSON.stringify({ decision: "approve", head_sha: HEAD, findings: [] }),
        }] }],
      }), { status: 200 });
    } });
    assert.deepEqual(result, { approved: true, headSha: HEAD });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers["OpenAI-Project"], PROJECT);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a rejected or incomplete model response cannot pass", async () => {
  const { directory, env } = setup();
  try {
    let calls = 0;
    const fetchImpl = async () => (++calls === 1)
      ? new Response(JSON.stringify({ id: "resp_1234567890ABCDEF", status: "completed" }))
      : new Response(JSON.stringify({ status: "incomplete", output: [] }), { status: 200 });
    await assert.rejects(() => runIndependentReview({ env, fetchImpl }));
    fs.chmodSync(env.AI_REPAIR_DIFF_PATH, 0o644);
    await assert.rejects(() => runIndependentReview({ env, fetchImpl }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
