const mocks = vi.hoisted(() => ({
  generateContentStream: vi.fn(),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContentStream: mocks.generateContentStream };
    }
  },
  SchemaType: {
    OBJECT: "object",
    STRING: "string",
    ARRAY: "array",
  },
}));

import { streamChatCompletion } from "./gemini";

function successfulStream(content: string) {
  return {
    stream: (async function* () {
      yield { text: () => content };
    })(),
  };
}

function interruptedStream(content: string, error: unknown) {
  return {
    stream: (async function* () {
      yield { text: () => content };
      throw error;
    })(),
  };
}

function validStructuredResponse(
  acknowledgement: string,
  instruction = "今の感情を1から10で数値化してください。"
) {
  return JSON.stringify({
    acknowledgement,
    explanation: "講座に基づいて、感情を確認してから進めます。",
    steps: [
      {
        title: "感情を確認する",
        instruction,
      },
    ],
    practicePhrases: [],
    closing: "",
  });
}

const draftQuestion = `受講者から届いた次の質問への返信文を考えてください。
タッピング中に別の相手への怒りが強く出てきました。
① 今いちばん強く出ている相手へ対象を変える進め方で大丈夫ですか？
② 最初の相手への怒りは全くなくなり、その怒りがあったことも忘れていました。十分に感情を扱えたと考えてよいですか？
連絡に気づくのが1ヶ月以上遅れたので、申し訳ないという謝罪も入れてください。`;

const validDraftReply = `ご連絡に気づくのが1ヶ月以上遅くなってしまい、申し訳ありません。

① はい、その時点でいちばん強く出ている相手への感情に対象を変える進め方で大丈夫です。

② はい。今その出来事を思い浮かべた時の感情の強度を数値で確認し、3以下なら十分に扱えたものとして一区切りにしてください。`;

async function readText(stream: ReadableStream<string>) {
  const reader = stream.getReader();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return output;
    output += value;
  }
}

