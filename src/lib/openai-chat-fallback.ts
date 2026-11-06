import "server-only";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_REQUEST_TIMEOUT_MS = 60_000;
const OPENAI_MAX_REQUEST_BYTES = 128 * 1024;
const OPENAI_MAX_RESPONSE_BYTES = 256 * 1024;
const OPENAI_MAX_OUTPUT_CHARS = 32_000;
const OPENAI_MAX_OUTPUT_TOKENS = 4_096;

const FALLBACK_ENABLED_ENV = "YUTAKASA_CHAT_OPENAI_FALLBACK_ENABLED";
const FALLBACK_KEY_ENV = "YUTAKASA_CHAT_OPENAI_API_KEY";
const FALLBACK_PROJECT_ENV = "YUTAKASA_CHAT_OPENAI_PROJECT_ID";
const FALLBACK_MODEL_ENV = "YUTAKASA_CHAT_OPENAI_MODEL";

type OpenAiFallbackFailureReason =
  | "configuration_invalid"
  | "request_too_large"
  | "request_failed"
  | "response_failed"
  | "response_too_large"
  | "response_invalid";

export const OPENAI_CHAT_FALLBACK_FAILED_CODE =
  "openai_chat_fallback_failed";

export class OpenAiChatFallbackError extends Error {
  constructor(readonly reason: OpenAiFallbackFailureReason) {
    super(OPENAI_CHAT_FALLBACK_FAILED_CODE);
    this.name = "OpenAiChatFallbackError";
  }
}

export interface OpenAiChatFallbackMessage {
  role: "user" | "assistant";
  content: string;
}

export type OpenAiChatFallbackResponseFormat =
  | { type: "text" }
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
    };

interface OpenAiChatFallbackInput {
  systemPrompt: string;
  messages: OpenAiChatFallbackMessage[];
  responseFormat: OpenAiChatFallbackResponseFormat;
}

interface OpenAiChatFallbackConfig {
  apiKey: string;
  projectId: string;
  model: string;
}

function fail(reason: OpenAiFallbackFailureReason): never {
  throw new OpenAiChatFallbackError(reason);
}

export function isOpenAiChatFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[FALLBACK_ENABLED_ENV] === "true";
}

function getOpenAiChatFallbackConfig(
  env: NodeJS.ProcessEnv
): OpenAiChatFallbackConfig {
  const apiKey = env[FALLBACK_KEY_ENV];
  const projectId = env[FALLBACK_PROJECT_ENV];
  const model = env[FALLBACK_MODEL_ENV];

  if (
    env[FALLBACK_ENABLED_ENV] !== "true" ||
    typeof apiKey !== "string" ||
    !/^\S{30,512}$/u.test(apiKey) ||
    typeof projectId !== "string" ||
    !/^proj_[A-Za-z0-9_-]{8,100}$/u.test(projectId) ||
    typeof model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,100}$/u.test(model) ||
    apiKey === env.YUTAKASA_OPENAI_API_KEY ||
    projectId === env.YUTAKASA_OPENAI_PROJECT_ID
  ) {
    fail("configuration_invalid");
  }

  return { apiKey, projectId, model };
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) fail("response_invalid");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > OPENAI_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail("response_too_large");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof OpenAiChatFallbackError) throw error;
    fail("response_failed");
  } finally {
    reader.releaseLock();
  }

  return body;
}

function parseOpenAiOutput(rawBody: string): string {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    fail("response_invalid");
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as { status?: unknown }).status !== "completed" ||
    !Array.isArray((body as { output?: unknown }).output)
  ) {
    fail("response_invalid");
  }

  const output = (body as { output: unknown[] }).output;
  let assistantMessageCount = 0;
  let outputText: string | null = null;

  for (const item of output) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      fail("response_invalid");
    }

    const itemType = (item as { type?: unknown }).type;
    if (itemType === "reasoning") {
      continue;
    }
    if (
      itemType !== "message" ||
      (item as { role?: unknown }).role !== "assistant" ||
      !Array.isArray((item as { content?: unknown }).content)
    ) {
      fail("response_invalid");
    }

    assistantMessageCount += 1;
    if (assistantMessageCount !== 1) fail("response_invalid");

    for (const part of (item as { content: unknown[] }).content) {
      if (
        !part ||
        typeof part !== "object" ||
        Array.isArray(part) ||
        (part as { type?: unknown }).type !== "output_text" ||
        typeof (part as { text?: unknown }).text !== "string" ||
        outputText !== null
      ) {
        fail("response_invalid");
      }
      outputText = (part as { text: string }).text;
    }
  }

  if (assistantMessageCount !== 1 || outputText === null) {
    fail("response_invalid");
  }

  const text = outputText.trim();
  if (!text || Array.from(text).length > OPENAI_MAX_OUTPUT_CHARS) {
    fail("response_invalid");
  }
  return text;
}

export async function generateOpenAiChatFallback(
  input: OpenAiChatFallbackInput,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<string> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const config = getOpenAiChatFallbackConfig(env);

  const requestBody = {
    model: config.model,
    store: false,
    tools: [],
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    input: [
      { role: "developer", content: input.systemPrompt },
      ...input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    text:
      input.responseFormat.type === "json_schema"
        ? {
            format: {
              type: "json_schema",
              name: input.responseFormat.name,
              strict: true,
              schema: input.responseFormat.schema,
            },
          }
        : { format: { type: "text" } },
  };
  const serializedBody = JSON.stringify(requestBody);
  if (new TextEncoder().encode(serializedBody).byteLength > OPENAI_MAX_REQUEST_BYTES) {
    fail("request_too_large");
  }

  let response: Response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Project": config.projectId,
      },
      body: serializedBody,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail("request_failed");
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    fail("response_failed");
  }
  return parseOpenAiOutput(await readBoundedResponseBody(response));
}
