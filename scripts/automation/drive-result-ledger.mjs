import { DriveIntakeError } from "./drive-intake.mjs";

const RPC_TIMEOUT_MS = 10_000;
const JSON_LIMIT = 8192;

function fail(code) {
  throw new DriveIntakeError(code);
}

function checkedConfig(secrets) {
  let url;
  try {
    url = new URL(secrets?.SUPABASE_URL);
  } catch {
    fail("drive_result_ledger_config_invalid");
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash ||
    !/^[a-z0-9-]+\.supabase\.co$/u.test(url.hostname) ||
    typeof secrets?.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
    secrets.SUPABASE_SERVICE_ROLE_KEY.length < 20 ||
    /[\r\n]/u.test(secrets.SUPABASE_SERVICE_ROLE_KEY)
  ) fail("drive_result_ledger_config_invalid");
  return { baseUrl: url.origin, key: secrets.SUPABASE_SERVICE_ROLE_KEY };
}

async function boundedJson(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > JSON_LIMIT) {
    fail("drive_result_ledger_response_invalid");
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    fail("drive_result_ledger_response_invalid");
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) fail("drive_result_ledger_response_invalid");
      total += chunk.byteLength;
      if (total > JSON_LIMIT) fail("drive_result_ledger_response_invalid");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail("drive_result_ledger_response_invalid");
  }
}

async function rpc(config, name, payload, fetchImpl) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(
          `${config.baseUrl}/rest/v1/rpc/${name}`,
          {
            method: "POST",
            headers: {
              apikey: config.key,
              Authorization: `Bearer ${config.key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (response?.status !== 200) fail("drive_result_ledger_rpc_failed");
        return boundedJson(response);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DriveIntakeError("drive_result_ledger_rpc_timeout"));
        }, RPC_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof DriveIntakeError) throw error;
    fail("drive_result_ledger_rpc_failed");
  } finally {
    clearTimeout(timer);
  }
}

export function createDriveResultLedger({
  secrets = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = checkedConfig(secrets);
  return {
    async reserve({ eventId, sha256, name }) {
      const result = await rpc(config, "reserve_yutakasa_drive_result", {
        p_event_id: eventId,
        p_pdf_sha256: sha256,
        p_file_name: name,
      }, fetchImpl);
      if (!["reserved", "pending", "confirmed", "conflict"].includes(result)) {
        fail("drive_result_ledger_response_invalid");
      }
      return result;
    },
    async uncertain({ eventId, sha256 }) {
      const result = await rpc(config, "mark_yutakasa_drive_result_uncertain", {
        p_event_id: eventId,
        p_pdf_sha256: sha256,
      }, fetchImpl);
      if (typeof result !== "boolean") fail("drive_result_ledger_response_invalid");
      return result;
    },
    async confirm({ eventId, sha256, fileId }) {
      const result = await rpc(config, "confirm_yutakasa_drive_result", {
        p_event_id: eventId,
        p_pdf_sha256: sha256,
        p_file_id: fileId,
      }, fetchImpl);
      if (typeof result !== "boolean") fail("drive_result_ledger_response_invalid");
      return result;
    },
  };
}
