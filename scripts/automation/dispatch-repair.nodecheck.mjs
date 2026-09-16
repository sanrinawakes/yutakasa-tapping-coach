import assert from "node:assert/strict";
import test from "node:test";

import {
  RepairDispatchError,
  dispatchAlert,
  dispatchRepair,
  validateDispatchInputs,
} from "./dispatch-repair.mjs";

const token = "github_pat_test_1234567890";

test("dispatch inputs are bounded and deduplicated", () => {
  assert.deepEqual(
    validateDispatchInputs({
      token,
      reasonCodes: ["pending_tickets", "production_log_fiveXx", "pending_tickets"],
      deploymentId: "dpl_1234567890ABCDEF",
    }).reasonCodes,
    ["pending_tickets", "production_log_fiveXx"],
  );
  assert.throws(
    () => validateDispatchInputs({ token, reasonCodes: ["ticket content: private"], deploymentId: "unknown" }),
    (error) => error instanceof RepairDispatchError && error.code === "dispatch_reason_codes_invalid",
  );
});

test("dispatch sends only fixed reason codes and an opaque deployment ID", async () => {
  let request;
  const result = await dispatchRepair({
    token,
    reasonCodes: ["pending_tickets"],
    deploymentId: "dpl_1234567890ABCDEF",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { status: 204 };
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.deepEqual(JSON.parse(request.options.body), {
    ref: "main",
    inputs: {
      reason_codes: '["pending_tickets"]',
      deployment_id: "dpl_1234567890ABCDEF",
    },
  });
  assert.ok(!request.options.body.includes(token));
});

test("dispatch fails closed on non-204 status or network error", async () => {
  await assert.rejects(
    dispatchRepair({ token, reasonCodes: ["pending_tickets"], fetchImpl: async () => ({ status: 200 }) }),
    (error) => error.code === "dispatch_http_failure",
  );
  await assert.rejects(
    dispatchRepair({ token, reasonCodes: ["pending_tickets"], fetchImpl: async () => { throw new Error("network"); } }),
    (error) => error.code === "dispatch_request_failed",
  );
});

test("alert dispatch uses its own workflow for an unknown deployment", async () => {
  let requested;
  await dispatchAlert({
    token,
    reasonCodes: ["remote_monitor_failure"],
    deploymentId: "unknown",
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return { status: 204 };
    },
  });
  assert.ok(requested.url.endsWith("/monitor-alert.yml/dispatches"));
  assert.equal(JSON.parse(requested.options.body).inputs.deployment_id, "unknown");
});
