import assert from "node:assert/strict";
import test from "node:test";

import { inspectDueRepairObservations, dispatchDueRepairObservation } from "./repair-observe-dispatch.mjs";

const nowMs = Date.parse("2026-09-17T14:03:00Z");
const slot = Math.floor(nowMs / 600_000);
const secrets = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-private-test-key-12345",
  GITHUB_DISPATCH_TOKEN: "github-dispatch-private-test-token-12345",
};
const sha = "a".repeat(40);

function json(value, status = 200) { return new Response(JSON.stringify(value), { status }); }
function release(status = "observing", created_at = "2026-09-17T13:00:00Z") {
  return { pr_number: 82, head_sha: sha, merge_sha: status === "observing" ? sha : null,
    status, created_at };
}
function pr(state = "open", merged = false) {
  return { number: 82, head: { sha, repo: { full_name: "sanrinawakes/yutakasa-tapping-coach" } },
    state, merged };
}
function run(overrides = {}) {
  return { status: "completed", conclusion: "success", event: "workflow_dispatch",
    head_branch: "main", created_at: "2026-09-17T14:01:00Z",
    updated_at: "2026-09-17T14:02:00Z", ...overrides };
}

test("empty release ledger does not read observations or call GitHub", async () => {
  let calls = 0;
  const inspection = await inspectDueRepairObservations({ secrets, now: () => nowMs,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(url, /yutakasa_repair_releases/u);
      return json([]);
    } });
  assert.deepEqual(inspection, { slot, dueReleases: 0, due: false });
  assert.equal(calls, 1);
  const receipt = await dispatchDueRepairObservation({ secrets, inspection, now: () => nowMs,
    fetchImpl: async () => assert.fail("no GitHub request without due releases") });
  assert.deepEqual(receipt, { dispatched: 0, alreadyRunning: false });
});

test("already observed current slot is not due", async () => {
  const inspection = await inspectDueRepairObservations({ secrets, now: () => nowMs,
    fetchImpl: async (url) => url.includes("yutakasa_repair_releases")
      ? json([release()]) : json([{ pr_number: 82 }]) });
  assert.deepEqual(inspection, { slot, dueReleases: 0, due: false });
});

test("unobserved release is due and dispatch uses fixed main-only input", async () => {
  const inspection = await inspectDueRepairObservations({ secrets, now: () => nowMs,
    fetchImpl: async (url) => url.includes("yutakasa_repair_releases")
      ? json([release()]) : json([]) });
  assert.deepEqual(inspection, { slot, dueReleases: 1, due: true });
  const calls = [];
  const receipt = await dispatchDueRepairObservation({ secrets, inspection, now: () => nowMs,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/runs?per_page=20")) return json({ workflow_runs: [] });
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { ref: "main", inputs: { mode: "observe" } });
      assert.equal(init.headers.Authorization, `Bearer ${secrets.GITHUB_DISPATCH_TOKEN}`);
      return new Response(null, { status: 204 });
    } });
  assert.deepEqual(receipt, { dispatched: 1, alreadyRunning: false });
  assert.equal(calls.length, 2);
});

test("young open PR is not due; merged or stale pending PR is due", async () => {
  for (const [created, state, merged, expected] of [
    ["2026-09-17T13:55:00Z", "open", false, false],
    ["2026-09-17T13:55:00Z", "closed", true, true],
    ["2026-09-17T13:00:00Z", "open", false, true],
  ]) {
    const inspection = await inspectDueRepairObservations({ secrets, now: () => nowMs,
      fetchImpl: async (url) => url.includes("yutakasa_repair_releases")
        ? json([release("pending_merge", created)])
        : url.includes("yutakasa_repair_observations") ? json([]) : json(pr(state, merged)) });
    assert.equal(inspection.due, expected);
  }
});

test("active run and same-slot completion prevent duplicate dispatch", async () => {
  const inspection = { slot, dueReleases: 1, due: true };
  for (const workflowRun of [
    run({ status: "in_progress", conclusion: null,
      created_at: "2026-09-17T13:58:00Z" }),
    run(),
    run({ created_at: "2026-09-17T13:59:00Z",
      updated_at: "2026-09-17T14:01:00Z" }),
  ]) {
    const receipt = await dispatchDueRepairObservation({ secrets, inspection, now: () => nowMs,
      fetchImpl: async (url) => {
        assert.match(url, /\/runs\?/u);
        return json({ workflow_runs: [workflowRun] });
      } });
    assert.deepEqual(receipt, { dispatched: 0, alreadyRunning: true });
  }
});

test("skipped schedule is not mistaken for an observation", async () => {
  const inspection = { slot, dueReleases: 1, due: true };
  let dispatches = 0;
  const receipt = await dispatchDueRepairObservation({ secrets, inspection, now: () => nowMs,
    fetchImpl: async (url) => {
      if (url.includes("/runs?")) return json({ workflow_runs: [run({
        event: "schedule", conclusion: "skipped",
      })] });
      dispatches += 1;
      return new Response(null, { status: 204 });
    } });
  assert.equal(receipt.dispatched, 1);
  assert.equal(dispatches, 1);
});

test("stale inspection and uncertain dispatch fail closed with code-only errors", async () => {
  await assert.rejects(dispatchDueRepairObservation({ secrets,
    inspection: { slot: slot - 1, dueReleases: 1, due: true }, now: () => nowMs }),
  (error) => error.code === "repair_observer_inspection_invalid");
  await assert.rejects(dispatchDueRepairObservation({ secrets,
    inspection: { slot, dueReleases: 1, due: true }, now: () => nowMs,
    fetchImpl: async (url) => url.includes("/runs?")
      ? json({ workflow_runs: [] }) : Promise.reject(new Error("private provider details")) }),
  (error) => error.code === "repair_observer_dispatch_uncertain" &&
    !error.message.includes("private provider details"));
});
