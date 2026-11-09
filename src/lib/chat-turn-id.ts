import { createHash } from "node:crypto";

// A reserved UUIDv8 derived from the owned thread and submitted user turn.
// Retries across serverless workers converge on the same assistant DB row.
export function assistantMessageIdFor(threadId: string, userMessageId: string): string {
  const hex = createHash("sha256")
    .update(`yutakasa-chat-assistant-v1:${threadId.toLowerCase()}:${userMessageId.toLowerCase()}`)
    .digest("hex");
  const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
