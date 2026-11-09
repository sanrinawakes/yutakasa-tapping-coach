import {
  GoogleGenerativeAI,
  type GenerateContentRequest,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";
import {
  DRAFT_REPLY_SYSTEM_INSTRUCTION,
  GEMINI_MODEL,
  SYSTEM_INSTRUCTION,
} from "./constants";
import {
  buildConversationResponsePlan,
  draftRetrievalQuery,
  type ConversationResponsePlan,
  type DraftReplyContext,
} from "./conversation-mode";
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
import {
  generateOpenAiChatFallback,
  isOpenAiChatFallbackEnabled,
  OpenAiChatFallbackError,
} from "./openai-chat-fallback";
import {
  geminiChatCircuit,
  type GeminiAvailabilityReason,
} from "./chat-provider-circuit";

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
const GEMINI_ATTEMPT_TIMEOUT_MS = 15_000;
const GEMINI_TOTAL_TIMEOUT_MS = 35_000;
const GEMINI_MAX_RESPONSE_CHARS = 64_000;
const MAX_CONTEXT_USER_MESSAGES = 3;
const MAX_CONTEXT_ASSISTANT_MESSAGES = 1;
const MAX_CONTEXT_TOTAL_CHARS = 2_400;
const MAX_CONTEXT_LATEST_USER_CHARS = 700;
const MAX_CONTEXT_PREVIOUS_USER_CHARS = 240;
const MAX_CONTEXT_ASSISTANT_CHARS = 320;
const MAX_DRAFT_CONTEXT_USER_MESSAGES = 6;
const MAX_DRAFT_CONTEXT_ASSISTANT_MESSAGES = 2;
const MAX_DRAFT_CONTEXT_TOTAL_CHARS = 22_000;
const MAX_DRAFT_CONTEXT_ANCHOR_CHARS = 8_000;
const MAX_DRAFT_CONTEXT_LATEST_USER_CHARS = 4_000;
const MAX_DRAFT_CONTEXT_PREVIOUS_USER_CHARS = 1_500;
const MAX_DRAFT_CONTEXT_ASSISTANT_CHARS = 1_000;
const DEBT_QUERY_PATTERN = /借金|負債|ローン|返済/u;
const INCOME_WORK_PHRASE = "これでは足りない";
const OBVIOUS_JAPANESE_TYPO_PATTERN = /不不快感/u;
const QUOTED_PHRASE_PATTERN = /「[^」]{1,80}」/gu;
const HISTORY_ENUMERATION_PATTERN =
  /(?:これまでの(?:あなたの)?(?:質問|相談|やり取り|会話)内容|以前の(?:ご)?質問|過去の(?:相談|やり取り))/u;
const HISTORY_REQUEST_PATTERN =
  /(?:以前|過去|前回|さっき|先ほど|続き|その件|今まで|これまで)/u;
const DRAFT_MISSING_CONTENT_PATTERN =
  /(?:具体的な)?(?:質問|内容).{0,20}(?:確認|把握)でき(?:ません|ない)|(?:質問|内容)をもう一度(?:送|教え)/u;
const DRAFT_GUARANTEE_PATTERN =
  /(?:必ず|確実に).{0,30}(?:外れ|治(?:る|り)|改善|なくな|解消)/u;
const DRAFT_META_PREFIX_PATTERN =
  /^(?:以下|こちら).{0,30}(?:返信|返答|回答)(?:案|文|です)/u;
const DRAFT_DIRECT_CONCLUSION_PATTERN =
  /(?:はい|いいえ|イエス|ノー|大丈夫です|問題ありません|適切です|十分とは(?:言え|判断でき)|忘れただけでは|その進め方で)/u;
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

const OPENAI_COACH_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    acknowledgement: {
      type: "string",
      minLength: 1,
      maxLength: 90,
      pattern: "\\S",
      description:
        "入力の要点を確認する短い1文。挨拶や確認だけの場合も、受け取った内容に合わせて自然に応じる。空文字、よく分かります、理解できます、お察ししますは禁止。",
    },
    explanation: {
      type: "string",
      minLength: 1,
      maxLength: 220,
      pattern: "\\S",
      description:
        "入力への実質的な答えを必ず1〜2文で書く。講座に関する相談には根拠を含め、挨拶や動作確認などには講座の話を無理に付け足さず簡潔に答える。空文字と練習フレーズは禁止。",
    },
    steps: {
      type: "array",
      maxItems: 3,
      description: "今すぐ実行できる手順。不要な場合は空配列。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            description: "20文字以内の短い見出し。",
          },
          instruction: {
            type: "string",
            description:
              "120文字以内の具体的な指示を1文で書く。練習フレーズはpracticePhrasesへ分ける。",
          },
        },
        required: ["title", "instruction"],
      },
    },
    practicePhrases: {
      type: "array",
      maxItems: 2,
      description:
        "タッピング中に唱える短いフレーズ。回答に不要なら空配列。",
      items: { type: "string" },
    },
    closing: {
      type: "string",
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
const DRAFT_VALIDATION_RECOVERY_INSTRUCTION =
  "\n\n前回までの出力には必須項目の欠落がありました。元の相談文と最新の修正指示を読み直し、番号付き質問を一つも飛ばさず、指定された謝罪と結論を含む返信本文だけを最初から作り直してください。";
const OPENAI_STRUCTURED_OUTPUT_INSTRUCTION =
  "\n\nJSONの acknowledgement と explanation はどちらも必須です。入力が短くても、空欄にはせず、acknowledgement は受け取った内容への応答、explanation は実質的な答えを書いてください。挨拶や動作確認には簡潔に応じ、無関係な講座情報や助言は加えないでください。";

export const GEMINI_CREDITS_DEPLETED_CODE = "gemini_credits_depleted";
export const GEMINI_GENERATION_FAILED_CODE = "gemini_generation_failed";

export type GeminiGenerationErrorCode =
  | typeof GEMINI_CREDITS_DEPLETED_CODE
  | typeof GEMINI_GENERATION_FAILED_CODE;

export class GeminiGenerationError extends Error {
  constructor(
    readonly code: GeminiGenerationErrorCode,
    cause?: unknown
  ) {
    super(code, { cause });
    this.name = "GeminiGenerationError";
  }
}

function geminiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function geminiHttpStatus(error: unknown): number | null {
  const rawStatus =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : null;
  const status = Number(rawStatus);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return status;
  }

  const statusMatch = geminiErrorMessage(error).match(
    /\[(\d{3})(?:\s+[^\]]*)?\]/u
  );
  return statusMatch ? Number(statusMatch[1]) : null;
}

