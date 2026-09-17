import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  RegressionEvidenceError, checkInputs, checkPullRequest, checkChangedFiles,
  checkTestSource, checkRegressionReports, trustedZeroWidthSpec,
} from "./ticket-repair-regression-evidence.mjs";

const workId = "d56b080a-a505-491a-9569-5ce865e803d7";
const mainSha = "a".repeat(40);
const headSha = "b".repeat(40);
const repository = "sanrinawakes/yutakasa-tapping-coach";
const context = checkInputs({ workId, prNumber: 78,
  scenarioKey: "chat_send_reload_persistence", runId: 450, repository, mainSha });
const marker = `repair-regression:${createHash("sha256").update(workId).digest("hex").slice(0,16)}:chat_send_reload_persistence`;
const pr = { number: 78, state: "open", draft: true,
  base: { ref: "main", sha: mainSha },
  head: { ref: "codex/yutakasa-support-ai-0123456789abcdef", sha: headSha,
    repo: { full_name: repository } } };
const report = (targetStatus, otherStatus = "passed") => {
  const rows = [
    { fullName: `chat page ${marker}`, status: targetStatus,
      failureMessages: targetStatus === "failed" ? ["AssertionError: saved differs from reloaded"] : [] },
    { fullName: "chat page existing behavior", status: otherStatus,
      failureMessages: otherStatus === "failed" ? ["AssertionError: unrelated"] : [] },
  ];
  return { success: rows.every((row) => row.status === "passed"),
    numTotalTests: rows.length, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ assertionResults: rows }] };
};
const rejected = (code) => (error) => error instanceof RegressionEvidenceError && error.code === code;

test("accepts only one pinned technical scenario and opaque work ID", () => {
  assert.equal(context.testFile, "src/app/chat/page.test.tsx");
  assert.equal(checkInputs({ workId, prNumber: 78, scenarioKey: "chat_stream_completion",
    runId: 450, repository, mainSha }).testFile, "src/app/api/chat/route.test.ts");
  assert.equal(checkInputs({ workId, prNumber: 78, scenarioKey: "chat_title_zero_width",
    runId: 450, repository, mainSha }).testFile, "src/lib/chat-thread.test.ts");
  assert.throws(() => checkInputs({ workId, prNumber: 78, scenarioKey: "generic_smoke",
    runId: 450, repository, mainSha }), rejected("regression_inputs_invalid"));
  assert.throws(() => checkInputs({ workId: "customer@example.com", prNumber: 78,
    scenarioKey: "chat_stream_completion", runId: 450, repository, mainSha }),
  rejected("regression_inputs_invalid"));
});

test("the zero-width proof uses a trusted exact assertion and only the two relevant files", () => {
  const zeroWidth = checkInputs({ workId, prNumber: 78, scenarioKey: "chat_title_zero_width",
    runId: 450, repository, mainSha });
  const zeroWidthMarker = `repair-regression:${zeroWidth.fingerprint}:chat_title_zero_width`;
  const source = trustedZeroWidthSpec(zeroWidthMarker);
  assert.match(source, /createChatTitle\("\\u200B"\)/u);
  assert.match(source, /sanitizeChatTitle\("\\u200B"\)/u);
  checkChangedFiles(["src/lib/chat-thread.ts", "src/lib/chat-thread.test.ts"], zeroWidth.testFile);
  assert.throws(() => checkChangedFiles(["src/lib/chat-thread.ts", "src/lib/chat-thread.test.ts",
    "src/app/chat/page.tsx"], zeroWidth.testFile), rejected("regression_diff_invalid"));
  assert.throws(() => trustedZeroWidthSpec("repair-regression:customer-body"),
    rejected("regression_test_marker_invalid"));
});

test("requires current main base and exact draft repair branch", () => {
  assert.equal(checkPullRequest(pr, context), headSha);
  assert.throws(() => checkPullRequest({ ...pr, base: { ref: "main", sha: "c".repeat(40) } }, context),
    rejected("regression_pr_context_invalid"));
  assert.throws(() => checkPullRequest({ ...pr, head: { ...pr.head,
    ref: "attacker/branch" } }, context), rejected("regression_pr_context_invalid"));
});

test("rejects a generic smoke, config change, or missing source change", () => {
  checkChangedFiles(["src/app/chat/page.tsx", "src/app/chat/page.test.tsx"], context.testFile);
  assert.throws(() => checkChangedFiles(["src/app/chat/page.test.tsx"], context.testFile),
    rejected("regression_diff_invalid"));
  assert.throws(() => checkChangedFiles(["src/app/chat/page.tsx", "src/app/chat/page.test.tsx",
    ".github/workflows/ai-repair.yml"], context.testFile), rejected("regression_diff_invalid"));
  assert.throws(() => checkChangedFiles(["src/app/chat/page.tsx",
    "src/app/api/chat/route.test.ts"], context.testFile), rejected("regression_diff_invalid"));
});

test("requires a newly added, unique symptom marker in the regression test", () => {
  const source = `it('${marker}', () => expect(saved).toEqual(reloaded));`;
  assert.match(checkTestSource({ baseSource: "old test", headSource: source, marker }), /^[a-f0-9]{64}$/);
  assert.throws(() => checkTestSource({ baseSource: source, headSource: source + " ", marker }),
    rejected("regression_test_marker_invalid"));
  assert.throws(() => checkTestSource({ baseSource: "old test", headSource: source + source, marker }),
    rejected("regression_test_marker_invalid"));
});

test("accepts only the named baseline failure and full head pass", () => {
  const result = checkRegressionReports({ before: report("failed"), after: report("passed"), marker });
  assert.equal(result.tests, 2);
  assert.notEqual(result.beforeFailureSha256, result.afterSuccessSha256);
  assert.throws(() => checkRegressionReports({ before: report("passed"), after: report("passed"), marker }),
    rejected("regression_not_reproduced_and_fixed"));
  assert.throws(() => checkRegressionReports({ before: report("failed", "failed"),
    after: report("passed"), marker }), rejected("regression_not_reproduced_and_fixed"));
  assert.throws(() => checkRegressionReports({ before: report("failed"),
    after: report("passed", "failed"), marker }), rejected("regression_not_reproduced_and_fixed"));
});

test("rejects skipped tests, changed test identities, and malformed reports", () => {
  const skipped = report("failed");
  skipped.numPendingTests = 1;
  assert.throws(() => checkRegressionReports({ before: skipped, after: report("passed"), marker }),
    rejected("regression_test_report_invalid"));
  const after = report("passed");
  after.testResults[0].assertionResults[1].fullName = "different test";
  assert.throws(() => checkRegressionReports({ before: report("failed"), after, marker }),
    rejected("regression_not_reproduced_and_fixed"));
  const empty = report("failed");
  empty.testResults = [];
  assert.throws(() => checkRegressionReports({ before: empty, after: report("passed"), marker }),
    rejected("regression_test_report_invalid"));
  const noFailureDetail = report("failed");
  noFailureDetail.testResults[0].assertionResults[0].failureMessages = [];
  assert.throws(() => checkRegressionReports({ before: noFailureDetail, after: report("passed"), marker }),
    rejected("regression_not_reproduced_and_fixed"));
});
