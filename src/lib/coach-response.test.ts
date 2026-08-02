import {
  parseStructuredCoachResponse,
  renderStructuredCoachResponse,
} from "./coach-response";

describe("structured coaching responses", () => {
  it("parses required fields and removes generic empathy", () => {
    const parsed = parseStructuredCoachResponse(
      JSON.stringify({
        acknowledgement:
          "借金の返済を考えると不安なのですね。そのお気持ち、よく分かります。",
        explanation: "講座の第12回では、借金への感情を扱います。",
        steps: [{ title: "確認", instruction: "感情を数値化してください。" }],
        practicePhrases: [],
        closing: "",
      })
    );

    expect(parsed.acknowledgement).toBe("借金の返済を考えると不安なのですね。");
  });

  it("renders no more than three steps and two quoted phrases", () => {
    const rendered = renderStructuredCoachResponse({
      acknowledgement: "借金の返済を考えると不安なのですね。",
      explanation:
        "講座の第12回では、借金への不安を具体的に扱います。感情を確認してから進めることが大切です。",
      steps: [
        {
          title: "感情を確認する",
          instruction: "金額を見て、今の不安を1から10で数値化してください。",
        },
        {
          title: "タッピングする",
          instruction:
            "「この不安を認めます」と唱えた後、「この借金への不安」「この怖さ」「この焦り」を使って各ポイントを叩いてください。",
        },
        {
          title: "変化を確認する",
          instruction: "もう一度、不安の数値を確認してください。",
        },
        { title: "余分な手順", instruction: "これは表示しません。" },
      ],
      practicePhrases: ["重複しない追加例", "さらに別の例"],
      closing: "必要に応じて繰り返してください。",
    });

    expect(rendered.match(/(?:^|\n)\d\. /gu)).toHaveLength(3);
    expect(rendered.match(/「[^」]+」/gu)).toHaveLength(2);
    expect(rendered).toContain("この焦り");
    expect(Array.from(rendered).length).toBeLessThanOrEqual(700);
  });

  it("reduces oversized fields while ending every visible line cleanly", () => {
    const rendered = renderStructuredCoachResponse({
      acknowledgement: `不安を感じているのですね。${"余分な説明です。".repeat(20)}`,
      explanation: "背景の説明です。".repeat(50),
      steps: Array.from({ length: 3 }, (_, index) => ({
        title: `手順${index + 1}`,
        instruction: `${"具体的に確認してください、".repeat(20)}最後に数値化してください。`,
      })),
      practicePhrases: ["例文1", "例文2"],
      closing: "最後に確認してください。".repeat(20),
    });

    expect(Array.from(rendered).length).toBeLessThanOrEqual(700);
    for (const line of rendered.split("\n").filter(Boolean)) {
      expect(line).toMatch(/[。！？!?」*]$/u);
    }
  });

  it("keeps quoted phrases to two across the whole rendered answer", () => {
    const rendered = renderStructuredCoachResponse({
      acknowledgement: "「認められない」と感じたのですね。",
      explanation:
        "「孤独だ」という思いが強いときは、「また無視される」が重なりやすいです。",
      steps: [
        {
          title: "感情を確認する",
          instruction:
            "今の怒りを1から10で数値化し、「ここで止まる」を使わずに確認してください。",
        },
      ],
      practicePhrases: ["追加の例文", "さらに別の例文"],
      closing: "必要なら「もう一度確認する」を次回に使ってください。",
    });

    expect(rendered.match(/「[^」]+」/gu)).toHaveLength(2);
  });

  it("removes dangling artifacts when extra quoted examples are trimmed", () => {
    const rendered = renderStructuredCoachResponse({
      acknowledgement: "娘さんの言葉にイラッとしたのですね。",
      explanation:
        "境界線が曖昧になると、受け取る価値まで揺らぎやすくなります。",
      steps: [
        {
          title: "感情の明確化",
          instruction:
            "娘さんの言葉を聞いて感じた感情（例：「軽視された」「尊重されていない」「自分のものが奪われる」）を紙に書き出してください。",
        },
        {
          title: "タッピングの準備",
          instruction:
            "最も強い感情を選び、「私はこの怒りを感じている」のように、セットアップフレーズを心の中で準備してください。",
        },
        {
          title: "タッピングの実践",
          instruction:
            "眉頭から頭頂までを軽く叩きながら、準備したフレーズ、心に浮かぶ感情（例：「悔しい」「腹が立つ」）を声に出して繰り返してください。",
        },
      ],
      practicePhrases: [],
      closing: "",
    });

    expect(rendered).not.toContain("私はこの怒りを感じているのように");
    expect(rendered).not.toContain("（例：）");
    expect(rendered).not.toContain("例：）");
    expect(rendered).not.toContain("「」");
    expect(rendered).toContain("「私はこの怒りを感じている」");
    expect(rendered).toContain("例：軽視された／尊重されていない／自分のものが奪われる");
  });

  it("preserves the phrase text even when quote marks exceed the limit", () => {
    const rendered = renderStructuredCoachResponse({
      acknowledgement:
        "娘さんの好きなだけ食べていいでしょという言葉に反応したのですね。",
      explanation:
        "境界線が揺らぐと怒りが強まりやすくなります。",
      steps: [
        {
          title: "感情の認識",
          instruction:
            "娘さんの言葉で感じた「軽視された」「尊重されていない」「奪われた」を紙に書き出してください。",
        },
      ],
      practicePhrases: [],
      closing: "",
    });

    expect(rendered).toContain("「軽視された」");
    expect(rendered).toContain("「尊重されていない」");
    expect(rendered).toContain("奪われた");
    expect(rendered).not.toContain("「奪われた」");
  });

  it("rejects incomplete JSON payloads", () => {
    expect(() =>
      parseStructuredCoachResponse(
        JSON.stringify({ acknowledgement: "確認しました。", steps: [] })
      )
    ).toThrow("incomplete coaching response");
  });
});
