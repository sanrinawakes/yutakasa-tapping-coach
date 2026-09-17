import { RepairDispatchError } from "./dispatch-repair.mjs";

const REPO = "sanrinawakes/yutakasa-tapping-coach";
const WORKFLOW = "ai-repair-observe.yml";
const SHA = /^[a-f0-9]{40}$/u;
const ACTIVE_RUNS = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);
const SLOT_MS = 10 * 60 * 1000;

function fail(code) { throw new RepairDispatchError(code); }

async function readJson(response, maximum, code) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maximum) fail(code);
  const reader = response.body?.getReader?.();
  if (!reader) fail(code);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail(code);
      size += part.value.byteLength;
      if (size > maximum) fail(code);
      chunks.push(Buffer.from(part.value));
    }
  } catch { fail(code); }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { fail(code); }
}

function supabaseSettings(secrets) {
  const base = secrets.SUPABASE_URL;
  const key = secrets.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof base !== "string" || !/^https:\/\/[^/]+$/u.test(base) ||
      typeof key !== "string" || key.length < 20 || /[\r\n]/u.test(key)) {
    fail("repair_observer_configuration_invalid");
  }
  return { base, headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" } };
}

function githubHeaders(secrets) {
  const token = secrets.GITHUB_DISPATCH_TOKEN;
  if (typeof token !== "string" || token.length < 20 || /[\r\n]/u.test(token))
    fail("repair_observer_dispatch_token_invalid");
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28" };
}

async function getJson(fetchImpl, url, headers, maximum, unavailableCode, invalidCode) {
  const response = await fetchImpl(url, { headers, redirect: "error",
    signal: AbortSignal.timeout(15_000) }).catch(() => fail(unavailableCode));
  if (response.status !== 200) fail(unavailableCode);
  return readJson(response, maximum, invalidCode);
}

// A release is due only when an observing PR has no observation in this UTC
// ten-minute slot, or a pending PR has actually merged or reached the stale
// pending-merge deadline. No customer ticket identifiers or text are read.
export async function inspectDueRepairObservations({ secrets = process.env,
  fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("repair_observer_clock_invalid");
  const slot = Math.floor(nowMs / SLOT_MS);
  const { base, headers } = supabaseSettings(secrets);
  const releases = await getJson(fetchImpl,
    `${base}/rest/v1/yutakasa_repair_releases?status=in.(pending_merge,observing)&select=pr_number,head_sha,merge_sha,status,created_at&order=pr_number.desc&limit=6`,
    headers, 4096, "repair_observer_releases_unavailable", "repair_observer_releases_invalid");
  if (!Array.isArray(releases) || releases.length > 5 || releases.some((row) =>
      !Number.isSafeInteger(row?.pr_number) || row.pr_number < 1 ||
      !SHA.test(row?.head_sha ?? "") ||
      !["pending_merge", "observing"].includes(row?.status) ||
      (row.status === "pending_merge" && row.merge_sha !== null) ||
      (row.status === "observing" && !SHA.test(row.merge_sha ?? "")) ||
      !Number.isFinite(Date.parse(row.created_at ?? ""))) ||
      new Set(releases.map((row) => row.pr_number)).size !== releases.length) {
    fail("repair_observer_releases_invalid");
  }
  if (releases.length === 0) return { slot, dueReleases: 0, due: false };

  const observations = await getJson(fetchImpl,
    `${base}/rest/v1/yutakasa_repair_observations?cron_slot=eq.${slot}&select=pr_number&limit=6`,
    headers, 1024, "repair_observer_observations_unavailable", "repair_observer_observations_invalid");
  if (!Array.isArray(observations) || observations.length > 5 || observations.some((row) =>
      !Number.isSafeInteger(row?.pr_number) || row.pr_number < 1 ||
      Object.keys(row).join(",") !== "pr_number") ||
      new Set(observations.map((row) => row.pr_number)).size !== observations.length) {
    fail("repair_observer_observations_invalid");
  }
  const observed = new Set(observations.map((row) => row.pr_number));
  const pending = releases.filter((row) => row.status === "pending_merge");
  const ghHeaders = pending.length > 0 ? githubHeaders(secrets) : null;
  let dueReleases = releases.filter((row) => row.status === "observing" && !observed.has(row.pr_number)).length;
  for (const release of pending) {
    const pr = await getJson(fetchImpl, `https://api.github.com/repos/${REPO}/pulls/${release.pr_number}`,
      ghHeaders, 128 * 1024, "repair_observer_pr_unavailable", "repair_observer_pr_invalid");
    if (pr?.number !== release.pr_number || pr?.head?.sha !== release.head_sha ||
        pr?.head?.repo?.full_name !== REPO || typeof pr?.state !== "string" ||
        typeof pr?.merged !== "boolean") fail("repair_observer_pr_invalid");
    if (pr.merged || pr.state !== "open" || nowMs - Date.parse(release.created_at) > 30 * 60 * 1000)
      dueReleases += 1;
  }
  return { slot, dueReleases, due: dueReleases > 0 };
}

export async function dispatchDueRepairObservation({ secrets = process.env,
  inspection, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("repair_observer_clock_invalid");
  if (!Number.isSafeInteger(inspection?.slot) || inspection.slot !== Math.floor(nowMs / SLOT_MS) ||
      !Number.isSafeInteger(inspection?.dueReleases) ||
      inspection.dueReleases < 0 || inspection.dueReleases > 5 ||
      inspection.due !== (inspection.dueReleases > 0)) {
    fail("repair_observer_inspection_invalid");
  }
  if (!inspection.due) return { dispatched: 0, alreadyRunning: false };
  const headers = githubHeaders(secrets);
  const base = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}`;
  const runs = await getJson(fetchImpl, `${base}/runs?per_page=20`, headers, 128 * 1024,
    "repair_observer_runs_unavailable", "repair_observer_runs_invalid");
  if (!Array.isArray(runs?.workflow_runs) || runs.workflow_runs.length > 20 ||
      runs.workflow_runs.some((run) => typeof run?.status !== "string" ||
        typeof run?.event !== "string" || typeof run?.head_branch !== "string" ||
        !Number.isFinite(Date.parse(run?.created_at ?? "")) ||
        !Number.isFinite(Date.parse(run?.updated_at ?? "")))) {
    fail("repair_observer_runs_invalid");
  }
  const collision = runs.workflow_runs.some((run) => run.head_branch === "main" &&
    ["schedule", "workflow_dispatch"].includes(run.event) &&
    (ACTIVE_RUNS.has(run.status) || (run.status === "completed" &&
      run.conclusion !== "skipped" &&
      (Math.floor(Date.parse(run.created_at) / SLOT_MS) === inspection.slot ||
       Math.floor(Date.parse(run.updated_at) / SLOT_MS) === inspection.slot))));
  if (collision) return { dispatched: 0, alreadyRunning: true };
  const response = await fetchImpl(`${base}/dispatches`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { mode: "observe" } }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => fail("repair_observer_dispatch_uncertain"));
  if (response.status !== 204) fail("repair_observer_dispatch_http_failure");
  return { dispatched: 1, alreadyRunning: false };
}
