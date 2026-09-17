import { randomUUID } from "node:crypto";

import { DriveIntakeError } from "./drive-intake.mjs";

const RPC_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT = 1024;
const STATES = new Set([
  "acquired", "busy", "processed", "needs_review", "stale", "revision_conflict",
]);
const FAILURE_CODES = new Set([
  "source_changed", "processing_failed", "external_outcome_unknown",
]);

function fail(code) {
  throw new DriveIntakeError(code);
}

function checkedConfig(secrets) {
  let url;
  try {
    url = new URL(secrets?.SUPABASE_URL);
  } catch {
    fail("drive_intake_ledger_config_invalid");
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash ||
    !/^[a-z0-9-]+\.supabase\.co$/u.test(url.hostname) ||
    typeof secrets?.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
    secrets.SUPABASE_SERVICE_ROLE_KEY.length < 20 ||
    /[\r\n]/u.test(secrets.SUPABASE_SERVICE_ROLE_KEY)
  ) fail("drive_intake_ledger_config_invalid");
  return { baseUrl: url.origin, key: secrets.SUPABASE_SERVICE_ROLE_KEY };
}

function checkedFile(file) {
  if (
    !file || typeof file !== "object" ||
    typeof file.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(file.id) ||
    typeof file.modifiedTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(file.modifiedTime) ||
    !Number.isFinite(Date.parse(file.modifiedTime)) ||
    new Date(file.modifiedTime).toISOString().slice(0, 19) !== file.modifiedTime.slice(0, 19) ||
    (file.version !== undefined && file.version !== null &&
      (typeof file.version !== "string" || !/^[0-9]{1,20}$/u.test(file.version)))
  ) fail("drive_intake_ledger_file_invalid");
  return {
    p_file_id: file.id,
    p_modified_time: new Date(file.modifiedTime).toISOString(),
    p_drive_version: file.version ?? null,
  };
}

function checkedClaimId(claimId) {
  if (typeof claimId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(claimId)) {
    fail("drive_intake_ledger_claim_invalid");
  }
  return claimId;
}

async function boundedJson(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > RESPONSE_LIMIT) {
    fail("drive_intake_ledger_response_invalid");
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    fail("drive_intake_ledger_response_invalid");
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) fail("drive_intake_ledger_response_invalid");
      total += chunk.byteLength;
      if (total > RESPONSE_LIMIT) fail("drive_intake_ledger_response_invalid");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail("drive_intake_ledger_response_invalid");
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
        if (response?.status !== 200) fail("drive_intake_ledger_rpc_failed");
        return boundedJson(response);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DriveIntakeError("drive_intake_ledger_rpc_timeout"));
        }, RPC_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail("drive_intake_ledger_rpc_failed");
  } finally {
    clearTimeout(timer);
  }
}

// This adapter has no entry point. Callers may read content only after an
// acquired claim, and must renew before every external side effect. A failed
// or ambiguous RPC never grants permission to process or retry a file.
export function createDriveIntakeLedger({
  secrets = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = checkedConfig(secrets);
  return {
    async claim(file) {
      const claimId = randomUUID();
      const state = await rpc(config, "claim_yutakasa_drive_intake", {
        ...checkedFile(file), p_claim_id: claimId,
      }, fetchImpl);
      if (!STATES.has(state)) fail("drive_intake_ledger_response_invalid");
      return state === "acquired" ? { state, claimId } : { state };
    },
    async renew(file, claimId) {
      const result = await rpc(config, "renew_yutakasa_drive_intake", {
        ...checkedFile(file), p_claim_id: checkedClaimId(claimId),
      }, fetchImpl);
      if (typeof result !== "boolean") fail("drive_intake_ledger_response_invalid");
      return result;
    },
    async finish(file, claimId, { status, failureCode = null }) {
      if (
        (status !== "processed" && status !== "needs_review") ||
        (status === "processed" && failureCode !== null) ||
        (status === "needs_review" && !FAILURE_CODES.has(failureCode))
      ) fail("drive_intake_ledger_finish_invalid");
      const result = await rpc(config, "finish_yutakasa_drive_intake", {
        ...checkedFile(file), p_claim_id: checkedClaimId(claimId),
        p_status: status, p_failure_code: failureCode,
      }, fetchImpl);
      if (typeof result !== "boolean") fail("drive_intake_ledger_response_invalid");
      return result;
    },
  };
}