export function geminiGenerationErrorCode(
  error: unknown
): GeminiGenerationErrorCode {
  if (error instanceof GeminiGenerationError) {
    return error.code;
  }

  const message = geminiErrorMessage(error);
  if (
    geminiHttpStatus(error) === 402 ||
    /prepayment credits are depleted/iu.test(message)
  ) {
    return GEMINI_CREDITS_DEPLETED_CODE;
  }
  return GEMINI_GENERATION_FAILED_CODE;
}

function normalizedGeminiGenerationError(
  error: unknown
): GeminiGenerationError {
  return error instanceof GeminiGenerationError
    ? error
    : new GeminiGenerationError(geminiGenerationErrorCode(error), error);
}

function isExplicitGeminiPrepayDepletion(error: unknown): boolean {
  return (
    geminiGenerationErrorCode(error) === GEMINI_CREDITS_DEPLETED_CODE &&
    /\bprepayment credits are depleted\b/iu.test(geminiErrorMessage(error))
  );
}

export function isRetryableGeminiError(error: unknown): boolean {
  const status = geminiHttpStatus(error);
  if (status !== null) {
    return [408, 429, 500, 502, 503, 504].includes(status);
  }

  const message = geminiErrorMessage(error);
  return /(?:failed to fetch|fetch failed|network error|socket hang up|timeout|timed out|ECONNRESET|EAI_AGAIN|error reading from the stream|503 Service Unavailable)/iu.test(
    message
  );
}

class GeminiTimeoutError extends Error {}
class GeminiRejectedOutputError extends Error {}

function geminiAvailabilityReason(error: unknown): GeminiAvailabilityReason | undefined {
  if (error instanceof GeminiRejectedOutputError || isResponseValidationError(error)) {
    return undefined;
  }
  if (isExplicitGeminiPrepayDepletion(error)) return "gemini_credits_depleted";
  const status = geminiHttpStatus(error);
  if (error instanceof GeminiTimeoutError || status === 408 || status === 504) {
    return "gemini_timeout";
  }
  if (isRetryableGeminiError(error)) return "gemini_transient";
}

