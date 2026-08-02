import {
  DEFAULT_CHAT_TITLE,
  createChatTitle,
  enforceOneSentenceResponse,
  hasChatMessages,
  isOneSentenceRequest,
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

  it("turns internal course section markers into readable references", () => {
    expect(
      sanitizeAssistantContent("講座の該当箇所は【7ー4】です。")
    ).toBe("講座の該当箇所は第7回・4番です。");
    expect(
      sanitizeAssistantContent("第23回【23】豊かさの引き寄せ")
    ).toBe("第23回 豊かさの引き寄せ");
    expect(
      sanitizeAssistantContent("第7回【7ー4】を参照してください。")
    ).toBe("第7回・4番を参照してください。");
    expect(
      sanitizeAssistantContent(
        "第1回「イントロダクション」の【1-7】「今週の課題」"
      )
    ).toBe("第1回「イントロダクション」の7番「今週の課題」");
    expect(
      sanitizeAssistantContent("幻のコンサル動画(3) 【3ー2】を参照")
    ).toBe("幻のコンサル動画(3)・2番を参照");
  });

  it("does not change ordinary numbers written for the customer", () => {
    expect(
      sanitizeAssistantContent("感情の強さを1から10で確認し、第7回を見てください。")
    ).toBe("感情の強さを1から10で確認し、第7回を見てください。");
  });

  it("detects an explicit one-sentence request", () => {
    expect(isOneSentenceRequest("一文で教えてください")).toBe(true);
    expect(isOneSentenceRequest("1文だけにしてください")).toBe(true);
    expect(isOneSentenceRequest("具体的に教えてください")).toBe(false);
  });

  it("removes an extra acknowledgement from a one-sentence answer", () => {
    expect(
      enforceOneSentenceResponse(
        "お金を受け取ることに罪悪感を感じているのですね。最初に、その感情の強さを1から10で数値化してください。"
      )
    ).toBe("最初に、その感情の強さを1から10で数値化してください。");
  });

  it("keeps only the most substantive sentence when the model returns several", () => {
    expect(
      enforceOneSentenceResponse(
        "不安なのですね。理由を確認します。今夜は、返済額を見たときの不安を1から10で数値化してください。"
      )
    ).toBe(
      "今夜は、返済額を見たときの不安を1から10で数値化してください。"
    );
  });

  it("distinguishes saved conversations from empty placeholder threads", () => {
    expect(hasChatMessages({ chat_messages: [{ count: 2 }] })).toBe(true);
    expect(hasChatMessages({ chat_messages: [{ count: 0 }] })).toBe(false);
    expect(hasChatMessages({})).toBe(false);
  });
});
