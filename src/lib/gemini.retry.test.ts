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
});
