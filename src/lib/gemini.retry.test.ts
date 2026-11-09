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

import {
  GEMINI_CREDITS_DEPLETED_CODE,
  generateChatCompletion,
  type ChatMessage,
} from "./gemini";
import { geminiChatCircuit } from "./chat-provider-circuit";

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

function openAiCompletedResponse(content: string) {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: content }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function enableOpenAiChatFallback() {
  process.env.YUTAKASA_CHAT_OPENAI_FALLBACK_ENABLED = "true";
  process.env.YUTAKASA_CHAT_OPENAI_API_KEY = `sk-chat-${"a".repeat(40)}`;
  process.env.YUTAKASA_CHAT_OPENAI_PROJECT_ID = "proj_chatfallback123";
  process.env.YUTAKASA_CHAT_OPENAI_MODEL = "gpt-chat-fallback-test";
}

function clearOpenAiChatFallbackEnvironment() {
  delete process.env.YUTAKASA_CHAT_OPENAI_PRIMARY_ENABLED;
  delete process.env.YUTAKASA_CHAT_OPENAI_FALLBACK_ENABLED;
  delete process.env.YUTAKASA_CHAT_OPENAI_API_KEY;
  delete process.env.YUTAKASA_CHAT_OPENAI_PROJECT_ID;
  delete process.env.YUTAKASA_CHAT_OPENAI_MODEL;
  delete process.env.YUTAKASA_OPENAI_API_KEY;
  delete process.env.YUTAKASA_OPENAI_PROJECT_ID;
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

async function generateText(messages: ChatMessage[]) {
  return (await generateChatCompletion(messages)).content;
}

describe("Gemini generation retry", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    clearOpenAiChatFallbackEnvironment();
    mocks.generateContentStream.mockReset();
    geminiChatCircuit.reset();
  });

  afterEach(() => {
    clearOpenAiChatFallbackEnvironment();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses the dedicated OpenAI primary route without a Gemini key or call", async () => {
    enableOpenAiChatFallback();
    process.env.YUTAKASA_CHAT_OPENAI_PRIMARY_ENABLED = "true";
    delete process.env.GEMINI_API_KEY;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      openAiCompletedResponse(validStructuredResponse("返済が気になっているのですね。"))
    );

    const output = await generateText([
      { role: "user", content: "返済が不安です。" },
    ]);

    expect(output).toContain("返済が気になっているのですね。");
    expect(mocks.generateContentStream).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when the primary provider has no approved dedicated configuration", async () => {
    process.env.YUTAKASA_CHAT_OPENAI_PRIMARY_ENABLED = "true";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(generateText([
      { role: "user", content: "返済が不安です。" },
    ])).rejects.toThrow("gemini_generation_failed");
    expect(warn).toHaveBeenCalledWith("OpenAI chat generation did not complete", {
      path: "openai_primary",
      geminiReason: undefined,
      reason: "configuration_invalid",
    });
    expect(mocks.generateContentStream).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a substantive structured answer even for a short connection check", async () => {
    enableOpenAiChatFallback();
    process.env.YUTAKASA_CHAT_OPENAI_PRIMARY_ENABLED = "true";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      openAiCompletedResponse(JSON.stringify({
        acknowledgement: "動作確認のメッセージを受け取りました。",
        explanation: "このチャットで回答を表示できています。",
        steps: [], practicePhrases: [], closing: "",
      }))
    );
    const result = await generateText([
      { role: "user", content: "動作確認です。\n短く返答してください。" },
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.input[0].content).toContain("空欄にはせず");
    expect(body.text.format.schema.properties).toMatchObject({
      acknowledgement: { minLength: 1, pattern: "\\S" },
      explanation: { minLength: 1, pattern: "\\S" },
    });
    expect(result).toContain("このチャットで回答を表示できています。");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.generateContentStream).not.toHaveBeenCalled();
  });

  it("retries a transient initial 503 before returning an answer", async () => {
    enableOpenAiChatFallback();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.generateContentStream
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce(
        successfulStream(validStructuredResponse("不安を感じているのですね。"))
      );

    const output = await generateText([
        { role: "user", content: "返済が不安です。" },
      ]);

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    expect(output).toContain("不安を感じているのですね。");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not retry a 402 response even when the SDK message says fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const depletedError = Object.assign(
      new Error(
        "Error fetching from Gemini: [402 Payment Required] Your prepayment credits are depleted"
      ),
      { status: 402 }
    );
    mocks.generateContentStream.mockRejectedValueOnce(depletedError);

    const generation = generateText([
      { role: "user", content: "今の不安を相談したいです。" },
    ]);

    await expect(generation).rejects.toMatchObject({
      code: GEMINI_CREDITS_DEPLETED_CODE,
      message: GEMINI_CREDITS_DEPLETED_CODE,
    });
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not retry when depleted credits are reported without a status field", async () => {
    mocks.generateContentStream.mockRejectedValueOnce(
      new Error("Your prepayment credits are depleted")
    );

    const generation = generateText([
      { role: "user", content: "今の不安を相談したいです。" },
    ]);

    await expect(generation).rejects.toMatchObject({
      code: GEMINI_CREDITS_DEPLETED_CODE,
    });
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
  });

  it("does not run a provider fallback after credits deplete following a validation retry", async () => {
    enableOpenAiChatFallback();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.generateContentStream
      .mockResolvedValueOnce(successfulStream('{"acknowledgement":""}'))
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            "Error fetching from Gemini: [402 Payment Required] Your prepayment credits are depleted"
          ),
          { status: 402 }
        )
      );

    const generation = generateText([
      { role: "user", content: "今の不安を相談したいです。" },
    ]);

    await expect(generation).rejects.toMatchObject({
      code: GEMINI_CREDITS_DEPLETED_CODE,
    });
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the opt-in fallback once after an initial explicit prepay depletion", async () => {
    enableOpenAiChatFallback();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        openAiCompletedResponse(
          validStructuredResponse("今の不安を確認したいのですね。")
        )
      );
    mocks.generateContentStream.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Error fetching from Gemini: [402 Payment Required] Your prepayment credits are depleted"
        ),
        { status: 402 }
      )
    );

    const output = await generateText([
        { role: "user", content: "古い相談1です。" },
        { role: "user", content: "古い相談2です。" },
        { role: "assistant", content: "古い回答です。" },
        { role: "user", content: "古い相談3です。" },
        {
          role: "assistant",
          content: "直前の回答です。".repeat(80),
        },
        { role: "user", content: "今の不安を相談したいです。" },
      ]);

    expect(output).toContain("今の不安を確認したいのですね。");
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const request = JSON.parse(String(init.body));
    expect(request.store).toBe(false);
    expect(request.tools).toEqual([]);
    expect(request.model).toBe("gpt-chat-fallback-test");
    expect(request.text.format).toMatchObject({
      type: "json_schema",
      name: "yutakasa_coach_response",
      strict: true,
    });
    expect(request.input[0].role).toBe("developer");
    expect(request.input).toHaveLength(5);
    expect(JSON.stringify(request.input)).not.toContain("古い相談1");
    expect(JSON.stringify(request.input)).toContain("今の不安を相談したい");
  });

  it("does not retry Gemini when explicit depletion has a retryable status", async () => {
    enableOpenAiChatFallback();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        openAiCompletedResponse(
          validStructuredResponse("残高不足時の回答です。")
        )
      );
    mocks.generateContentStream.mockRejectedValueOnce(
      Object.assign(new Error("Your prepayment credits are depleted"), {
        status: 503,
      })
    );

    const output = await generateText([
        { role: "user", content: "今の不安を相談したいです。" },
      ]);

    expect(output).toContain("残高不足時の回答です。");
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not change provider for a non-credit Gemini error", async () => {
    enableOpenAiChatFallback();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.generateContentStream.mockRejectedValueOnce({ status: 400 });

    const generation = generateText([
      { role: "user", content: "今の不安を相談したいです。" },
    ]);

    await expect(generation).rejects.toMatchObject({
      code: "gemini_generation_failed",
    });
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not change provider for a generic 402 without explicit depletion text", async () => {
    enableOpenAiChatFallback();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.generateContentStream.mockRejectedValueOnce(
      Object.assign(new Error("Payment Required"), { status: 402 })
    );

    const generation = generateText([
      { role: "user", content: "今の不安を相談したいです。" },
    ]);

    await expect(generation).rejects.toMatchObject({
      code: GEMINI_CREDITS_DEPLETED_CODE,
    });
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discards interrupted, unpublished Gemini text before using OpenAI", async () => {
    enableOpenAiChatFallback();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      openAiCompletedResponse(validStructuredResponse("OpenAIからの完全な回答です。"))
    );
    const depletion = Object.assign(
      new Error("Your prepayment credits are depleted"),
      { status: 402 }
    );
    mocks.generateContentStream.mockResolvedValueOnce(
      interruptedStream('{"acknowledgement":"途中', depletion)
    );

    const generation = await generateChatCompletion([
      { role: "user", content: "今の不安を相談したいです。" },
    ]);

    expect(generation).toMatchObject({
      provider: "openai", path: "openai_fallback", reason: "gemini_credits_depleted",
    });
    expect(generation.content).toContain("OpenAIからの完全な回答です。");
    expect(generation.content).not.toContain("途中");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("bounds transient retries and switches once using the same context", async () => {
    vi.useFakeTimers();
    enableOpenAiChatFallback();
    mocks.generateContentStream.mockRejectedValue({ status: 503 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      openAiCompletedResponse(validStructuredResponse("通信障害時の回答です。"))
    );
    const request = generateChatCompletion([{ role: "user", content: "同じ相談です。" }]);
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(request).resolves.toMatchObject({
      provider: "openai", path: "openai_fallback", reason: "gemini_transient",
    });
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain("同じ相談です。");
  });

  it("aborts hung headers and body attempts within the total Gemini budget", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    enableOpenAiChatFallback();
    const signals: AbortSignal[] = [];
    const never = () => new Promise<never>(() => {});
    mocks.generateContentStream.mockImplementation((_, { signal }) => {
      signals.push(signal);
      return signals.length === 1 ? never() : {
        stream: { [Symbol.asyncIterator]: () => ({ next: never }) },
      };
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      openAiCompletedResponse(validStructuredResponse("時間切れから復旧した回答です。"))
    );
    const request = generateChatCompletion([{ role: "user", content: "相談です。" }]);
    await vi.advanceTimersByTimeAsync(34_999);
    expect(fetchSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toMatchObject({
      provider: "openai", path: "openai_fallback", reason: "gemini_timeout",
    });
    expect(signals).toHaveLength(3);
    expect(signals.every(({ aborted }) => aborted)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("skips Gemini while open, admits only one probe and returns to Gemini on success", async () => {
    vi.useFakeTimers();
    enableOpenAiChatFallback();
    mocks.generateContentStream.mockRejectedValueOnce(new Error("Your prepayment credits are depleted"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      openAiCompletedResponse(validStructuredResponse("代替の回答です。"))
    );
    const messages: ChatMessage[] = [{ role: "user", content: "同じ会話の相談です。" }];
    await expect(generateChatCompletion(messages)).resolves.toMatchObject({
      provider: "openai", path: "openai_fallback",
    });
    await expect(generateChatCompletion(messages)).resolves.toMatchObject({
      provider: "openai", path: "openai_circuit",
    });
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 5 * 60_000);
    let finishProbe!: (result: ReturnType<typeof successfulStream>) => void;
    mocks.generateContentStream.mockImplementationOnce(() => new Promise(resolve => {
      finishProbe = resolve;
    }));
    const probe = generateChatCompletion(messages);
    await expect(generateChatCompletion(messages)).resolves.toMatchObject({
      provider: "openai", path: "openai_circuit",
    });
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    finishProbe(successfulStream(validStructuredResponse("Geminiが復旧しました。")));
    await expect(probe).resolves.toMatchObject({ provider: "gemini", path: "gemini" });
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(validStructuredResponse("次の相談もGeminiで応答します。"))
    );
    await expect(generateChatCompletion(messages)).resolves.toMatchObject({ provider: "gemini" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not bypass a safety finish or call OpenAI", async () => {
    enableOpenAiChatFallback();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.generateContentStream.mockResolvedValueOnce({
      stream: (async function* () {
        yield { candidates: [{ finishReason: "SAFETY" }], text: () => "表示しない" };
      })(),
    });
    await expect(generateChatCompletion([{ role: "user", content: "相談です。" }]))
      .rejects.toMatchObject({ code: "gemini_generation_failed" });
    expect(mocks.generateContentStream).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes no second fallback request when OpenAI output fails validation", async () => {
    enableOpenAiChatFallback();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        openAiCompletedResponse('{"acknowledgement":""}')
      );
    mocks.generateContentStream.mockRejectedValueOnce(
      Object.assign(new Error("Your prepayment credits are depleted"), {
        status: 402,
      })
    );

    const generation = generateText([
      { role: "user", content: "今の不安を相談したいです。" },
    ]);

    await expect(generation).rejects.toMatchObject({
      code: "gemini_generation_failed",
      message: "gemini_generation_failed",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses draft reply validation for the opt-in fallback", async () => {
    enableOpenAiChatFallback();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(openAiCompletedResponse(validDraftReply));
    mocks.generateContentStream.mockRejectedValueOnce(
      Object.assign(new Error("Your prepayment credits are depleted"), {
        status: 402,
      })
    );

    const output = await generateText([{ role: "user", content: draftQuestion }]);

    expect(output).toBe(validDraftReply);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = JSON.parse(
      String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body)
    );
    expect(request.text).toEqual({ format: { type: "text" } });
    expect(request.input.at(-1).content).toContain("① 今いちばん強く");
  });

  it("reuses one-sentence enforcement for the opt-in fallback", async () => {
    enableOpenAiChatFallback();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        openAiCompletedResponse(
          "これは短い前置きです。最初に今の感情を1から10で数値化してください。"
        )
      );
    mocks.generateContentStream.mockRejectedValueOnce(
      Object.assign(new Error("Your prepayment credits are depleted"), {
        status: 402,
      })
    );

    const output = await generateText([
        {
          role: "user",
          content: "不安なとき最初にすることを一文で教えてください。",
        },
      ]);

    expect(output).toBe("最初に今の感情を1から10で数値化してください。");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still retries a transport failure without an HTTP status", async () => {
    enableOpenAiChatFallback();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.generateContentStream
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        successfulStream(validStructuredResponse("不安を感じているのですね。"))
      );

    const output = await generateText([
        { role: "user", content: "今の不安を相談したいです。" },
      ]);

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
    expect(output).toContain("不安を感じているのですね。");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discards an interrupted hidden draft and returns only the retry", async () => {
    mocks.generateContentStream
      .mockResolvedValueOnce(
        interruptedStream('{"acknowledgement":"途中', { status: 503 })
      )
      .mockResolvedValueOnce(
        successfulStream(validStructuredResponse("再試行後の回答です。"))
      );

    const output = await generateText([
        { role: "user", content: "受け取り方を教えてください。" },
      ]);

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

    const output = await generateText([
        { role: "user", content: "借金の返済が不安です。" },
      ]);

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

    const output = await generateText([
        {
          role: "user",
          content:
            "お金を受け取る罪悪感が出たとき、最初にすることを一文だけで教えてください。",
        },
      ]);

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

    const output = await generateText([
        {
          role: "user",
          content:
            "お金を受け取る罪悪感が出たとき、最初にすることを一文だけで教えてください。",
        },
      ]);

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(output).toBe("過去の記憶を思い出してください。");
  });

  it("keeps only the first action from the observed production answer", async () => {
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(
        "お金を受け取る罪悪感が出たときは、その感情を認め、講座の第19回で紹介されているタッピングエクササイズを始めてください。"
      )
    );

    const output = await generateText([
        {
          role: "user",
          content:
            "お金を受け取る罪悪感が出たとき、最初にすることを一文だけで教えてください。",
        },
      ]);

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    expect(output).toBe("その感情を認めてください。");
  });

  it("keeps an introductory comma when the answer contains one action", async () => {
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(
        "まず、その感情の強さを1から10で数値化してください。"
      )
    );

    const output = await generateText([
        {
          role: "user",
          content:
            "お金を受け取る罪悪感が出たとき、最初にすることを一文だけで教えてください。",
        },
      ]);

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

    const output = await generateText([
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
      ]);

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

    const output = await generateText([
        { role: "user", content: "借金の返済が不安です。" },
      ]);

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

    const output = await generateText([{ role: "user", content: draftQuestion }]);

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

    const output = await generateText([{ role: "user", content: draftQuestion }]);

    expect(mocks.generateContentStream).toHaveBeenCalledTimes(3);
    expect(output).toBe(validDraftReply);
    expect(output).not.toContain("確実に外れ");
  });

  it("keeps the original numbered question through repeated correction turns", async () => {
    const longAnchor = `${draftQuestion}\n${"補足情報です。".repeat(1_300)}\n① 進め方は合っていますか？\n② 感情を十分に扱えていますか？`;
    mocks.generateContentStream.mockResolvedValueOnce(
      successfulStream(validDraftReply)
    );

    await generateText([
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
      ]);

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

    await generateText([
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
      ]);

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
