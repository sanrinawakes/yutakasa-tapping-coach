import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { checkBeforeAfter, checkStagingGate, seedKnownDefect,
  runTerraPatchProposal, runTerraPatchVerification, TerraPatchStagingError,
  validateStagingPatch } from "./ticket-terra-patch-staging.mjs";

const sha = "a".repeat(40);
const baseEnv = { GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach",
  GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_RUN_ID: "123",
  YUTAKASA_TERRA_PATCH_STAGING_ENABLED: "true",
  YUTAKASA_TICKET_REPAIR_ENABLED: "false", YUTAKASA_AUTO_MERGE_ENABLED: "false" };

test("manual, main-only, disabled-production gate rejects unsafe inputs", () => {
  checkStagingGate(baseEnv, sha, "main", true);
  for (const [key, value] of Object.entries({
    GITHUB_EVENT_NAME: "schedule", GITHUB_REF: "refs/heads/feature",
    YUTAKASA_TERRA_PATCH_STAGING_ENABLED: "false",
    YUTAKASA_TICKET_REPAIR_ENABLED: "true", YUTAKASA_AUTO_MERGE_ENABLED: "true",
  })) assert.throws(() => checkStagingGate({ ...baseEnv, [key]: value }, sha, "main", true),
    TerraPatchStagingError);
  assert.throws(() => checkStagingGate(baseEnv, sha, "feature", true), TerraPatchStagingError);
  assert.throws(() => checkStagingGate(baseEnv, sha, "main", false), TerraPatchStagingError);
});

test("seed changes exactly the uncovered title boundary", () => {
  const source = fs.readFileSync("src/lib/chat-thread.ts", "utf8");
  const seeded = seedKnownDefect(source);
  assert.equal(seeded.includes("if (characters.length < AUTO_TITLE_VISIBLE_LENGTH)"), true);
  assert.equal(seeded.replace("if (characters.length < AUTO_TITLE_VISIBLE_LENGTH)",
    "if (characters.length <= AUTO_TITLE_VISIBLE_LENGTH)"), source);
  assert.throws(() => seedKnownDefect(seeded), TerraPatchStagingError);
});

function report(statuses) {
  const rows = statuses.map((status, index) => ({ fullName: `test ${index}`,
    status, failureMessages: status === "failed" ? ["expected boundary"] : [] }));
  return { success: statuses.every((status) => status === "passed"),
    numPendingTests: 0, numTodoTests: 0,
    testResults: [{ assertionResults: rows }] };
}

test("regression proof requires one before failure and all after tests passing", () => {
  const before = report(["failed", ...Array(10).fill("passed")]);
  const after = report(Array(11).fill("passed"));
  assert.deepEqual(checkBeforeAfter(before, after),
    { tests: 11, failuresBefore: 1, failuresAfter: 0 });
  assert.throws(() => checkBeforeAfter(after, after), TerraPatchStagingError);
  assert.throws(() => checkBeforeAfter(report(["failed", "failed", ...Array(9).fill("passed")]),
    after), TerraPatchStagingError);
});

test("publisher validator allows only exact source and test files", () => {
  const root = process.cwd();
  const context = { subject: "二十一文字の表題",
    messages: [{ body: "入力が二十一文字のときだけ末尾に省略記号が付きます。" }] };
  const patch = [
    "diff --git a/src/lib/chat-thread.ts b/src/lib/chat-thread.ts",
    "--- a/src/lib/chat-thread.ts", "+++ b/src/lib/chat-thread.ts",
    "@@ -1 +1 @@", "-old", "+new",
    "diff --git a/src/lib/chat-thread.test.ts b/src/lib/chat-thread.test.ts",
    "--- a/src/lib/chat-thread.test.ts", "+++ b/src/lib/chat-thread.test.ts",
    "@@ -1 +1 @@", "-old", "+test",
  ].join("\n") + "\n";
  assert.equal(validateStagingPatch({ summary: "synthetic", diagnosis: "synthetic", patch },
    root, context).patch, patch);
  assert.throws(() => validateStagingPatch({ summary: "synthetic", diagnosis: "synthetic",
    patch: patch.replace("+test", "+二十一文字") }, root, context));
  assert.throws(() => validateStagingPatch({ summary: "synthetic", diagnosis: "synthetic",
    patch: patch.replaceAll("src/lib/chat-thread.test.ts", "src/app/chat/page.test.tsx") },
  root, context), TerraPatchStagingError);
});

