import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";
import { GEMINI_MODEL, SYSTEM_INSTRUCTION } from "./constants";
import {
  resetCourseSearchIndex,
  selectCourseContext,
} from "./course-retrieval";
import {
  enforceOneSentenceResponse,
  isOneSentenceRequest,
  sanitizeAssistantContent,
} from "./chat-thread";
import {
  parseStructuredCoachResponse,
  renderStructuredCoachResponse,
} from "./coach-response";

function getClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }
  return new GoogleGenerativeAI(apiKey);
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_RETRY_DELAYS_MS = [400, 1_200] as const;
const MAX_CONTEXT_USER_MESSAGES = 3;
const MAX_CONTEXT_ASSISTANT_MESSAGES = 1;
const MAX_CONTEXT_TOTAL_CHARS = 2_400;
const MAX_CONTEXT_LATEST_USER_CHARS = 700;
const MAX_CONTEXT_PREVIOUS_USER_CHARS = 240;
const MAX_CONTEXT_ASSISTANT_CHARS = 320;
const DEBT_QUERY_PATTERN = /借金|負債|ローン|返済/u;
const INCOME_WORK_PHRASE = "これでは足りない";
const OBVIOUS_JAPANESE_TYPO_PATTERN = /不不快感/u;
const QUOTED_PHRASE_PATTERN = /「[^」]{1,80}」/gu;
const HISTORY_ENUMERATION_PATTERN =
  /(?:これまでの(?:あなたの)?(?:質問|相談|やり取り|会話)内容|以前の(?:ご)?質問|過去の(?:相談|やり取り))/u;
const HISTORY_REQUEST_PATTERN =
  /(?:以前|過去|前回|さっき|先ほど|続き|その件|今まで|これまで)/u;
const FIRST_ACTION_REQUEST_PATTERN =
  /(?:最初に(?:する|やる|行う)こと|最初の一歩|まず(?:何|なに)を)/u;
const FIRST_ACTION_CONTEXT_PATTERN =
  /^.{0,100}?(?:とき|場合)(?:に|は|には)?、/u;
const FIRST_ACTION_SUFFIX_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/して$/u, "してください。"],
  [/し$/u, "してください。"],
  [/振り返り$/u, "振り返ってください。"],
  [/止まり$/u, "止まってください。"],
  [/選び$/u, "選んでください。"],
  [/呼び$/u, "呼んでください。"],
  [/読み$/u, "読んでください。"],
  [/書き$/u, "書いてください。"],
  [/聞き$/u, "聞いてください。"],
  [/置き$/u, "置いてください。"],
  [/感じ$/u, "感じてください。"],
  [/見$/u, "見てください。"],
  [/(?:認め|受け止め|向け|決め|唱え|つけ|始め)$/u, "$&てください。"],
];
const COACH_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    acknowledgement: {
      type: SchemaType.STRING,
      description:
        "相談内容を具体的に確認する1文（50文字以内）。よく分かります、理解できます、お察ししますは禁止。",
    },
    explanation: {
      type: SchemaType.STRING,
      description:
        "講座の根拠を含む理由の説明（合計160文字以内、2文以内）。練習フレーズは書かない。",
    },
    steps: {
      type: SchemaType.ARRAY,
      maxItems: 3,
      description: "今すぐ実行できる手順。不要な場合は空配列。",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: {
            type: SchemaType.STRING,
            description: "20文字以内の短い見出し。",
          },
          instruction: {
            type: SchemaType.STRING,
            description:
              "120文字以内の具体的な指示を1文で書く。練習フレーズはpracticePhrasesへ分ける。",
          },
        },
        required: ["title", "instruction"],
      },
    },
    practicePhrases: {
      type: SchemaType.ARRAY,
      maxItems: 2,
      description:
        "タッピング中に唱える短いフレーズ。回答に不要なら空配列。",
      items: { type: SchemaType.STRING },
    },
    closing: {
      type: SchemaType.STRING,
      description:
        "必要な場合だけ、60文字以内の締めまたは確認質問を1文で書く。不要なら空文字。",
    },
  },
  required: [
    "acknowledgement",
    "explanation",
    "steps",
    "practicePhrases",
    "closing",
  ],
};

const PLAIN_TEXT_FALLBACK_INSTRUCTION =
  "\n\n構造化JSONの代わりに、利用者へそのまま表示できる本文だけを日本語で返してください。JSON、コードブロック、見出し名のラベル、補足メモは出さないでください。";

