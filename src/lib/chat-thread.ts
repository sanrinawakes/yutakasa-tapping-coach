export const DEFAULT_CHAT_TITLE = "新しいチャット";
export const MAX_CHAT_TITLE_LENGTH = 60;

const AUTO_TITLE_VISIBLE_LENGTH = 21;
const ONE_SENTENCE_REQUEST_PATTERN =
  /(?:一文|1文)(?:だけ)?(?:で|に)|ひとこと|一言で/u;
const SENTENCE_PATTERN = /[^。！？!?]+[。！？!?]+|[^。！？!?]+$/gu;
const INTERNAL_COURSE_REFERENCE_PATTERN =
  /【\s*(\d{1,3})(?:\s*[-ー―−]\s*(\d{1,3}))?(?:\s*回)?\s*】/gu;
const TRAILING_INTERNAL_REFERENCE_PATTERN =
  /(?:\s*(?:\[\s*\d{1,3}\s*\]|【\s*\d{1,3}(?:\s*[-ー―−]\s*\d{1,3})?(?:\s*回)?\s*】))+\s*$/u;

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
  const withoutTrailingReferences = content.replace(
    TRAILING_INTERNAL_REFERENCE_PATTERN,
    ""
  );

  return withoutTrailingReferences
    .replace(
      INTERNAL_COURSE_REFERENCE_PATTERN,
      (
        marker,
        courseNumber: string,
        itemNumber: string | undefined,
        offset: number,
        fullText: string
      ) => {
        const precedingText = fullText.slice(Math.max(0, offset - 100), offset);
        const followingText = fullText.slice(offset + marker.length);
        const immediatelyAfterCourse = new RegExp(
          `第\\s*${courseNumber}\\s*回\\s*$`,
          "u"
        ).test(precedingText);
        const afterNamedCourse = new RegExp(
          `第\\s*${courseNumber}\\s*回[「『][^」』]{1,60}[」』]の\\s*$`,
          "u"
        ).test(precedingText);
        const immediatelyAfterNumberedVideo = new RegExp(
          `[（(]\\s*${courseNumber}\\s*[）)]\\s*$`,
          "u"
        ).test(precedingText);

        if (!itemNumber) {
          if (immediatelyAfterCourse || immediatelyAfterNumberedVideo) {
            return /^[^\s。、，．！？!?）)」』]/u.test(followingText) ? " " : "";
          }

          return `第${courseNumber}回`;
        }

        if (immediatelyAfterCourse || immediatelyAfterNumberedVideo) {
          return `・${itemNumber}番`;
        }

        if (afterNamedCourse) {
          return `${itemNumber}番`;
        }

        return `第${courseNumber}回・${itemNumber}番`;
      }
    )
    .replace(/\s+・(?=\d+番)/gu, "・")
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
