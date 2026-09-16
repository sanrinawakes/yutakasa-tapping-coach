#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_PROPOSAL_BYTES = 80 * 1024;
const MAX_PATCH_BYTES = 64 * 1024;
const ALLOWED_SOURCE_FILES = new Set([
  "src/lib/gemini.ts",
  "src/lib/chat-thread.ts",
  "src/app/chat/page.tsx",
  "src/app/chat/layout.tsx",
  "src/app/api/chat/route.ts",
]);
const ALLOWED_TEST_FILES = new Set([
  "src/lib/gemini.retry.test.ts",
  "src/lib/chat-thread.test.ts",
  "src/app/chat/page.test.tsx",
  "src/app/api/chat/route.test.ts",
]);
const FORBIDDEN_PATCH_LINES = /^(?:GIT binary patch|Binary files |literal |delta |old mode |new mode |new file mode |deleted file mode |rename from |rename to |copy from |copy to )/u;
const WORK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export class AiRepairPublishError extends Error {
  constructor(code) {
    super(code);
    this.name = "AiRepairPublishError";
    this.code = code;
  }
}

function fail(code) {
  throw new AiRepairPublishError(code);
}

function boundedText(value, maxLength, code) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  const trimmed = value.trim();
  if (!trimmed) fail(code);
  return trimmed;
}

export function parseProposal(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_PROPOSAL_BYTES) {
    fail("proposal_size_invalid");
  }
  let proposal;
  try {
    proposal = JSON.parse(raw);
  } catch {
    fail("proposal_json_invalid");
  }
  if (
    !proposal ||
    typeof proposal !== "object" ||
    Array.isArray(proposal) ||
    Object.keys(proposal).sort().join(",") !== "diagnosis,patch,summary"
  ) {
    fail("proposal_schema_invalid");
  }
  const summary = boundedText(proposal.summary, 500, "proposal_summary_invalid");
  const diagnosis = boundedText(proposal.diagnosis, 2_000, "proposal_diagnosis_invalid");
  if (typeof proposal.patch !== "string" || Buffer.byteLength(proposal.patch) > MAX_PATCH_BYTES) {
    fail("proposal_patch_size_invalid");
  }
  return { summary, diagnosis, patch: proposal.patch };
}

export function validatePatch(patchText, root = process.cwd()) {
  if (typeof patchText !== "string" || !patchText.startsWith("diff --git ")) {
    fail("patch_format_invalid");
  }
  if (Buffer.byteLength(patchText) > MAX_PATCH_BYTES || patchText.includes("\0")) {
    fail("patch_size_invalid");
  }
  const files = [];
  let current = null;
  let oldHeader = false;
  let newHeader = false;
  let inHunk = false;
  for (const line of patchText.split("\n")) {
    if (!inHunk && FORBIDDEN_PATCH_LINES.test(line)) fail("patch_metadata_forbidden");
    if (line.startsWith("diff --git ")) {
      if (current && (!oldHeader || !newHeader)) fail("patch_header_invalid");
      const match = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(line);
      if (!match || match[1] !== match[2]) fail("patch_path_invalid");
      const file = match[1];
      if (
        (!ALLOWED_SOURCE_FILES.has(file) && !ALLOWED_TEST_FILES.has(file)) ||
        file.split("/").some((component) => component === ".." || component === ".") ||
        files.includes(file)
      ) {
        fail("patch_path_forbidden");
      }
      let stat;
      try {
        stat = fs.lstatSync(path.join(root, file));
      } catch {
        fail("patch_target_missing");
      }
      if (!stat.isFile() || stat.isSymbolicLink()) fail("patch_target_not_regular");
      files.push(file);
      current = file;
      oldHeader = false;
      newHeader = false;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!oldHeader || !newHeader) fail("patch_header_invalid");
      inHunk = true;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      if (!current || line !== `--- a/${current}` || oldHeader) fail("patch_header_invalid");
      oldHeader = true;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      if (!current || line !== `+++ b/${current}` || newHeader) fail("patch_header_invalid");
      newHeader = true;
    }
  }
  if (files.length < 2 || !oldHeader || !newHeader) fail("patch_header_invalid");
  if (!files.some((file) => ALLOWED_SOURCE_FILES.has(file)) ||
      !files.some((file) => ALLOWED_TEST_FILES.has(file))) {
    fail("patch_requires_source_and_regression_test");
  }
  return files;
}

export function fingerprint(deploymentId, reasonCodes) {
  if (
    typeof deploymentId !== "string" ||
    !/^dpl_[A-Za-z0-9]{12,80}$/u.test(deploymentId) ||
    !Array.isArray(reasonCodes) ||
    reasonCodes.length < 1 ||
    reasonCodes.some((code) => typeof code !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/u.test(code))
  ) {
    fail("incident_identity_invalid");
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([deploymentId, [...new Set(reasonCodes)].sort()]))
    .digest("hex")
    .slice(0, 16);
}

function command(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch {
    fail(`command_failed_${binary.replace(/[^A-Za-z0-9]/gu, "_")}`);
  }
}

function checkedGit(commandArgs, options) {
  return command("git", ["-c", "core.hooksPath=/dev/null", ...commandArgs], options);
}

function writePrivateFile(directory, name, content) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

function assertCleanCheckout() {
  if (checkedGit(["status", "--porcelain"])) fail("checkout_not_clean");
  if (checkedGit(["branch", "--show-current"]) !== "main") fail("checkout_not_main");
}