async function collectGeminiAnswer(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  request: GenerateContentRequest,
  deadline: number
): Promise<string> {
  const timeLeft = Math.min(GEMINI_ATTEMPT_TIMEOUT_MS, deadline - performance.now());
  if (timeLeft <= 0) throw new GeminiTimeoutError("Gemini time budget expired");
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new GeminiTimeoutError("Gemini attempt timed out"));
      abort.abort();
    }, timeLeft);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const result = await model.generateContentStream(request, { signal: abort.signal });
      // The SDK tees the stream; handle rejection before reading either branch.
      void result.response?.catch(() => undefined);
      let text = "";
      for await (const chunk of result.stream) {
        const reason = chunk.candidates?.[0]?.finishReason;
        if (chunk.promptFeedback?.blockReason ||
            (reason && reason !== "STOP" && reason !== "FINISH_REASON_UNSPECIFIED")) {
          throw new GeminiRejectedOutputError("Gemini did not complete an allowed answer");
        }
        try {
          text += chunk.text();
        } catch {
          // A rejected response can contain provider safety details. Never
          // classify those details as an availability error by string match.
          throw new GeminiRejectedOutputError("Gemini rejected its output");
        }
        if (text.length > GEMINI_MAX_RESPONSE_CHARS) {
          throw new GeminiRejectedOutputError("Gemini output exceeded its size limit");
        }
      }
      const final = await result.response;
      if (final && final.candidates?.[0]?.finishReason !== "STOP") {
        throw new GeminiRejectedOutputError("Gemini did not finish the answer");
      }
      return text;
    })()]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
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

function draftSectionForLabel(
  content: string,
  label: string,
  labels: string[]
): string {
  const start = content.indexOf(label);
  if (start === -1) return "";

  const nextStarts = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => content.indexOf(candidate, start + label.length))
    .filter((index) => index > start);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : content.length;
  return content.slice(start + label.length, end).trim();
}

function formatDraftReplyResponse(
  content: string,
  context: DraftReplyContext
): string {
  try {
    const formatted = sanitizeAssistantContent(content)
      .replace(/^```(?:markdown|text)?\s*/iu, "")
      .replace(/```$/u, "")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    if (!formatted) {
      throw new Error("Draft reply was empty");
    }
    if (DRAFT_META_PREFIX_PATTERN.test(formatted)) {
      throw new Error("Draft reply included an internal preface");
    }

    for (const label of context.requiredQuestionLabels) {
      if (!formatted.includes(label)) {
        throw new Error(`Draft reply omitted question ${label}`);
      }
    }

    if (
      context.requiredQuestionLabels.length > 0 &&
      DRAFT_MISSING_CONTENT_PATTERN.test(formatted)
    ) {
      throw new Error("Draft reply falsely claimed that questions were missing");
    }

    if (context.requiresDelayApology) {
      const mentionsRequestedDuration = context.requiresOneMonthDelay
        ? /(?:1|１|一)\s*(?:か月|カ月|ケ月|ヶ月|箇月)(?:以上)?/u.test(
            formatted
          )
        : true;
      const mentionsDelay =
        /(?:確認.{0,20}遅|気[づ付]く.{0,20}遅|返(?:事|信).{0,20}遅)/u.test(
          formatted
        );
      const apologizes = /(?:申し訳|お詫び|すみません)/u.test(formatted);
      if (!mentionsRequestedDuration || !mentionsDelay || !apologizes) {
        throw new Error("Draft reply omitted the requested delay apology");
      }
    }

    if (context.requiresDirectAnswer) {
      for (const label of context.requiredQuestionLabels) {
        const section = draftSectionForLabel(
          formatted,
          label,
          context.requiredQuestionLabels
        );
        if (!DRAFT_DIRECT_CONCLUSION_PATTERN.test(section.slice(0, 160))) {
          throw new Error(`Draft reply did not answer ${label} directly`);
        }
      }
    }

    for (const label of context.completionCheckQuestionLabels) {
      const section = draftSectionForLabel(
        formatted,
        label,
        context.requiredQuestionLabels
      );
      const asksToRecall =
        /(?:思い出|思い浮かべ|イメージ|対象.{0,20}考え)/u.test(section);
      const measuresIntensity = /(?:数値|強度|測|確認)/u.test(section);
      const usesCourseThreshold = /3\s*以下/u.test(section);
      if (!asksToRecall || !measuresIntensity || !usesCourseThreshold) {
        throw new Error(
          `Draft reply did not verify completion for ${label}`
        );
      }
    }
    for (const label of context.positiveCompletionQuestionLabels) {
      const section = draftSectionForLabel(
        formatted,
        label,
        context.requiredQuestionLabels
      );
      if (!/はい/u.test(section.slice(0, 160))) {
        throw new Error(
          `Draft reply did not give the required conditional yes for ${label}`
        );
      }
    }

    if (DRAFT_GUARANTEE_PATTERN.test(formatted)) {
      throw new Error("Draft reply made an unsupported guarantee");
    }
    if (
      !context.sourceContainsSelfWorthClaim &&
      formatted.includes("自分には価値がない")
    ) {
      throw new Error("Draft reply invented a self-worth belief");
    }

    return formatted;
  } catch (cause) {
    const error = new Error("Gemini response validation failed", { cause });
    error.name = "GeminiResponseValidationError";
    throw error;
  }
}

