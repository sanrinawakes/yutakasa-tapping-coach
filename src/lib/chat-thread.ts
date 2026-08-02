export const DEFAULT_CHAT_TITLE = "新しいチャット";
export const MAX_CHAT_TITLE_LENGTH = 60;

const AUTO_TITLE_VISIBLE_LENGTH = 21;
const ONE_SENTENCE_REQUEST_PATTERN =
  /(?:一文|1文)(?:だけ)?(?:で|に)|ひとこと|一言で/u;
const SENTENCE_PATTERN = /[^。！？!?]+[。！？!?]+|[^。！？!?]+$/gu;

export interface ChatThreadMessageCount {
  chat_messages?: Array<{ count: number }> | null;
}

function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function sanitizeChatTitle(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_CHAT_TITLE;

  const normalized = normalizeSingleLine(value);
  if (!normalized) return DEFAULT_CHAT_TITLE;

  return Array.from(normalized).slice(0, MAX_CHAT_TITLE_LENGTH).join("");
}

export function createChatTitle(message: string): string {
  const normalized = normalizeSingleLine(message);
  if (!normalized) return DEFAULT_CHAT_TITLE;

  const characters = Array.from(normalized);
  if (characters.length <= AUTO_TITLE_VISIBLE_LENGTH) return normalized;

  return `${characters.slice(0, AUTO_TITLE_VISIBLE_LENGTH).join("")}…`;
}

export function sanitizeAssistantContent(content: string): string {
  return content
    .replace(/(?:\s*(?:\[\d+\]|【\d+】))+\s*$/u, "")
    .trimEnd();
}

export function isOneSentenceRequest(message: string): boolean {
  return ONE_SENTENCE_REQUEST_PATTERN.test(message);
}

function isAcknowledgementOnly(sentence: string): boolean {
  const normalized = sentence.replace(/\s+/gu, "").trim();
  return (
    normalized.length <= 80 &&
    /(?:のですね|いるのですね|いたのですね|されたのですね)[。！？!?]$/u.test(
      normalized
    )
  );
}

export function enforceOneSentenceResponse(content: string): string {
  const normalized = sanitizeAssistantContent(content)
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "";

  const sentences = normalized.match(SENTENCE_PATTERN)?.map((sentence) =>
    sentence.trim()
  ) ?? [normalized];
  if (sentences.length === 1) return sentences[0];

  const substantive = sentences.filter(
    (sentence, index) => index > 0 || !isAcknowledgementOnly(sentence)
  );
  const candidates = substantive.length > 0 ? substantive : sentences;
  return candidates.reduce((longest, sentence) =>
    Array.from(sentence).length > Array.from(longest).length ? sentence : longest
  );
}

export function hasChatMessages(thread: ChatThreadMessageCount): boolean {
  return (thread.chat_messages?.[0]?.count ?? 0) > 0;
}
