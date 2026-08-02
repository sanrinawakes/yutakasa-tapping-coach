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

const MAX_CONVERSATION_MESSAGES = 12;
const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_RETRY_DELAYS_MS = [400, 1_200] as const;
const DEBT_QUERY_PATTERN = /借金|負債|ローン|返済/u;
const INCOME_WORK_PHRASE = "これでは足りない";
const OBVIOUS_JAPANESE_TYPO_PATTERN = /不不快感/u;
const FIRST_ACTION_REQUEST_PATTERN =
  /(?:最初に(?:する|やる|行う)こと|最初の一歩|まず(?:何|なに)を)/u;
const MULTIPLE_ACTIONS_IN_ONE_SENTENCE_PATTERN =
  /^(.+?(?:して|し|感じて|見て|振り返り))、(?:その|次|続いて|さらに)/u;
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
      const multipleActions = formatted.match(
        MULTIPLE_ACTIONS_IN_ONE_SENTENCE_PATTERN
      );
      const firstAction = multipleActions?.[1]?.trim();
      if (firstAction) {
        formatted = firstAction
          .replace(/して$/u, "してください。")
          .replace(/し$/u, "してください。")
          .replace(/感じて$/u, "感じてください。")
          .replace(/見て$/u, "見てください。")
          .replace(/振り返り$/u, "振り返ってください。");
      }
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

export async function getSystemPrompt(
  messages: ChatMessage[] = []
): Promise<string> {
  const courseContext = selectCourseContext(messages);
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const responseFormatInstruction = isOneSentenceRequest(latestUserMessage)
    ? "\n\n今回の利用者は一文だけの回答を指定しています。相談を言い直す受け止め文は付けず、実質的な回答だけを書いてください。句点「。」は文末の1個だけにしてください。「最初にすること」「まず何をするか」と聞かれた場合は、最初の行動を1つだけ答え、複数の動作を「〜し、〜する」で連結しないでください。出力前に誤字と同じ文字の不自然な重複がないか確認してください。"
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

export async function streamChatCompletion(
  messages: ChatMessage[]
): Promise<ReadableStream<string>> {
  const systemPrompt = await getSystemPrompt(messages);
  const client = getClient();

  const model = client.getGenerativeModel({ model: GEMINI_MODEL });
  const boundedMessages = messages.slice(-MAX_CONVERSATION_MESSAGES);
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
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.35,
      topP: 0.85,
      topK: 30,
      // Gemini 2.5 counts internal reasoning against this budget. A low value
      // can cut Japanese output mid-sentence, so length is controlled by the
      // system instruction instead of a small hard cap.
      maxOutputTokens: 8192,
      ...(useStructuredResponse
        ? {
            responseMimeType: "application/json",
            responseSchema: COACH_RESPONSE_SCHEMA,
          }
        : {}),
    },
  };

  return new ReadableStream<string>({
    async start(controller) {
      let bufferedResponse = "";

      for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
        try {
          const stream = await model.generateContentStream(request);
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
          const canRetry =
            (isRetryableGeminiError(error) ||
              isResponseValidationError(error)) &&
            attempt < GEMINI_MAX_ATTEMPTS;
          if (!canRetry) {
            console.error("Gemini streaming error:", error);
            controller.error(error);
            return;
          }

          bufferedResponse = "";
          const delayMs = GEMINI_RETRY_DELAYS_MS[attempt - 1] ?? 1_200;
          console.warn("Retrying Gemini generation before response started:", {
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
          });
          await wait(delayMs);
        }
      }
    },
  });
}