function draftRequirementInstruction(context: DraftReplyContext): string {
  const requirements: string[] = [];
  if (context.requiredQuestionLabels.length > 0) {
    requirements.push(
      `${context.requiredQuestionLabels.join("・")}を本文に残し、それぞれへ個別に答える`
    );
  }
  if (context.requiresDelayApology) {
    requirements.push(
      context.requiresOneMonthDelay
        ? "確認または返信が1か月以上遅れた事実と、明確な謝罪を入れる"
        : "確認または返信が遅れた事実と、明確な謝罪を入れる"
    );
  }
  if (context.requiresDirectAnswer) {
    requirements.push(
      "各番号の冒頭に、はい・いいえ、または同じ程度に明確な結論を書く"
    );
  }
  if (context.completionCheckQuestionLabels.length > 0) {
    requirements.push(
      `${context.completionCheckQuestionLabels.join(
        "・"
      )}では、忘れていた事実だけで完了と断定せず、対象を思い浮かべて感情の強度を再確認し、3以下なら一区切りと答える`
    );
  }
  if (context.positiveCompletionQuestionLabels.length > 0) {
    requirements.push(
      `${context.positiveCompletionQuestionLabels.join(
        "・"
      )}では、怒りが全くなくなったという相談内容を踏まえ、「はい。ただし、今その対象を思い浮かべても感情の強度が3以下であることを確認できれば一区切り」と答える`
    );
  }
  if (requirements.length === 0) return "";

  return `\n\n今回の返信文の必須条件：\n${requirements
    .map((requirement) => `- ${requirement}`)
    .join("\n")}\n\n元の相談文の重要部分：\n---\n${draftRetrievalQuery(
    context
  )}\n---`;
}

export async function getSystemPrompt(
  messages: ChatMessage[] = [],
  responsePlan = buildConversationResponsePlan(messages)
): Promise<string> {
  const courseMessages = responsePlan.draftReply
    ? [
        {
          role: "user" as const,
          content: draftRetrievalQuery(responsePlan.draftReply),
        },
      ]
    : messages;
  const courseContext = selectCourseContext(courseMessages);
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const responseFormatInstruction =
    responsePlan.mode === "coach" && isOneSentenceRequest(latestUserMessage)
    ? "\n\n今回の利用者は一文だけの回答を指定しています。相談を言い直す受け止め文は付けず、実質的な回答だけを書いてください。句点「。」は文末の1個だけにしてください。「最初にすること」「まず何をするか」と聞かれた場合は、最初の行動を1つだけ答えてください。「その感情を認め、タッピングを始めてください」のように2つの行動をつなげる回答は禁止です。出力前に誤字と同じ文字の不自然な重複がないか確認してください。"
    : "";
  console.log("Course context selected:", {
    mode: responsePlan.mode,
    chunks: courseContext.chunkIds.length,
    characters: courseContext.selectedChars,
    titles: courseContext.titles,
    sourceSha256: courseContext.contentSha256.slice(0, 12),
  });
  const baseInstruction =
    responsePlan.mode === "draft_reply"
      ? DRAFT_REPLY_SYSTEM_INSTRUCTION
      : SYSTEM_INSTRUCTION;
  const draftRequirements = responsePlan.draftReply
    ? draftRequirementInstruction(responsePlan.draftReply)
    : "";
  return `${baseInstruction.replace(
    "---COURSE_CONTENT---",
    courseContext.content
  )}${responseFormatInstruction}${draftRequirements}`;
}

export async function clearTranscriptCache() {
  resetCourseSearchIndex();
}

function truncateForModel(
  content: string,
  maxChars: number,
  preserveTail = false
): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxChars) return normalized;

  if (preserveTail) {
    const headChars = Math.floor((maxChars - 1) * 0.45);
    const tailChars = maxChars - 1 - headChars;
    return `${characters.slice(0, headChars).join("")}…${characters
      .slice(-tailChars)
      .join("")}`;
  }

  return `${characters.slice(0, maxChars - 1).join("")}…`;
}

function trimmedModelMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);
}

function buildCoachModelMessages(messages: ChatMessage[]): ChatMessage[] {
  const trimmedMessages = messages
    .map((message) => ({ ...message }))
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

function buildDraftModelMessages(
  messages: ChatMessage[],
  responsePlan: ConversationResponsePlan
): ChatMessage[] {
  const trimmedMessages = trimmedModelMessages(messages);
  const draftReply = responsePlan.draftReply;
  if (!draftReply || trimmedMessages.length === 0) return trimmedMessages;

  const latestUserIndex = trimmedMessages.findLastIndex(
    (message) => message.role === "user"
  );
  if (latestUserIndex === -1) return trimmedMessages.slice(-4);

  const anchorContent = messages[draftReply.anchorMessageIndex]?.content.trim();
  const anchorIndex = anchorContent
    ? trimmedMessages.findLastIndex(
        (message) =>
          message.role === "user" && message.content === anchorContent
      )
    : -1;
  const firstRelevantIndex = anchorIndex >= 0 ? anchorIndex : 0;
  const includedIndices = new Set<number>([latestUserIndex]);
  if (anchorIndex >= 0) includedIndices.add(anchorIndex);

  let userCount = Array.from(includedIndices).filter(
    (index) => trimmedMessages[index]?.role === "user"
  ).length;
  let assistantCount = 0;
  for (
    let index = latestUserIndex;
    index >= firstRelevantIndex;
    index -= 1
  ) {
    if (includedIndices.has(index)) continue;
    const message = trimmedMessages[index];
    if (message.role === "user") {
      if (userCount >= MAX_DRAFT_CONTEXT_USER_MESSAGES) continue;
      userCount += 1;
    } else {
      if (assistantCount >= MAX_DRAFT_CONTEXT_ASSISTANT_MESSAGES) continue;
      assistantCount += 1;
    }
    includedIndices.add(index);
  }

  const selected: ChatMessage[] = [];
  let totalChars = 0;
  for (const index of Array.from(includedIndices).sort((a, b) => a - b)) {
    const message = trimmedMessages[index];
    const maxChars =
      message.role === "assistant"
        ? MAX_DRAFT_CONTEXT_ASSISTANT_CHARS
        : index === anchorIndex
          ? MAX_DRAFT_CONTEXT_ANCHOR_CHARS
          : index === latestUserIndex
            ? MAX_DRAFT_CONTEXT_LATEST_USER_CHARS
            : MAX_DRAFT_CONTEXT_PREVIOUS_USER_CHARS;
    const content = truncateForModel(message.content, maxChars, true);
    const nextTotalChars = totalChars + Array.from(content).length;
    const isRequired = index === anchorIndex || index === latestUserIndex;
    if (!isRequired && nextTotalChars > MAX_DRAFT_CONTEXT_TOTAL_CHARS) {
      continue;
    }
    selected.push({ role: message.role, content });
    totalChars = nextTotalChars;
  }

  return selected;
}

function buildModelMessages(
  messages: ChatMessage[],
  responsePlan: ConversationResponsePlan
): ChatMessage[] {
  const trimmedMessages = trimmedModelMessages(messages);
  return responsePlan.mode === "draft_reply"
    ? buildDraftModelMessages(messages, responsePlan)
    : buildCoachModelMessages(trimmedMessages);
}

export type ChatGeneration =
  | { content: string; provider: "gemini"; path: "gemini" }
  | {
      content: string;
      provider: "openai";
      path: "openai_primary" | "openai_fallback" | "openai_circuit";
      reason?: GeminiAvailabilityReason;
    };

export async function generateChatCompletion(
  messages: ChatMessage[]
): Promise<ChatGeneration> {
  const responsePlan = buildConversationResponsePlan(messages);
  const systemPrompt = await getSystemPrompt(messages, responsePlan);
  const boundedMessages = buildModelMessages(messages, responsePlan);
  const latestUserMessage = [...boundedMessages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const isDraftReply = responsePlan.mode === "draft_reply";
  const enforceOneSentence =
    !isDraftReply && isOneSentenceRequest(latestUserMessage);
  const useStructuredResponse = !isDraftReply && !enforceOneSentence;
  const formatResponse = (response: string) => responsePlan.draftReply
    ? formatDraftReplyResponse(response, responsePlan.draftReply)
    : enforceOneSentence
      ? formatOneSentenceResponse(response, latestUserMessage)
      : formatStructuredResponse(response, latestUserMessage);
  const generateOpenAiResponse = async () => formatResponse(await generateOpenAiChatFallback({
    systemPrompt: useStructuredResponse ? `${systemPrompt}${OPENAI_STRUCTURED_OUTPUT_INSTRUCTION}` : systemPrompt,
    messages: boundedMessages,
    responseFormat: useStructuredResponse
      ? { type: "json_schema", name: "yutakasa_coach_response", schema: OPENAI_COACH_RESPONSE_SCHEMA }
      : { type: "text" },
  }));
  async function completeWithOpenAi(
    path: Extract<ChatGeneration, { provider: "openai" }>["path"],
    reason?: GeminiAvailabilityReason
  ): Promise<ChatGeneration> {
    try {
      const content = await generateOpenAiResponse();
      if (!content.trim()) throw new Error("Empty formatted answer");
      return { content, provider: "openai", path, ...(reason ? { reason } : {}) };
    } catch (error) {
      console.warn("OpenAI chat generation did not complete", {
        path,
        geminiReason: reason,
        reason: error instanceof OpenAiChatFallbackError ? error.reason : "formatting_failed",
        ...(error instanceof OpenAiChatFallbackError && error.upstreamStatus !== undefined
          ? { upstreamStatus: error.upstreamStatus }
          : {}),
      });
      throw normalizedGeminiGenerationError(error);
    }
  }

  // An explicit recovery setting avoids a failing Google request on every turn.
  // The dedicated credential and project guards still apply in this mode.
  if (process.env.YUTAKASA_CHAT_OPENAI_PRIMARY_ENABLED === "true") {
    return completeWithOpenAi("openai_primary");
  }

  const useFallback = isOpenAiChatFallbackEnabled();
  const model = getClient().getGenerativeModel({ model: GEMINI_MODEL });
  const admission = useFallback ? geminiChatCircuit.admit() : undefined;
  if (admission && !admission.attempt) return completeWithOpenAi("openai_circuit", admission.reason);
  const deadline = performance.now() + GEMINI_TOTAL_TIMEOUT_MS;

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
  const primaryRequest = {
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
  const validationRecoveryInstruction = isDraftReply
    ? DRAFT_VALIDATION_RECOVERY_INSTRUCTION
    : PLAIN_TEXT_FALLBACK_INSTRUCTION;
  const plainTextFallbackRequest = {
    ...request,
    systemInstruction: `${systemPrompt}${validationRecoveryInstruction}`,
  };

  const geminiSuccess = (content: string): ChatGeneration => {
    if (!content.trim()) throw new GeminiRejectedOutputError("Empty formatted answer");
    if (admission) geminiChatCircuit.finish(admission, "success");
    return { content, provider: "gemini", path: "gemini" };
  };
  const maxAttempts = admission?.probe ? 1 : GEMINI_MAX_ATTEMPTS;
  let lastError: unknown;
  let sawInvalidAnswer = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return geminiSuccess(formatResponse(await collectGeminiAnswer(model, primaryRequest, deadline)));
    } catch (error) {
      lastError = error;
      sawInvalidAnswer ||= isResponseValidationError(error);
      const reason = geminiAvailabilityReason(error);
      const delayMs = GEMINI_RETRY_DELAYS_MS[attempt - 1] ?? 1_200;
      if (reason === "gemini_credits_depleted" || attempt >= maxAttempts ||
          (!reason && !isResponseValidationError(error)) ||
          performance.now() + delayMs >= deadline) break;
      await wait(delayMs);
    }
  }

  if (!admission?.probe && (useStructuredResponse || isDraftReply) &&
      isResponseValidationError(lastError) && performance.now() < deadline) {
    try {
      const text = await collectGeminiAnswer(model, plainTextFallbackRequest, deadline);
      return geminiSuccess(responsePlan.draftReply
        ? formatDraftReplyResponse(text, responsePlan.draftReply)
        : formatPlainTextFallbackResponse(text));
    } catch (error) {
      lastError = error;
    }
  }

  const reason = geminiAvailabilityReason(lastError);
  if (admission) geminiChatCircuit.finish(admission, reason ?? "not_availability_failure");
  // No Gemini text has reached the client. A safety or validation rejection
  // by itself is never permission to try a different model.
  if (reason && useFallback && !sawInvalidAnswer) return completeWithOpenAi("openai_fallback", reason);
  throw normalizedGeminiGenerationError(lastError);
}
