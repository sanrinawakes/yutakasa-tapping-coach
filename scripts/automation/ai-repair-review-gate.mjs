#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import path from "node:path";

const SHA = /^[a-f0-9]{40}$/u;

export class AiRepairReviewError extends Error {
  constructor(code) {
    super(code);
    this.name = "AiRepairReviewError";
    this.code = code;
  }
}

function fail(code) {
  throw new AiRepairReviewError(code);
}

export function verifyIndependentReview(raw, expectedSha) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 16 * 1024 || !SHA.test(expectedSha ?? "")) {
    fail("review_input_invalid");
  }
  let review;
  try {
    review = JSON.parse(raw);
  } catch {
    fail("review_json_invalid");
  }
  if (
    !review || typeof review !== "object" || Array.isArray(review) ||
    Object.keys(review).sort().join(",") !== "decision,findings,head_sha" ||
    !["approve", "reject"].includes(review.decision) ||
    review.head_sha !== expectedSha ||
    !Array.isArray(review.findings) || review.findings.length > 20 ||
    review.findings.some((finding) => typeof finding !== "string" || finding.length < 1 || finding.length > 500)
  ) {
    fail("review_schema_or_head_invalid");
  }
  if (review.decision !== "approve" || review.findings.length !== 0) {
    fail("review_rejected");
  }
  return { approved: true, headSha: expectedSha };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    verifyIndependentReview(process.env.AI_REPAIR_REVIEW, process.env.AI_REPAIR_HEAD_SHA);
    process.stdout.write('{"ok":true,"code":"review_approved"}\n');
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof AiRepairReviewError ? error.code : "review_failed" })}\n`);
    process.exitCode = 1;
  }
}
