import {
  DEFAULT_CHAT_TITLE,
  createChatTitle,
  hasChatMessages,
  sanitizeAssistantContent,
  sanitizeChatTitle,
} from "./chat-thread";

describe("chat thread helpers", () => {
  it("creates a readable title from the first user message", () => {
    expect(
      createChatTitle(
        "  仕事への不安について\nタッピングの進め方を相談したいです。  "
      )
    ).toBe("仕事への不安について タッピングの進め方を…");
  });

  it("uses the default title when the message has no readable text", () => {
    expect(createChatTitle(" \n\t ")).toBe(DEFAULT_CHAT_TITLE);
  });

  it("normalizes and limits manually entered titles", () => {
    expect(sanitizeChatTitle("  家族との関係\nについて  ")).toBe(
      "家族との関係 について"
    );
    expect(sanitizeChatTitle("あ".repeat(80))).toHaveLength(60);
  });

  it("removes unexplained standalone citation numbers at the end", () => {
    expect(sanitizeAssistantContent("一緒に整理していきましょう。\n\n[1]"))
      .toBe("一緒に整理していきましょう。");
    expect(sanitizeAssistantContent("続けてみてください。 【2】"))
      .toBe("続けてみてください。");
  });

  it("keeps meaningful course section references", () => {
    expect(
      sanitizeAssistantContent("講座の該当箇所は【7ー4】です。")
    ).toBe("講座の該当箇所は【7ー4】です。");
  });

  it("distinguishes saved conversations from empty placeholder threads", () => {
    expect(hasChatMessages({ chat_messages: [{ count: 2 }] })).toBe(true);
    expect(hasChatMessages({ chat_messages: [{ count: 0 }] })).toBe(false);
    expect(hasChatMessages({})).toBe(false);
  });
});
