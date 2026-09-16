import assert from "node:assert/strict";
import test from "node:test";
import { checkReviewCandidate } from "./ai-repair-review-candidate.mjs";

const allowed = [
  { status: "M", path: "src/lib/gemini.ts" },
  { status: "M", path: "src/lib/gemini.retry.test.ts" },
];

test("untrusted PR diff must be source plus regression test in an exact allowlist", () => {
  assert.deepEqual(checkReviewCandidate(allowed), { valid: true });
  for (const files of [
    [allowed[0]],
    [allowed[1], allowed[1]],
    [allowed[0], { status: "M", path: ".github/workflows/ai-repair.yml" }],
    [allowed[0], { status: "A", path: "src/lib/gemini.retry.test.ts" }],
  ]) assert.throws(() => checkReviewCandidate(files));
});
