import crypto from "node:crypto";

const RPC_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9_]{0,127}$/u;
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export class MonitorLedgerError extends Error {
  constructor(code) {
    super(code);
    this.name = "MonitorLedgerError";
    this.code = code;
  }
}

function fail(code) {
  throw new MonitorLedgerError(code);
}

function checkedConfig(secrets) {
  let url;
  try {
    url = new URL(secrets?.SUPABASE_URL);
  } catch {
    fail("monitor_ledger_config_invalid");
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash ||
    !/^[a-z0-9-]+\.supabase\.co$/u.test(url.hostname) ||
    typeof secrets?.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
    secrets.SUPABASE_SERVICE_ROLE_KEY.length < 20 ||
    /[\r\n]/u.test(secrets.SUPABASE_SERVICE_ROLE_KEY)
  ) fail("monitor_ledger_config_invalid");
  return { baseUrl: url.origin, key: secrets.SUPABASE_SERVICE_ROLE_KEY };
}

async function limitedJson(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > 8192) {
    fail("monitor_ledger_response_invalid");
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail("monitor_ledger_response_invalid");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail("monitor_ledger_response_invalid");
      size += part.value.byteLength;
      if (size > 8192) {
        void reader.cancel().catch(() => {});
        fail("monitor_ledger_response_invalid");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof MonitorLedgerError) throw error;
    fail("monitor_ledger_response_invalid");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("monitor_ledger_response_invalid");
  }
}

async function rpc(config, name, payload, fetchImpl) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(`${config.baseUrl}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: {
            apikey: config.key,
            Authorization: `Bearer ${config.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status !== 200) fail("monitor_ledger_rpc_failed");
        return limitedJson(response);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MonitorLedgerError("monitor_ledger_rpc_timeout"));
        }, RPC_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof MonitorLedgerError) throw error;
    fail("monitor_ledger_rpc_failed");
  } finally {
    clearTimeout(timer);
  }
}

function checkedCount(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail("monitor_ledger_result_invalid");
  return value;
}

function checkedFinish(result) {
  const reasons = result?.reasonCodes;
  if (
    !Array.isArray(reasons) || reasons.length > 32 ||
    reasons.some((code) => typeof code !== "string" || !REASON_CODE.test(code)) ||
    (result?.deploymentId != null && !DEPLOYMENT_ID.test(result.deploymentId))
  ) fail("monitor_ledger_result_invalid");
  const status = result.status;
  const errorCode = result.errorCode ?? null;
  if (
    !["healthy", "action_required", "failed"].includes(status) ||
    (status === "healthy" && (reasons.length !== 0 || errorCode !== null)) ||
    (status === "action_required" && reasons.length === 0) ||
    (status === "failed" && (typeof errorCode !== "string" || !REASON_CODE.test(errorCode)))
  ) fail("monitor_ledger_result_invalid");
  return {
    p_status: status,
    p_reason_codes: [...new Set(reasons)].sort(),
    p_error_code: errorCode,
    p_deployment_id: result.deploymentId ?? null,
    p_queue_start_exact: checkedCount(result.queueStartExact),
    p_queue_final_exact: checkedCount(result.queueFinalExact),
    p_drive_start_count: checkedCount(result.driveStartCount),
    p_drive_final_count: checkedCount(result.driveFinalCount),
    p_alert_dispatched: result.alertDispatched === true,
    p_repair_dispatched: result.repairDispatched === true,
  };
}

export async function acquireMonitorLease({
  secrets = process.env,
  fetchImpl = globalThis.fetch,
  heartbeatMs = HEARTBEAT_MS,
  runId = crypto.randomUUID(),
  kind = "scheduled",
} = {}) {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 60_000 ||
      !["scheduled", "recheck"].includes(kind) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(runId)) {
    fail("monitor_ledger_config_invalid");
  }
  const config = checkedConfig(secrets);
  const acquisition = await rpc(config, "acquire_yutakasa_monitor_run", {
    p_run_id: runId,
    p_run_kind: kind,
  }, fetchImpl);
  if (!Array.isArray(acquisition) || acquisition.length !== 1 ||
      typeof acquisition[0]?.acquired !== "boolean" ||
      !Number.isFinite(Date.parse(acquisition[0]?.lease_expires_at))) {
    fail("monitor_ledger_response_invalid");
  }
  if (!acquisition[0].acquired) fail("monitor_overlap");

  let lost = false;
  let closed = false;
  let inFlight = null;
  const renew = async () => {
    if (lost || closed) fail("monitor_lease_lost");
    try {
      const renewed = await rpc(config, "renew_yutakasa_monitor_run", { p_run_id: runId }, fetchImpl);
      if (renewed !== true) fail("monitor_lease_lost");
    } catch {
      lost = true;
      fail("monitor_lease_lost");
    }
  };
  const timer = setInterval(() => {
    if (inFlight || lost || closed) return;
    inFlight = renew().catch(() => {}).finally(() => { inFlight = null; });
  }, heartbeatMs);
  timer.unref?.();

  const stopHeartbeat = async () => {
    clearInterval(timer);
    if (inFlight) await inFlight;
  };
  return {
    runId,
    async assertActive() {
      if (inFlight) await inFlight;
      await renew();
    },
    async finish(result) {
      await stopHeartbeat();
      if (lost || closed) fail("monitor_lease_lost");
      const payload = checkedFinish(result);
      try {
        const finished = await rpc(config, "finish_yutakasa_monitor_run", {
          p_run_id: runId,
          ...payload,
        }, fetchImpl);
        if (finished !== true) fail("monitor_lease_lost");
        closed = true;
      } catch {
        lost = true;
        fail("monitor_lease_lost");
      }
    },
    async recordDispatch({ alertDispatched = false, repairDispatched = false }) {
      if (kind !== "scheduled" || !closed || lost ||
          ![alertDispatched, repairDispatched].every((value) => typeof value === "boolean") ||
          !(alertDispatched || repairDispatched)) {
        fail("monitor_dispatch_state_invalid");
      }
      const recorded = await rpc(config, "record_yutakasa_monitor_dispatch", {
        p_run_id: runId,
        p_alert_dispatched: alertDispatched,
        p_repair_dispatched: repairDispatched,
      }, fetchImpl);
      if (recorded !== true) fail("monitor_dispatch_record_failed");
    },
    async stop() {
      await stopHeartbeat();
      closed = true;
    },
  };
}
