import assert from "node:assert/strict";
import test from "node:test";

import { AiRepairReviewError, verifyIndependentReview } from "./ai-repair-review-gate.mjs";

const HEAD = "a".repeat(40);

test("independent review accepts only exact SHA, explicit approval, and no findings", () => {
  const approved = JSON.stringify({ decision: "approve", head_sha: HEAD, findings: [] });
  assert.deepEqual(verifyIndependentReview(approved, HEAD), { approved: true, headSha: HEAD });
  for (const invalid of [
    JSON.stringify({ decision: "approve", head_sha: "b".repeat(40), findings: [] }),
    JSON.stringify({ decision: "reject", head_sha: HEAD, findings: [] }),
    JSON.stringify({ decision: "approve", head_sha: HEAD, findings: ["Uncovered failure"] }),
    JSON.stringify({ decision: "approve", head_sha: HEAD, findings: [], extra: true }),
    "not json",
  ]) {
    assert.throws(() => verifyIndependentReview(invalid, HEAD), AiRepairReviewError);
  }
});
