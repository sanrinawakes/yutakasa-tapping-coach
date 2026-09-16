import assert from "node:assert/strict";
import test from "node:test";

import { acquireMonitorLease, MonitorLedgerError } from "./monitor-ledger.mjs";
import { runLeasedMonitor } from "./remote-monitor.mjs";

const secrets = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "private-service-role-key-for-test",
  GITHUB_DISPATCH_TOKEN: "private-dispatch-token-for-test",
};
const runId = "11111111-1111-4111-8111-111111111111";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

test("lease acquisition, ownership checks, and finish use only fixed RPC payloads", async () => {
  const names = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, secrets.SUPABASE_URL);
    assert.equal(init.headers.apikey, secrets.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(init.redirect, "error");
    names.push(url.pathname.split("/").at(-1));
    const body = JSON.parse(init.body);
    assert.equal(body.p_run_id, runId);
    if (url.pathname.endsWith("/acquire_yutakasa_monitor_run")) {
      assert.equal(body.p_run_kind, "scheduled");
      return response([{ acquired: true, lease_expires_at: "2026-09-16T20:00:00Z" }]);
    }
    if (url.pathname.endsWith("/renew_yutakasa_monitor_run")) return response(true);
    assert.equal(body.p_status, "action_required");
    assert.deepEqual(body.p_reason_codes, ["pending_tickets"]);
    assert.equal(body.p_queue_start_exact, 2);
    assert.equal(body.p_alert_dispatched, true);
    assert.equal(body.p_repair_dispatched, false);
    return response(true);
  };
  const lease = await acquireMonitorLease({ secrets, fetchImpl, runId });
  await lease.assertActive();
  await lease.finish({
    status: "action_required", reasonCodes: ["pending_tickets"],
    queueStartExact: 2, alertDispatched: true,
  });
  await lease.stop();
  assert.deepEqual(names, [
    "acquire_yutakasa_monitor_run",
    "renew_yutakasa_monitor_run",
    "finish_yutakasa_monitor_run",
  ]);
});

test("active run blocks overlap before monitoring or dispatch", async () => {
  let monitorCalls = 0;
  const fetchImpl = async () => response([{
    acquired: false, lease_expires_at: "2026-09-16T20:00:00Z",
  }]);
  await assert.rejects(
    () => runLeasedMonitor({
      secrets,
      leaseImpl: (options) => acquireMonitorLease({ ...options, fetchImpl, runId }),
      monitorImpl: async () => { monitorCalls += 1; },
      alertImpl: async () => assert.fail("no alert after overlap"),
    }),
    (error) => error instanceof MonitorLedgerError && error.code === "monitor_overlap",
  );
  assert.equal(monitorCalls, 0);
});

test("GitHub dispatch receipt is recorded only after the lease is finished", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const name = new URL(String(input)).pathname.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push(name);
    if (name === "acquire_yutakasa_monitor_run") return response([{ acquired: true, lease_expires_at: "2026-09-16T20:00:00Z" }]);
    if (name === "finish_yutakasa_monitor_run") return response(true);
    if (name === "record_yutakasa_monitor_dispatch") {
      assert.equal(body.p_alert_dispatched, true);
      assert.equal(body.p_repair_dispatched, false);
      return response(true);
    }
    assert.fail(`unexpected RPC ${name}`);
  };
  const lease = await acquireMonitorLease({ secrets, fetchImpl, runId });
  await assert.rejects(() => lease.recordDispatch({ alertDispatched: true }),
    (error) => error.code === "monitor_dispatch_state_invalid");
  await lease.finish({ status: "action_required", reasonCodes: ["pending_tickets"] });
  await lease.recordDispatch({ alertDispatched: true });
  await lease.stop();
  assert.deepEqual(calls, [
    "acquire_yutakasa_monitor_run", "finish_yutakasa_monitor_run",
    "record_yutakasa_monitor_dispatch",
  ]);
});

test("a lost lease rejects the next side effect and never records healthy", async () => {
  const names = [];
  const fetchImpl = async (input) => {
    const name = new URL(String(input)).pathname.split("/").at(-1);
    names.push(name);
    if (name === "acquire_yutakasa_monitor_run") {
      return response([{ acquired: true, lease_expires_at: "2026-09-16T20:00:00Z" }]);
    }
    if (name === "renew_yutakasa_monitor_run") return response(false);
    assert.fail("a lost lease cannot finish healthy");
  };
  const lease = await acquireMonitorLease({ secrets, fetchImpl, runId });
  await assert.rejects(() => lease.assertActive(), (error) => error.code === "monitor_lease_lost");
  await assert.rejects(() => lease.finish({ status: "healthy", reasonCodes: [] }),
    (error) => error.code === "monitor_lease_lost");
  await lease.stop();
  assert.deepEqual(names, ["acquire_yutakasa_monitor_run", "renew_yutakasa_monitor_run"]);
});

test("actionable monitor result dispatches under lease then persists metadata", async () => {
  const events = [];
  const leaseImpl = async () => ({
    assertActive: async () => { events.push("guard"); },
    finish: async (result) => {
      events.push("finish");
      assert.equal(result.status, "action_required");
      assert.deepEqual(result.reasonCodes, ["production_log_fiveXx"]);
      assert.equal(result.alertDispatched, false);
      assert.equal(result.repairDispatched, false);
    },
    stop: async () => { events.push("stop"); },
    recordDispatch: async (flags) => {
      events.push(flags.alertDispatched ? "record-alert" : "record-repair");
    },
  });
  const result = await runLeasedMonitor({
    secrets,
    leaseImpl,
    monitorImpl: async ({ leaseGuard }) => {
      await leaseGuard();
      events.push("monitor");
      return {
        actionRequired: true, reasonCodes: ["production_log_fiveXx"],
        deploymentId: "dpl_123", queueStartExact: 0, queueFinalExact: 0,
        driveStartCount: 0, driveFinalCount: 0,
      };
    },
    alertImpl: async () => { events.push("alert"); },
    repairImpl: async () => { events.push("repair"); },
  });
  assert.equal(result.alertDispatched, true);
  assert.equal(result.repairDispatched, true);
  assert.deepEqual(events, ["guard", "monitor", "finish", "stop", "alert", "record-alert", "repair", "record-repair"]);
});

test("failed observation records a fixed failure and never reports healthy", async () => {
  let saved;
  await assert.rejects(
    () => runLeasedMonitor({
      secrets,
      leaseImpl: async () => ({
        assertActive: async () => {},
        finish: async (value) => { saved = value; },
        stop: async () => {},
        recordDispatch: async () => {},
      }),
      monitorImpl: async () => { throw new Error("private customer text"); },
      alertImpl: async ({ reasonCodes }) => assert.deepEqual(reasonCodes, ["remote_monitor_unexpected_failure"]),
    }),
    /private customer text/u,
  );
  assert.equal(saved.status, "failed");
  assert.deepEqual(saved.reasonCodes, ["remote_monitor_unexpected_failure"]);
  assert.equal(saved.errorCode, "remote_monitor_unexpected_failure");
  assert.equal(JSON.stringify(saved).includes("private customer text"), false);
});