test("the complete investigator path applies a synthetic patch and reproduces its regression offline",
  { timeout: 120_000 }, async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yutakasa-terra-staging-nodecheck-"));
    const checkout = path.join(temp, "checkout");
    const artifact = path.join(temp, "proposal");
    const mainSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const patch = [
      "diff --git a/src/lib/chat-thread.ts b/src/lib/chat-thread.ts",
      "--- a/src/lib/chat-thread.ts", "+++ b/src/lib/chat-thread.ts",
      "@@ -37,7 +37,7 @@ export function createChatTitle(message: string): string {",
      "   if (!normalized) return DEFAULT_CHAT_TITLE;",
      " ",
      "   const characters = Array.from(normalized);",
      "-  if (characters.length < AUTO_TITLE_VISIBLE_LENGTH) return normalized;",
      "+  if (characters.length <= AUTO_TITLE_VISIBLE_LENGTH) return normalized;",
      " ",
      "   return `${characters.slice(0, AUTO_TITLE_VISIBLE_LENGTH).join(\"\")}…`;",
      " }",
      "diff --git a/src/lib/chat-thread.test.ts b/src/lib/chat-thread.test.ts",
      "--- a/src/lib/chat-thread.test.ts", "+++ b/src/lib/chat-thread.test.ts",
      "@@ -17,6 +17,10 @@ describe(\"chat thread helpers\", () => {",
      "     ).toBe(\"仕事への不安について タッピングの進め方を…\");",
      "   });",
      " ",
      "+  it(\"does not abbreviate a title at exactly 21 characters\", () => {",
      "+    expect(createChatTitle(\"あ\".repeat(21))).toBe(\"あ\".repeat(21));",
      "+  });",
      "+",
      "   it(\"uses the default title when the message has no readable text\", () => {",
      "     expect(createChatTitle(\" \\n\\t \")).toBe(DEFAULT_CHAT_TITLE);",
      "   });",
    ].join("\n") + "\n";
    const key = "sk-test-only-" + "k".repeat(32);
    const project = "proj_synthetic123456";
    const env = { ...baseEnv, GITHUB_SHA: mainSha, YUTAKASA_OPENAI_API_KEY: key,
      YUTAKASA_OPENAI_PROJECT_ID: project,
      YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID: project,
      YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "20",
      YUTAKASA_OPENAI_KEY_SHA256: crypto.createHash("sha256").update(key).digest("hex"),
      PATCH_ARTIFACT_DIRECTORY: artifact };
    let calls = 0;
    const fakeOpenAi = async () => {
      calls += 1;
      const data = { id: `resp_synthetic${calls}123456`, model: "gpt-5.6-terra",
        status: "completed", usage: { input_tokens: 100, output_tokens: 100,
          total_tokens: 200 },
        output: calls === 1 ? [] : [{ content: [{ type: "output_text",
          text: JSON.stringify({ summary: "synthetic", diagnosis: "synthetic", patch }) }] }] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    try {
      execFileSync("git", ["worktree", "add", "--detach", checkout, mainSha],
        { stdio: "ignore" });
      const modules = path.join(process.cwd(), "node_modules");
      const checkoutModules = path.join(checkout, "node_modules");
      fs.mkdirSync(checkoutModules);
      for (const name of fs.readdirSync(modules)) {
        fs.symlinkSync(path.join(modules, name), path.join(checkoutModules, name));
      }
      const proposal = await runTerraPatchProposal({ env, root: checkout,
        realFetch: fakeOpenAi });
      assert.equal(calls, 2);
      assert.equal(proposal.phase, "proposal");
      assert.equal(proposal.patchExecuted, false);
      const verifyEnv = { ...baseEnv, GITHUB_SHA: mainSha,
        PATCH_ARTIFACT_DIRECTORY: artifact };
      await assert.rejects(() => runTerraPatchVerification({
        env: { ...verifyEnv, YUTAKASA_OPENAI_API_KEY: key }, root: checkout,
      }), TerraPatchStagingError);
      const artifactPatch = path.join(artifact, "terra-staging.patch");
      fs.appendFileSync(artifactPatch, "\n");
      await assert.rejects(() => runTerraPatchVerification({
        env: verifyEnv, root: checkout,
      }), TerraPatchStagingError);
      fs.writeFileSync(artifactPatch, patch);
      const result = await runTerraPatchVerification({ env: verifyEnv, root: checkout });
      assert.equal(result.ok, true);
      assert.equal(result.phase, "verification");
      assert.equal(result.failuresBefore, 1);
      assert.equal(result.failuresAfter, 0);
      assert.equal(result.syntheticOnly, true);
      assert.equal(result.customerReplySent, false);
      assert.equal(fs.readFileSync(path.join(artifact, "terra-staging.patch"), "utf8"), patch);
    } finally {
      if (fs.existsSync(checkout)) execFileSync("git", ["worktree", "remove", "--force", checkout],
        { stdio: "ignore" });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
