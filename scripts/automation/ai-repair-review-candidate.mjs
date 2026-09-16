#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/u;
const SOURCE = new Set([
  "src/lib/gemini.ts", "src/lib/chat-thread.ts", "src/app/chat/page.tsx",
  "src/app/chat/layout.tsx", "src/app/api/chat/route.ts",
]);
const TEST = new Set([
  "src/lib/gemini.retry.test.ts", "src/lib/chat-thread.test.ts",
  "src/app/chat/page.test.tsx", "src/app/api/chat/route.test.ts",
]);

export function checkReviewCandidate(changed) {
  if (!Array.isArray(changed) || changed.length < 2 || changed.length > 20) throw new Error("candidate_files_invalid");
  let hasSource = false;
  let hasTest = false;
  const seen = new Set();
  for (const item of changed) {
    if (item?.status !== "M" || typeof item?.path !== "string" || seen.has(item.path) ||
        (!SOURCE.has(item.path) && !TEST.has(item.path))) throw new Error("candidate_file_forbidden");
    seen.add(item.path);
    hasSource ||= SOURCE.has(item.path);
    hasTest ||= TEST.has(item.path);
  }
  if (!hasSource || !hasTest) throw new Error("candidate_regression_test_missing");
  return { valid: true };
}

export function readReviewCandidate(baseSha, headSha) {
  if (!SHA.test(baseSha ?? "") || !SHA.test(headSha ?? "")) throw new Error("candidate_sha_invalid");
  let changed;
  try {
    const output = execFileSync("git", ["diff", "--no-ext-diff", "--name-status", "-z", baseSha, headSha], {
      encoding: "utf8", maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    const parts = output.split("\0").filter(Boolean);
    if (parts.length % 2 !== 0) throw new Error("candidate_diff_invalid");
    changed = [];
    for (let index = 0; index < parts.length; index += 2) {
      changed.push({ status: parts[index], path: parts[index + 1] });
    }
  } catch {
    throw new Error("candidate_diff_invalid");
  }
  return checkReviewCandidate(changed);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    readReviewCandidate(process.env.BASE_SHA, process.env.HEAD_SHA);
    process.stdout.write('{"ok":true,"code":"candidate_allowed"}\n');
  } catch {
    process.stdout.write('{"ok":false,"code":"candidate_rejected"}\n');
    process.exitCode = 1;
  }
}
