import {
  generateOpenAiChatFallback,
  OPENAI_CHAT_FALLBACK_FAILED_CODE,
  OpenAiChatFallbackError,
} from "./openai-chat-fallback";

const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  YUTAKASA_CHAT_OPENAI_FALLBACK_ENABLED: "true",
  YUTAKASA_CHAT_OPENAI_API_KEY: `sk-chat-${"a".repeat(40)}`,
  YUTAKASA_CHAT_OPENAI_PROJECT_ID: "proj_chatfallback123",
  YUTAKASA_CHAT_OPENAI_MODEL: "gpt-chat-fallback-test",
};

function completedResponse(text: string) {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

const fallbackInput = {
  systemPrompt: "講座抜粋に基づいて答えてください。",
  messages: [
    { role: "user" as const, content: "今の不安を相談したいです。" },
    { role: "assistant" as const, content: "前回の回答です。" },
  ],
  responseFormat: { type: "text" as const },
};

describe("OpenAI chat fallback transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses only the fixed Responses endpoint and explicit dedicated config", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);
    const fetchImpl = vi.fn(async () => completedResponse("安全な回答です。"));

    const output = await generateOpenAiChatFallback(fallbackInput, {
      env: VALID_ENV,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(output).toBe("安全な回答です。");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(init.signal).toBe(timeoutSignal);
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${VALID_ENV.YUTAKASA_CHAT_OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Project": VALID_ENV.YUTAKASA_CHAT_OPENAI_PROJECT_ID,
    });

    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "gpt-chat-fallback-test",
      store: false,
      tools: [],
      max_output_tokens: 4096,
      text: { format: { type: "text" } },
    });
    expect(body.input).toEqual([
      { role: "developer", content: fallbackInput.systemPrompt },
      ...fallbackInput.messages,
    ]);
  });

  it.each([
    "YUTAKASA_CHAT_OPENAI_FALLBACK_ENABLED",
    "YUTAKASA_CHAT_OPENAI_API_KEY",
    "YUTAKASA_CHAT_OPENAI_PROJECT_ID",
    "YUTAKASA_CHAT_OPENAI_MODEL",
  ] as const)("requires explicit %s configuration", async (name) => {
    const fetchImpl = vi.fn();
    const env = { ...VALID_ENV };
    delete env[name];

    await expect(
      generateOpenAiChatFallback(fallbackInput, {
        env,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toMatchObject({
      name: "OpenAiChatFallbackError",
      message: OPENAI_CHAT_FALLBACK_FAILED_CODE,
      reason: "configuration_invalid",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects reuse of the automation key or project", async () => {
    const fetchImpl = vi.fn();
    const env = {
      ...VALID_ENV,
      YUTAKASA_OPENAI_API_KEY: VALID_ENV.YUTAKASA_CHAT_OPENAI_API_KEY,
      YUTAKASA_OPENAI_PROJECT_ID: VALID_ENV.YUTAKASA_CHAT_OPENAI_PROJECT_ID,
    };

    await expect(
      generateOpenAiChatFallback(fallbackInput, {
        env,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toMatchObject({ reason: "configuration_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails before fetch when the bounded request limit is exceeded", async () => {
    const fetchImpl = vi.fn();

    await expect(
      generateOpenAiChatFallback(
        { ...fallbackInput, systemPrompt: "あ".repeat(140_000) },
        { env: VALID_ENV, fetchImpl: fetchImpl as typeof fetch }
      )
    ).rejects.toMatchObject({ reason: "request_too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps provider responses before parsing them", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("x".repeat(256 * 1024 + 1), { status: 200 })
    );

    await expect(
      generateOpenAiChatFallback(fallbackInput, {
        env: VALID_ENV,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toMatchObject({ reason: "response_too_large" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns fixed errors without provider response or transport details", async () => {
    const providerSecret = "provider-secret-detail";
    const failingFetch = vi.fn(async () => {
      throw new Error(providerSecret);
    });

    let requestError: unknown;
    try {
      await generateOpenAiChatFallback(fallbackInput, {
        env: VALID_ENV,
        fetchImpl: failingFetch as typeof fetch,
      });
    } catch (error) {
      requestError = error;
    }
    expect(requestError).toBeInstanceOf(OpenAiChatFallbackError);
    expect(requestError).toMatchObject({
      message: OPENAI_CHAT_FALLBACK_FAILED_CODE,
      reason: "request_failed",
    });
    expect(String(requestError)).not.toContain(providerSecret);

    const cancel = vi.fn();
    const httpFetch = vi.fn(async () =>
      new Response(new ReadableStream({ cancel }), { status: 500 })
    );
    await expect(
      generateOpenAiChatFallback(fallbackInput, {
        env: VALID_ENV,
        fetchImpl: httpFetch as typeof fetch,
      })
    ).rejects.toMatchObject({
      message: OPENAI_CHAT_FALLBACK_FAILED_CODE,
      reason: "response_failed",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("parses one assistant output_text from a completed raw response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            { type: "reasoning", summary: [] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "採用する回答です。" }],
            },
          ],
        }),
        { status: 200 }
      )
    );

    await expect(
      generateOpenAiChatFallback(fallbackInput, {
        env: VALID_ENV,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toBe("採用する回答です。");
  });

  it.each([
    {
      status: "incomplete",
      output: [],
    },
    {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "refused" }],
        },
      ],
    },
    {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "first" },
            { type: "output_text", text: "second" },
          ],
        },
      ],
    },
    {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "first" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "second" }],
        },
      ],
    },
    {
      status: "completed",
      output: [{ type: "custom_tool_call", name: "unexpected" }],
    },
  ])("rejects incomplete or ambiguous raw output", async (responseBody) => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), { status: 200 })
    );

    await expect(
      generateOpenAiChatFallback(fallbackInput, {
        env: VALID_ENV,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toMatchObject({ reason: "response_invalid" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON with a fixed error", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));

    await expect(
      generateOpenAiChatFallback(fallbackInput, {
        env: VALID_ENV,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toMatchObject({
      message: OPENAI_CHAT_FALLBACK_FAILED_CODE,
      reason: "response_invalid",
    });
  });
});
