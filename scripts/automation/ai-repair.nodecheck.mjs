import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AiRepairGateError,
  decideAiRepair,
  existingIncident,
  parseDispatch,
  runAiRepairGate,
  validateCapAttestation,
} from "./ai-repair-gate.mjs";
import {
  AiRepairPublishError,
  fingerprint,
  parseProposal,
  validatePatch,
} from "./ai-repair-publish.mjs";

const deploymentId = "dpl_CnNGM63s3fmYAsHpe1RhkXqvJru4";
const projectId = "proj_S4e8BxvmjNYzpo8EL2bjRPUH";

test("dispatch parser accepts only bounded reason codes and opaque deployment IDs", () => {
  assert.deepEqual(parseDispatch('["production_log_timeout","production_log_timeout"]', deploymentId), {
    reasonCodes: ["production_log_timeout"],
    deploymentId,
  });
  assert.throws(() => parseDispatch('["x\nattack"]', deploymentId), AiRepairGateError);
  assert.throws(() => parseDispatch("[]", deploymentId), AiRepairGateError);
  assert.throws(() => parseDispatch('["production_log_timeout"]', "https://bad.example"), AiRepairGateError);
});

test("$20 project attestation is required before the live recheck", () => {
  validateCapAttestation({
    projectId,
    verifiedProjectId: projectId,
    verifiedUsd: "20",
  });
  assert.throws(
    () => validateCapAttestation({ projectId, verifiedProjectId: projectId, verifiedUsd: "200" }),
    AiRepairGateError,
  );
  assert.throws(
    () => validateCapAttestation({ projectId, verifiedProjectId: "proj_wrong123", verifiedUsd: "20" }),
    AiRepairGateError,
  );
});

test("AI only starts for the same deployment and still present technical anomaly", () => {
  const dispatched = parseDispatch(
    '["pending_tickets","production_log_timeout"]', deploymentId,
  );
  assert.deepEqual(
    decideAiRepair(dispatched, {
      ok: true,
      actionRequired: true,
      deploymentId,
      reasonCodes: ["pending_tickets", "production_log_timeout"],
    }),
    {
      shouldRun: true,
      code: "repairable_anomaly_confirmed",
      reasonCodes: ["production_log_timeout"],
    },
  );
  assert.equal(
    decideAiRepair(dispatched, {
      ok: true, actionRequired: true, deploymentId: "dpl_AnotherDeployment123456", reasonCodes: ["production_log_timeout"],
    }).shouldRun,
    false,
  );
  assert.equal(
    decideAiRepair(dispatched, {
      ok: true, actionRequired: false, deploymentId, reasonCodes: [],
    }).shouldRun,
    false,
  );
  assert.equal(
    decideAiRepair(dispatched, {
      ok: true, actionRequired: true, deploymentId, reasonCodes: ["pending_tickets"],
    }).shouldRun,
    false,
  );
});

test("gate writes only fixed sanitized outputs and does not call AI", async () => {
  const outputs = [];
  const result = await runAiRepairGate({
    env: {
      DISPATCH_REASON_CODES: '["production_log_timeout"]',
      DISPATCH_DEPLOYMENT_ID: deploymentId,
      YUTAKASA_OPENAI_PROJECT_ID: projectId,
      YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID: projectId,
      YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "20",
      GITHUB_OUTPUT: "/unused",
    },
    monitor: async () => ({
      ok: true,
      actionRequired: true,
      deploymentId,
      reasonCodes: ["production_log_timeout"],
    }),
    incidentSearch: async () => false,
    writeOutputs: (_path, value) => outputs.push(value),
  });
  assert.equal(result.shouldRun, true);
  assert.deepEqual(outputs[0].reasonCodes, ["production_log_timeout"]);
});

test("an open or closed PR or issue suppresses another billable investigation", async () => {
  const id = fingerprint(deploymentId, ["production_log_timeout"]);
  let calls = 0;
  const tracked = await existingIncident({
    deploymentId,
    reasonCodes: ["production_log_timeout"],
    token: "example-github-token-long-enough",
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(new URL(url).hostname, "api.github.com");
      assert.ok(!new URL(url).searchParams.get("q").includes("is:open"));
      assert.match(options.headers.Authorization, /^Bearer /u);
      return {
        status: 200,
        json: async () => ({
          total_count: 1,
          items: [{ title: `Yutakasa anomaly ${id}: draft fix` }],
        }),
      };
    },
  });
  assert.equal(tracked, true);
  assert.equal(calls, 1);
  const result = await runAiRepairGate({
    env: {
      DISPATCH_REASON_CODES: '["production_log_timeout"]',
      DISPATCH_DEPLOYMENT_ID: deploymentId,
      YUTAKASA_OPENAI_PROJECT_ID: projectId,
      YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID: projectId,
      YUTAKASA_OPENAI_CAP_CONFIRMED_USD: "20",
      GITHUB_OUTPUT: "/unused",
      GITHUB_TOKEN: "example-github-token-long-enough",
    },
    monitor: async () => ({
      ok: true,
      actionRequired: true,
      deploymentId,
      reasonCodes: ["production_log_timeout"],
    }),
    incidentSearch: async () => true,
    writeOutputs: () => {},
  });
  assert.equal(result.shouldRun, false);
  assert.equal(result.code, "existing_incident");
});

test("proposal schema and size reject arbitrary model output", () => {
  assert.deepEqual(parseProposal('{"summary":"概要","diagnosis":"仮説","patch":""}'), {
    summary: "概要",
    diagnosis: "仮説",
    patch: "",
  });
  assert.throws(() => parseProposal('{"summary":"x","diagnosis":"y","patch":"","command":"rm -rf"}'), AiRepairPublishError);
  assert.throws(() => parseProposal("not json"), AiRepairPublishError);
  assert.throws(() => parseProposal(JSON.stringify({ summary: " ", diagnosis: "x", patch: "" })), AiRepairPublishError);
});

test("patch validation rejects trust-boundary files, symlinks, modes, and creations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-repair-patch-test-"));
  try {
    fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "lib", "gemini.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "src", "lib", "payment-sync.ts"), "export const value = 1;\n");
    fs.symlinkSync("gemini.ts", path.join(root, "src", "lib", "link.ts"));
    const valid = [
      "diff --git a/src/lib/gemini.ts b/src/lib/gemini.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/lib/gemini.ts",
      "+++ b/src/lib/gemini.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    assert.deepEqual(validatePatch(valid, root), ["src/lib/gemini.ts"]);
    assert.throws(() => validatePatch(valid.replaceAll("src/lib/gemini.ts", ".github/workflows/ai-repair.yml"), root), AiRepairPublishError);
    assert.throws(() => validatePatch(valid.replaceAll("src/lib/gemini.ts", "src/lib/link.ts"), root), AiRepairPublishError);
    assert.throws(() => validatePatch(valid.replaceAll("src/lib/gemini.ts", "src/lib/payment-sync.ts"), root), AiRepairPublishError);
    assert.throws(() => validatePatch(valid.replace("index 1234567..abcdef0 100644", "new mode 100755"), root), AiRepairPublishError);
    assert.throws(() => validatePatch(valid.replaceAll("src/lib/gemini.ts", "src/lib/new.ts"), root), AiRepairPublishError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("incident fingerprint is stable across reason code order", () => {
  assert.equal(
    fingerprint(deploymentId, ["production_log_timeout", "orphan_messages"]),
    fingerprint(deploymentId, ["orphan_messages", "production_log_timeout"]),
  );
});
