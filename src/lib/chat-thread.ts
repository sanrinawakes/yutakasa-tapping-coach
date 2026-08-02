export const DEFAULT_CHAT_TITLE = "新しいチャット";
export const MAX_CHAT_TITLE_LENGTH = 60;

const AUTO_TITLE_VISIBLE_LENGTH = 21;

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

export function hasChatMessages(thread: ChatThreadMessageCount): boolean {
  return (thread.chat_messages?.[0]?.count ?? 0) > 0;
}
