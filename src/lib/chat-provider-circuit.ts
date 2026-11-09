export type GeminiAvailabilityReason =
  | "gemini_credits_depleted"
  | "gemini_transient"
  | "gemini_timeout";

type Admission =
  | { attempt: true; epoch: number; probe: boolean }
  | { attempt: false; reason: GeminiAvailabilityReason };

const CREDIT_COOLDOWN_MS = 5 * 60_000;
const TRANSIENT_COOLDOWN_MS = 30_000;

// Warm-worker circuit. A new serverless worker starts closed. The existing
// explicit OpenAI-primary override is the fleet-wide switch for a known outage.
export function createGeminiChatCircuit(now: () => number = () => Date.now()) {
  let epoch = 0;
  let open: {
    reason: GeminiAvailabilityReason;
    retryAt: number;
    probing: boolean;
  } | undefined;

  function trip(reason: GeminiAvailabilityReason) {
    epoch += 1;
    open = {
      reason,
      retryAt: now() + (reason === "gemini_credits_depleted"
        ? CREDIT_COOLDOWN_MS
        : TRANSIENT_COOLDOWN_MS),
      probing: false,
    };
  }

  return {
    admit(): Admission {
      if (!open) return { attempt: true, epoch, probe: false };
      if (open.probing || now() < open.retryAt) {
        return { attempt: false, reason: open.reason };
      }
      open.probing = true;
      return { attempt: true, epoch, probe: true };
    },
    finish(admission: Extract<Admission, { attempt: true }>,
      outcome: "success" | "not_availability_failure" | GeminiAvailabilityReason
    ) {
      if (admission.epoch !== epoch) return;
      if (outcome === "success") {
        if (admission.probe) {
          epoch += 1;
          open = undefined;
        }
      } else if (outcome === "not_availability_failure") {
        // A blocked/invalid answer does not establish recovery or trigger a
        // provider switch for that turn. Let another turn probe after cooldown.
        if (admission.probe && open) trip(open.reason);
      } else {
        trip(outcome);
      }
    },
    reset() {
      epoch += 1;
      open = undefined;
    },
  };
}

export const geminiChatCircuit = createGeminiChatCircuit();
