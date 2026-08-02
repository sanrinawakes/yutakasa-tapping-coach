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

function validStructuredResponse(acknowledgement: string) {
  return JSON.stringify({
    acknowledgement,
    explanation: "講座に基づいて、感情を確認してから進めます。",
    steps: [
      {
        title: "感情を確認する",
        instruction: "今の感情を1から10で数値化してください。",
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
});