export function isRetryableGeminiError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : null;
  if (status !== null && [429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /(?:fetch|network|socket|timeout|timed out|ECONNRESET|503 Service Unavailable)/iu.test(
    message
  );
}

function wait(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isResponseValidationError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "GeminiResponseValidationError"
  );
}

function formatStructuredResponse(
  content: string,
  latestUserMessage: string
): string {
  try {
    const formatted = renderStructuredCoachResponse(
      parseStructuredCoachResponse(content)
    );
    const quotedPhrases = formatted.match(QUOTED_PHRASE_PATTERN) ?? [];
    if (quotedPhrases.length > 2) {
      throw new Error("Structured response quoted too many phrases");
    }
    if (
      HISTORY_ENUMERATION_PATTERN.test(formatted) &&
      !HISTORY_REQUEST_PATTERN.test(latestUserMessage)
    ) {
      throw new Error("Structured response over-relied on prior history");
    }
    if (
      DEBT_QUERY_PATTERN.test(latestUserMessage) &&
      formatted.includes(INCOME_WORK_PHRASE)
    ) {
      throw new Error("Income exercise was misapplied to a debt question");
    }
    return formatted;
  } catch (cause) {
    const error = new Error("Gemini response validation failed", { cause });
    error.name = "GeminiResponseValidationError";
    throw error;
  }
}

function keepOnlyFirstAction(content: string): string {
  const actionContent = content.replace(FIRST_ACTION_CONTEXT_PATTERN, "");
  const firstClause = actionContent.match(/^(.+?)、.+$/u)?.[1]?.trim();
  if (!firstClause) return content;

  for (const [pattern, replacement] of FIRST_ACTION_SUFFIX_REWRITES) {
    if (pattern.test(firstClause)) {
      return firstClause.replace(pattern, replacement);
    }
  }

  return content;
}

function formatOneSentenceResponse(
  content: string,
  latestUserMessage: string
): string {
  try {
    let formatted = enforceOneSentenceResponse(content);
    if (!formatted) {
      throw new Error("One-sentence response was empty");
    }
    if (FIRST_ACTION_REQUEST_PATTERN.test(latestUserMessage)) {
      formatted = keepOnlyFirstAction(formatted);
    }
    if (OBVIOUS_JAPANESE_TYPO_PATTERN.test(formatted)) {
      throw new Error("One-sentence response contained an obvious typo");
    }
    return formatted;
  } catch (cause) {
    const error = new Error("Gemini response validation failed", { cause });
    error.name = "GeminiResponseValidationError";
    throw error;
  }
}

function formatPlainTextFallbackResponse(content: string): string {
  const formatted = sanitizeAssistantContent(content)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!formatted) {
    throw new Error("Plain-text fallback response was empty");
  }
  return formatted;
}

export async function getSystemPrompt(
  messages: ChatMessage[] = []
): Promise<string> {
  const courseContext = selectCourseContext(messages);
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const responseFormatInstruction = isOneSentenceRequest(latestUserMessage)
    ? "\n\n今回の利用者は一文だけの回答を指定しています。相談を言い直す受け止め文は付けず、実質的な回答だけを書いてください。句点「。」は文末の1個だけにしてください。「最初にすること」「まず何をするか」と聞かれた場合は、最初の行動を1つだけ答えてください。「その感情を認め、タッピングを始めてください」のように2つの行動をつなげる回答は禁止です。出力前に誤字と同じ文字の不自然な重複がないか確認してください。"
    : "";
  console.log("Course context selected:", {
    chunks: courseContext.chunkIds.length,
    characters: courseContext.selectedChars,
    titles: courseContext.titles,
    sourceSha256: courseContext.contentSha256.slice(0, 12),
  });
  return `${SYSTEM_INSTRUCTION.replace(
    "---COURSE_CONTENT---",
    courseContext.content
  )}${responseFormatInstruction}`;
}

export async function clearTranscriptCache() {
  resetCourseSearchIndex();
}

function truncateForModel(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxChars) return normalized;

  return `${characters.slice(0, maxChars - 1).join("")}…`;
}

