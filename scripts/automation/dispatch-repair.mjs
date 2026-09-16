const DISPATCH_BASE =
  "https://api.github.com/repos/sanrinawakes/yutakasa-tapping-coach/actions/workflows";
const TIMEOUT_MS = 15_000;
const ALLOWED_REASON = /^[A-Za-z0-9_]+$/u;

export class RepairDispatchError extends Error {
  constructor(code) {
    super(code);
    this.name = "RepairDispatchError";
    this.code = code;
  }
}

function fail(code) {
  throw new RepairDispatchError(code);
}

export function validateDispatchInputs({ token, reasonCodes, deploymentId }) {
  if (typeof token !== "string" || token.length < 20 || /[\r\n]/u.test(token)) {
    fail("dispatch_token_missing_or_invalid");
  }
  if (
    !Array.isArray(reasonCodes) ||
    reasonCodes.length < 1 ||
    reasonCodes.length > 20 ||
    reasonCodes.some((code) => typeof code !== "string" || !ALLOWED_REASON.test(code))
  ) {
    fail("dispatch_reason_codes_invalid");
  }
  if (
    typeof deploymentId !== "string" ||
    (deploymentId !== "unknown" && !/^dpl_[A-Za-z0-9]{10,64}$/u.test(deploymentId))
  ) {
    fail("dispatch_deployment_id_invalid");
  }
  return {
    reasonCodes: [...new Set(reasonCodes)].sort(),
    deploymentId,
  };
}

async function dispatchWorkflow({
  workflow,
  token,
  reasonCodes,
  deploymentId = "unknown",
  fetchImpl = globalThis.fetch,
}) {
  const validated = validateDispatchInputs({ token, reasonCodes, deploymentId });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${DISPATCH_BASE}/${workflow}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          reason_codes: JSON.stringify(validated.reasonCodes),
          deployment_id: validated.deploymentId,
        },
      }),
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 204) fail("dispatch_http_failure");
    return { accepted: true, reasonCodes: validated.reasonCodes };
  } catch (error) {
    if (error instanceof RepairDispatchError) throw error;
    fail("dispatch_request_failed");
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchRepair(options) {
  return dispatchWorkflow({ ...options, workflow: "ai-repair.yml" });
}

export async function dispatchAlert(options) {
  return dispatchWorkflow({ ...options, workflow: "monitor-alert.yml" });
}
