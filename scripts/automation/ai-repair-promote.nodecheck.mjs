import assert from "node:assert/strict";
import test from "node:test";

import { AiRepairPromoteError, checkCandidate, promoteAiRepair } from "./ai-repair-promote.mjs";

const SHA = "a".repeat(40);
const BRANCH = "codex/yutakasa-ai-repair-0123456789abcdef";
const PR = {
  number: 42, state: "open", draft: true, mergeable: true, mergeable_state: "draft",
  changed_files: 2, base: { ref: "main", sha: "b".repeat(40) },
  head: { sha: SHA, ref: BRANCH, repo: { full_name: "sanrinawakes/yutakasa-tapping-coach" } },
};
const FILES = [
  { filename: "src/lib/gemini.ts", status: "modified" },
  { filename: "src/lib/gemini.retry.test.ts", status: "modified" },
];
const RUNS = Object.fromEntries(
  ["source-repair-ci.yml", "ai-repair-independent-review.yml"].map((workflow, index) => [
    workflow,
    [{ id: index + 1, head_sha: SHA, head_branch: BRANCH, event: "pull_request",
      path: `.github/workflows/${workflow}`, status: "completed", conclusion: "success" }],
  ]),
);

test("promotion requires approved source CI and separate review on exact PR head", () => {
  assert.deepEqual(checkCandidate({ pr: PR, files: FILES, runsByWorkflow: RUNS, expectedSha: SHA, mainSha: "b".repeat(40) }), {
    prNumber: 42, headSha: SHA,
  });
  for (const invalid of [
    { pr: { ...PR, head: { ...PR.head, sha: "b".repeat(40) } }, files: FILES, runsByWorkflow: RUNS },
    { pr: { ...PR, base: { ref: "other" } }, files: FILES, runsByWorkflow: RUNS },
    { pr: PR, files: [FILES[0], { filename: ".github/workflows/ai-repair.yml", status: "modified" }], runsByWorkflow: RUNS },
    { pr: PR, files: FILES, runsByWorkflow: { ...RUNS, "source-repair-ci.yml": [{ ...RUNS["source-repair-ci.yml"][0], conclusion: "failure" }] } },
    { pr: PR, files: FILES, runsByWorkflow: { ...RUNS, "ai-repair-independent-review.yml": [{ ...RUNS["ai-repair-independent-review.yml"][0], head_sha: "b".repeat(40) }] } },
  ]) {
    assert.throws(() => checkCandidate({ ...invalid, expectedSha: SHA, mainSha: "b".repeat(40) }), AiRepairPromoteError);
  }
});

test("disabled auto merge never calls GitHub", async () => {
  let calls = 0;
  await assert.rejects(() => promoteAiRepair({
    env: { GITHUB_REPOSITORY: "sanrinawakes/yutakasa-tapping-coach" },
    fetchImpl: async () => { calls += 1; throw new Error("unexpected"); },
  }), AiRepairPromoteError);
  assert.equal(calls, 0);
});

test("unfinished independent review remains pending without a merge", () => {
  assert.throws(
    () => checkCandidate({
      pr: PR, files: FILES,
      runsByWorkflow: { ...RUNS, "ai-repair-independent-review.yml": [] }, expectedSha: SHA, mainSha: "b".repeat(40),
    }),
    (error) => error instanceof AiRepairPromoteError && error.code === "repair_ci_pending",
  );
});