function buildModelMessages(messages: ChatMessage[]): ChatMessage[] {
  const trimmedMessages = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);

  if (trimmedMessages.length === 0) return [];

  const latestUserIndex = trimmedMessages.findLastIndex(
    (message) => message.role === "user"
  );
  if (latestUserIndex === -1) return trimmedMessages.slice(-4);

  const selected: ChatMessage[] = [];
  let userCount = 0;
  let assistantCount = 0;
  let totalChars = 0;

  for (let index = latestUserIndex; index >= 0; index -= 1) {
    const message = trimmedMessages[index];
    const isLatestUserMessage = index === latestUserIndex;

    if (message.role === "user") {
      if (!isLatestUserMessage && userCount >= MAX_CONTEXT_USER_MESSAGES) {
        continue;
      }
    } else if (assistantCount >= MAX_CONTEXT_ASSISTANT_MESSAGES) {
      continue;
    }

    const maxChars =
      message.role === "assistant"
        ? MAX_CONTEXT_ASSISTANT_CHARS
        : isLatestUserMessage
          ? MAX_CONTEXT_LATEST_USER_CHARS
          : MAX_CONTEXT_PREVIOUS_USER_CHARS;
    const truncatedContent = truncateForModel(message.content, maxChars);
    const nextTotalChars = totalChars + Array.from(truncatedContent).length;

    if (!isLatestUserMessage && nextTotalChars > MAX_CONTEXT_TOTAL_CHARS) {
      continue;
    }

    selected.unshift({ role: message.role, content: truncatedContent });
    totalChars = nextTotalChars;

    if (message.role === "user") {
      userCount += 1;
    } else {
      assistantCount += 1;
    }
  }

  return selected;
}

export async function streamChatCompletion(
  messages: ChatMessage[]
): Promise<ReadableStream<string>> {
  const systemPrompt = await getSystemPrompt(messages);
  const client = getClient();

  const model = client.getGenerativeModel({ model: GEMINI_MODEL });
  const boundedMessages = buildModelMessages(messages);
  const latestUserMessage = [...boundedMessages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const enforceOneSentence = isOneSentenceRequest(latestUserMessage);
  const useStructuredResponse = !enforceOneSentence;

  const request = {
    contents: boundedMessages.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    })),
    generationConfig: {
      temperature: 0.35,
      topP: 0.85,
      topK: 30,
      // Gemini 2.5 counts internal reasoning against this budget. A low value
      // can cut Japanese output mid-sentence, so length is controlled by the
      // system instruction instead of a small hard cap.
      maxOutputTokens: 8192,
    },
  };
  const structuredRequest = {
    contents: boundedMessages.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    })),
    systemInstruction: systemPrompt,
    generationConfig: useStructuredResponse
      ? {
          ...request.generationConfig,
          responseMimeType: "application/json",
          responseSchema: COACH_RESPONSE_SCHEMA,
        }
      : request.generationConfig,
  };
  const plainTextFallbackRequest = {
    ...request,
    systemInstruction: `${systemPrompt}${PLAIN_TEXT_FALLBACK_INSTRUCTION}`,
  };

  return new ReadableStream<string>({
    async start(controller) {
      let lastError: unknown = null;
      let lastValidationError: unknown = null;

      for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
        let bufferedResponse = "";
        try {
          const stream = await model.generateContentStream(structuredRequest);
          for await (const chunk of stream.stream) {
            const text = chunk.text();
            if (text) {
              bufferedResponse += text;
            }
          }

          const formatted = enforceOneSentence
            ? formatOneSentenceResponse(bufferedResponse, latestUserMessage)
            : formatStructuredResponse(bufferedResponse, latestUserMessage);
          if (formatted) controller.enqueue(formatted);
          controller.close();
          return;
        } catch (error) {
          lastError = error;
          if (isResponseValidationError(error)) {
            lastValidationError = error;
          }
          const canRetry =
            (isRetryableGeminiError(error) ||
              isResponseValidationError(error)) &&
            attempt < GEMINI_MAX_ATTEMPTS;
          if (!canRetry) {
            break;
          }

          const delayMs = GEMINI_RETRY_DELAYS_MS[attempt - 1] ?? 1_200;
          console.warn("Retrying Gemini generation before response started:", {
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
          });
          await wait(delayMs);
        }
      }

      if (useStructuredResponse && lastValidationError) {
        try {
          let fallbackResponse = "";
          const fallbackStream =
            await model.generateContentStream(plainTextFallbackRequest);
          for await (const chunk of fallbackStream.stream) {
            const text = chunk.text();
            if (text) {
              fallbackResponse += text;
            }
          }

          const formatted = formatPlainTextFallbackResponse(fallbackResponse);
          controller.enqueue(formatted);
          controller.close();
          console.warn(
            "Recovered Gemini response with plain-text fallback after validation failures."
          );
          return;
        } catch (fallbackError) {
          console.error("Gemini plain-text fallback failed:", fallbackError);
          console.error("Gemini streaming error:", lastValidationError);
          controller.error(lastValidationError);
          return;
        }
      }

      console.error("Gemini streaming error:", lastError);
      controller.error(lastError);
    },
  });
}