function parseGhJson(raw, code) {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) fail(code);
    return value;
  } catch {
    fail(code);
  }
}

export function runAiRepairPublish(env = process.env) {
  if (env.GITHUB_REPOSITORY !== "sanrinawakes/yutakasa-tapping-coach") {
    fail("repository_invalid");
  }
  if (typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length < 20) {
    fail("github_repair_credential_missing");
  }
  const proposal = parseProposal(env.AI_REPAIR_PROPOSAL);
  const ticketMode = env.AI_REPAIR_TICKET_MODE === "true";
  if (ticketMode && !WORK_ID.test(env.AI_REPAIR_WORK_ID ?? "")) fail("ticket_work_id_invalid");
  const reasonCodes = ticketMode ? [] : JSON.parse(env.AI_REPAIR_REASON_CODES ?? "null");
  const id = ticketMode
    ? crypto.createHash("sha256").update(env.AI_REPAIR_WORK_ID).digest("hex").slice(0, 16)
    : fingerprint(env.AI_REPAIR_DEPLOYMENT_ID, reasonCodes);
  const titlePrefix = ticketMode ? `Yutakasa support repair ${id}` : `Yutakasa anomaly ${id}`;
  const branch = ticketMode
    ? `codex/yutakasa-support-ai-${id}`
    : `codex/yutakasa-ai-repair-${id}`;
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yutakasa-ai-repair-"));
  fs.chmodSync(tempDirectory, 0o700);
  try {
    const body = ticketMode ? [
      `Private support reference: ${id}`,
      "Customer content and identifiers are stored only in the private support database.",
      "This draft is unverified. Do not send a customer reply until the exact release passes production observation.",
    ].join("\n") : [
      `Production deployment: ${env.AI_REPAIR_DEPLOYMENT_ID}`,
      `Reason codes: ${reasonCodes.join(", ")}`,
      "",
      `Summary: ${proposal.summary}`,
      "",
      `Diagnosis: ${proposal.diagnosis}`,
      "",
      "This is an AI investigation. Production cause and repair are not confirmed until CI, review, deployment, and live verification are complete.",
    ].join("\n");
    const bodyFile = writePrivateFile(tempDirectory, "body.md", body);
    const childEnv = { ...process.env };
    delete childEnv.AI_REPAIR_PROPOSAL;
    delete childEnv.AI_REPAIR_REASON_CODES;
    delete childEnv.AI_REPAIR_DEPLOYMENT_ID;

    if (!proposal.patch.trim()) {
      const issues = parseGhJson(
        command("gh", ["issue", "list", "--state", "open", "--search", `${id} in:title`, "--json", "title,url", "--limit", "100"], { env: childEnv }),
        "github_issue_list_invalid",
      );
      if (issues.some((issue) => issue.title === titlePrefix)) {
        return { status: "existing_issue", id };
      }
      command("gh", ["issue", "create", "--title", titlePrefix, "--body-file", bodyFile], { env: childEnv });
      return { status: "issue_created", id };
    }

    assertCleanCheckout();
    const files = validatePatch(proposal.patch);
    const patchFile = writePrivateFile(tempDirectory, "proposal.patch", proposal.patch);
    checkedGit(["apply", "--check", "--whitespace=error", patchFile]);
    checkedGit(["apply", "--whitespace=error", patchFile]);
    checkedGit(["diff", "--check"]);
    for (const file of files) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("patch_target_not_regular_after_apply");
    }
    const changed = checkedGit(["diff", "--name-only", "--no-ext-diff"])
      .split("\n")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(changed) !== JSON.stringify([...files].sort())) {
      fail("patch_changed_files_mismatch");
    }
    const pullRequests = parseGhJson(
      command("gh", ["pr", "list", "--state", "all", "--head", branch, "--json", "headRefName,url", "--limit", "100"], { env: childEnv }),
      "github_pr_list_invalid",
    );
    if (pullRequests.some((pr) => pr.headRefName === branch)) {
      return { status: "existing_pr", id };
    }

    checkedGit(["checkout", "-b", branch]);
    checkedGit(["add", "--", ...files]);
    checkedGit(["diff", "--cached", "--check"]);
    checkedGit([
      "-c", "user.name=yutakasa-ai-repair[bot]",
      "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit", "-m", `Draft AI repair for anomaly ${id}`,
    ]);
    const askPass = writePrivateFile(
      tempDirectory,
      "askpass.sh",
      "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s' x-access-token ;; *Password*) printf '%s' \"$GH_TOKEN\" ;; *) exit 1 ;; esac\n",
    );
    fs.chmodSync(askPass, 0o700);
    const gitEnv = {
      ...childEnv,
      GIT_ASKPASS: askPass,
      GIT_TERMINAL_PROMPT: "0",
    };
    checkedGit([
      "push",
      `https://github.com/${env.GITHUB_REPOSITORY}.git`,
      `HEAD:refs/heads/${branch}`,
    ], { env: gitEnv });
    command("gh", [
      "pr", "create", "--draft", "--base", "main", "--head", branch,
      "--title", ticketMode ? titlePrefix : `${titlePrefix}: ${proposal.summary.slice(0, 80)}`,
      "--body-file", bodyFile,
    ], { env: childEnv });
    return { status: "draft_pr_created", id, branch };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = runAiRepairPublish();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: error instanceof AiRepairPublishError ? error.code : "ai_repair_publish_failed" })}\n`,
    );
    process.exitCode = 1;
  }
}
