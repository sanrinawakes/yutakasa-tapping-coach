import {
  buildConversationResponsePlan,
  draftRetrievalQuery,
  type ConversationMessage,
} from "./conversation-mode";

const customerQuestion = `受講者から次の質問が届きました。返信文を考えてください。
最初の相手への怒りをタッピングしていたところ、別の相手への怒りが強く出ました。
① 今いちばん強く出ている相手へ対象を変える進め方で大丈夫ですか？
② 最初の相手への怒りは全くなくなり、その怒りがあったことも忘れていました。十分に感情を扱えたと考えてよいですか？
連絡に気づくのが1ヶ月以上遅れたので、申し訳ないという謝罪も入れてください。`;

describe("conversation response mode", () => {
  it("keeps draft-reply mode and requirements across revision turns", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: customerQuestion },
      {
        role: "assistant",
        content: "強い感情から順にタッピングを続けてください。",
      },
      {
        role: "user",
        content: "1ヶ月以上経ってしまったニュアンスをもっと明確に入れて。",
      },
      { role: "assistant", content: "返信が遅くなり申し訳ありません。" },
      { role: "user", content: "①と②に答えてないやん。" },
      { role: "assistant", content: "質問をもう一度送ってください。" },
      {
        role: "user",
        content: "イエスかノーか、①と②に真面目に答えて。",
      },
    ];

    const plan = buildConversationResponsePlan(messages);

    expect(plan.mode).toBe("draft_reply");
    expect(plan.draftReply?.requiredQuestionLabels).toEqual(["①", "②"]);
    expect(plan.draftReply?.requiresDelayApology).toBe(true);
    expect(plan.draftReply?.requiresOneMonthDelay).toBe(true);
    expect(plan.draftReply?.requiresDirectAnswer).toBe(true);
    expect(plan.draftReply?.completionCheckQuestionLabels).toEqual(["②"]);
    expect(plan.draftReply?.positiveCompletionQuestionLabels).toEqual(["②"]);
    expect(plan.draftReply?.sourceMessage).toBe(customerQuestion);
  });

  it("uses a separately pasted numbered question as the draft source", () => {
    const source = `相談者から届いた内容です。
① この進め方でよいでしょうか？
② 感情が出ない場合は終えてよいでしょうか？`;
    const plan = buildConversationResponsePlan([
      { role: "user", content: "お客さんへの返信文を考えて。" },
      { role: "user", content: source },
    ]);

    expect(plan.mode).toBe("draft_reply");
    expect(plan.draftReply?.sourceMessage).toBe(source);
    expect(plan.draftReply?.requiredQuestionLabels).toEqual(["①", "②"]);
  });

  it("does not use a pasted bad assistant answer as the retrieval query", () => {
    const plan = buildConversationResponsePlan([
      { role: "user", content: customerQuestion },
      { role: "assistant", content: "質問への回答です。" },
      {
        role: "user",
        content:
          "豊かさタッピング AI Coachの前の回答には、講座の第17回と自分には価値がないという決めつけが入っていました。これを直して。",
      },
    ]);

    expect(plan.draftReply).not.toBeNull();
    const query = draftRetrievalQuery(plan.draftReply!);
    expect(query).toContain("①");
    expect(query).toContain("②");
    expect(query).not.toContain("第17回");
    expect(query).not.toContain("自分には価値がない");
  });

  it("returns to coaching mode when the user explicitly changes topics", () => {
    const plan = buildConversationResponsePlan([
      { role: "user", content: customerQuestion },
      { role: "assistant", content: "返信文です。" },
      {
        role: "user",
        content: "話は変わります。自分の借金への不安を相談したいです。",
      },
    ]);

    expect(plan.mode).toBe("coach");
    expect(plan.draftReply).toBeNull();
  });

  it("does not keep draft mode for a later unrelated long consultation", () => {
    const plan = buildConversationResponsePlan([
      { role: "user", content: customerQuestion },
      { role: "assistant", content: "返信文です。" },
      {
        role: "user",
        content:
          "自分の収入への不安について相談します。" +
          "来月の売上を考えると落ち着かず、仕事に集中できません。".repeat(8),
      },
    ]);

    expect(plan.mode).toBe("coach");
    expect(plan.draftReply).toBeNull();
  });
});
