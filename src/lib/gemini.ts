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

function formatStructuredResponse(content: string): string {
  try {
    return renderStructuredCoachResponse(
      parseStructuredCoachResponse(content)
    );
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
    ? "\n\n今回の利用者は一文だけの回答を指定しています。相談を言い直す受け止め文は付けず、実質的な回答だけを書いてください。句点「。」は文末の1個だけにしてください。"
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
            ? enforceOneSentenceResponse(bufferedResponse)
            : formatStructuredResponse(bufferedResponse);
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