describe("Gemini generation retry", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    mocks.generateContentStream.mockReset();
  });

  it("retries a transient initial 503 before returning an answer", async () => {
    mocks.generateContentStream
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce(
        successfulStream(validStructuredResponse("不安を感じているのですね。"))
      );

    const output = await readText(
      await streamChatCompletion([
        { role: "user", content: "返済が不安です。" },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    expect(output).toContain("不安を感じているのですね。");
  });

  it("discards an interrupted hidden draft and returns only the retry", async () => {
    mocks.generateContentStream
      .mockResolvedValueOnce(
        interruptedStream('{"acknowledgement":"途中', { status: 503 })
      )
      .mockResolvedValueOnce(
        successfulStream(validStructuredResponse("再試行後の回答です。"))
      );

    const output = await readText(
      await streamChatCompletion([
        { role: "user", content: "受け取り方を教えてください。" },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    expect(output).toContain("再試行後の回答です。");
    expect(output).not.toContain("途中");
  });

  it("retries when an income exercise is misapplied to a debt question", async () => {
    mocks.generateContentStream
      .mockResolvedValueOnce(
        successfulStream(
          validStructuredResponse(
            "借金額を見ることに不安があるのですね。",
            "借金の総額を見て「これでは足りない」と声に出してください。"
          )
        )
      )
      .mockResolvedValueOnce(
        successfulStream(
          validStructuredResponse(
            "借金額を見ることに不安があるのですね。",
            "借金の総額を紙に書き、その時に出る感情を数値化してください。"
          )
        )
      );

    const output = await readText(
      await streamChatCompletion([
        { role: "user", content: "借金の返済が不安です。" },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    expect(output).not.toContain("これでは足りない");
    expect(output).toContain("借金の総額を紙に書き");
  });

  it("retries an obvious typo before returning a one-sentence answer", async () => {
    mocks.generateContentStream
      .mockResolvedValueOnce(
        successfulStream(
          "今感じている不不快感を1から10で数値化してください。"
        )
      )
      .mockResolvedValueOnce(
        successfulStream("今感じている罪悪感を1から10で数値化してください。")
      );

    const output = await readText(
      await streamChatCompletion([
        {
          role: "user",
          content:
            "お金を受け取る罪悪感が出たとき、最初にすることを一文だけで教えてください。",
        },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    expect(output).toBe(
      "今感じている罪悪感を1から10で数値化してください。"
    );
    expect(output).not.toContain("不不快感");
  });

  it("keeps only the first action when the model combines multiple actions", async () => {
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(
        "過去の記憶を思い出し、その時の不快感を数値化してください。"
      )
    );

    const output = await readText(
      await streamChatCompletion([
        {
          role: "user",
          content:
            "お金を受け取る罪悪感が出たとき、最初にすることを一文だけで教えてください。",
        },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(output).toBe("過去の記憶を思い出してください。");
  });

  it("keeps only the first action from the observed production answer", async () => {
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(
        "お金を受け取る罪悪感が出たときは、その感情を認め、講座の第19回で紹介されているタッピングエクササイズを始めてください。"
      )
    );

    const output = await readText(
      await streamChatCompletion([
        {
          role: "user",
          content:
            "お金を受け取る罪悪感が出たとき、最初にすることを一文だけで教えてください。",
        },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(output).toBe("その感情を認めてください。");
  });

  it("keeps an introductory comma when the answer contains one action", async () => {
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(
        "まず、その感情の強さを1から10で数値化してください。"
      )
    );

    const output = await readText(
      await streamChatCompletion([
        {
          role: "user",
          content:
            "お金を受け取る罪悪感が出たとき、最初にすることを一文だけで教えてください。",
        },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(output).toBe(
      "まず、その感情の強さを1から10で数値化してください。"
    );
  });

  it("retries when the model enumerates prior history for a current-turn question", async () => {
    mocks.generateContentStream
      .mockResolvedValueOnce(
        successfulStream(
          JSON.stringify({
            acknowledgement:
              "娘さんの言葉にイラッとしたのですね。",
            explanation:
              "これまでのあなたの質問内容（「認めてもらえない」「孤独を感じる」「心が晴れない」）は、今回の怒りとつながっています。",
            steps: [
              {
                title: "感情を確認する",
                instruction:
                  "娘さんの言葉を思い出し、今の怒りを1から10で数値化してください。",
              },
            ],
            practicePhrases: [],
            closing: "",
          })
        )
      )
      .mockResolvedValueOnce(
        successfulStream(
          validStructuredResponse(
            "娘さんの言葉にイラッとしたのですね。",
            "娘さんの言葉を思い出し、今の怒りを1から10で数値化してください。"
          )
        )
      );

    const output = await readText(
      await streamChatCompletion([
        {
          role: "assistant",
          content:
            "前回は認めてもらえない苦しさを整理しました。今回も同じ背景があります。",
        },
        {
          role: "user",
          content:
            "私がいただいたところてんを好きなだけ食べていいでしょと娘に言われちょっとイラッときた",
        },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    expect(output).not.toContain("これまでのあなたの質問内容");
    expect(output).toContain("娘さんの言葉を思い出し");
  });

  it("falls back to plain text after repeated structured validation failures", async () => {
    mocks.generateContentStream
      .mockResolvedValueOnce(successfulStream('{"acknowledgement":"","steps":[]}'))
      .mockResolvedValueOnce(successfulStream('{"acknowledgement":"","steps":[]}'))
      .mockResolvedValueOnce(successfulStream('{"acknowledgement":"","steps":[]}'))
      .mockResolvedValueOnce(
        successfulStream(
          "借金額を見た瞬間に出る不安を1から10で数値化し、その数値が下がるまで講座の第12回の手順でタッピングしてください。"
        )
      );

    const output = await readText(
      await streamChatCompletion([
        { role: "user", content: "借金の返済が不安です。" },
      ])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(4);
    expect(output).toContain("借金額を見た瞬間に出る不安を1から10で数値化");
    const fallbackRequest = mocks.generateContentStream.mock.calls[3]?.[0] as {
      generationConfig?: { responseSchema?: unknown; responseMimeType?: unknown };
      systemInstruction?: string;
    };
    expect(fallbackRequest.generationConfig?.responseSchema).toBeUndefined();
    expect(fallbackRequest.generationConfig?.responseMimeType).toBeUndefined();
    expect(fallbackRequest.systemInstruction).toContain(
      "構造化JSONの代わりに"
    );
  });

  it("uses draft-reply mode for an operator writing to a customer", async () => {
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(validDraftReply)
    );

    const output = await readText(
      await streamChatCompletion([{ role: "user", content: draftQuestion }])
    );

    expect(output).toBe(validDraftReply);
    const request = mocks.generateContentStream.mock.calls[0]?.[0] as {
      generationConfig?: { responseSchema?: unknown; responseMimeType?: unknown };
      systemInstruction?: string;
    };
    expect(request.generationConfig?.responseSchema).toBeUndefined();
    expect(request.generationConfig?.responseMimeType).toBeUndefined();
    expect(request.systemInstruction).toContain("運営者の返信文作成担当");
    expect(request.systemInstruction).toContain("①・②を本文に残し");
    expect(request.systemInstruction).toContain("明確な謝罪");
  });

  it("retries draft replies that omit questions or invent guarantees", async () => {
    mocks.generateContentStream
      .mockResolvedValueOnce(
        successfulStream(
          "怒りには複数の層があります。タッピングを続けてください。"
        )
      )
      .mockResolvedValueOnce(
        successfulStream(`確認が1ヶ月以上遅くなり、申し訳ありません。
① はい、このままで大丈夫です。
② はい、続ければ確実に外れていきます。`)
      )
      .mockResolvedValueOnce(successfulStream(validDraftReply));

    const output = await readText(
      await streamChatCompletion([{ role: "user", content: draftQuestion }])
    );

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(3);
    expect(output).toBe(validDraftReply);
    expect(output).not.toContain("確実に外れ");
  });

  it("keeps the original numbered question through repeated correction turns", async () => {
    const longAnchor = `${draftQuestion}\n${"補足情報です。".repeat(1_300)}\n① 進め方は合っていますか？\n② 感情を十分に扱えていますか？`;
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(validDraftReply)
    );

    await readText(
      await streamChatCompletion([
        { role: "user", content: longAnchor },
        { role: "assistant", content: "一般的な説明だけを返しました。" },
        { role: "user", content: "1ヶ月以上遅れた謝罪を入れて。" },
        { role: "assistant", content: "謝罪だけを返しました。" },
        { role: "user", content: "①と②に答えてないやん。" },
        { role: "assistant", content: "質問をもう一度送ってください。" },
        {
          role: "user",
          content: "イエスかノーか、①と②に真面目に答えて。",
        },
      ])
    );

    const request = mocks.generateContentStream.mock.calls[0]?.[0] as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    const anchor = request.contents.find(
      (message) =>
        message.role === "user" &&
        message.parts[0]?.text.includes("受講者から届いた")
    );
    expect(anchor?.parts[0]?.text).toContain("① 進め方は合っていますか？");
    expect(anchor?.parts[0]?.text).toContain("② 感情を十分に扱えていますか？");
    expect(request.contents.at(-1)?.parts[0]?.text).toContain(
      "①と②に真面目に答えて"
    );
  });

  it("sends only the latest turn plus minimal context to Gemini", async () => {
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(validStructuredResponse("今の不安を確認したいのですね。"))
    );

    await readText(
      await streamChatCompletion([
        { role: "user", content: "一つ前の相談です。" },
        { role: "user", content: "二つ前の相談です。" },
        { role: "assistant", content: "さらに古い回答です。" },
        { role: "user", content: "三つ前の相談です。" },
        {
          role: "assistant",
          content:
            "前回の回答です。".repeat(80),
        },
        {
          role: "user",
          content:
            "私がいただいたところてんを好きなだけ食べていいでしょと娘に言われちょっとイラッときた",
        },
      ])
    );

    const request = mocks.generateContentStream.mock.calls[0]?.[0] as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    const assistantMessage = request.contents.find(
      (message) => message.role === "model"
    );

    expect(request.contents).toHaveLength(4);
    expect(request.contents.filter((message) => message.role === "model")).toHaveLength(1);
    expect(request.contents.at(-1)?.parts[0]?.text).toContain("ところてん");
    expect(assistantMessage?.parts[0]?.text.endsWith("…")).toBe(true);
  });
});
