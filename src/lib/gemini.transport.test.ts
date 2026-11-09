import { geminiChatCircuit } from "./chat-provider-circuit";
import { generateChatCompletion } from "./gemini";

const prompt = [{ role: "user" as const, content: "最初にすることを一文で教えてください。" }];
const answer = "今の感情の強さを数値で確認してください。";

// Exercise the pinned SDK's real HTTP/SSE adapter, without network or keys.
function geminiSse(finishReason: "STOP" | "SAFETY") {
  const chunk = JSON.stringify({
    candidates: [{ index: 0, content: { role: "model", parts: [{ text: answer }] } }],
  });
  const final = JSON.stringify({ candidates: [{ index: 0, finishReason }] });
  return new Response(`data: ${chunk}\n\ndata: ${final}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("isolated chat provider transport", () => {
  beforeEach(() => {
    geminiChatCircuit.reset();
    vi.stubEnv("GEMINI_API_KEY", "synthetic-gemini-test-key");
    vi.stubEnv("YUTAKASA_CHAT_OPENAI_PRIMARY_ENABLED", "false");
    vi.stubEnv("YUTAKASA_CHAT_OPENAI_FALLBACK_ENABLED", "true");
    vi.stubEnv("YUTAKASA_CHAT_OPENAI_API_KEY", `sk-test-${"a".repeat(40)}`);
    vi.stubEnv("YUTAKASA_CHAT_OPENAI_PROJECT_ID", "proj_continuity_fixture");
    vi.stubEnv("YUTAKASA_CHAT_OPENAI_MODEL", "synthetic-openai-model");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads the completed Gemini SSE answer without calling OpenAI", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(geminiSse("STOP"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateChatCompletion(prompt)).resolves.toEqual({
      provider: "gemini", path: "gemini", content: answer,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//u);
  });

  it("switches from a real SDK-parsed 402 response to the dedicated OpenAI adapter", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        error: { message: "Your prepayment credits are depleted" },
      }, { status: 402 }))
      .mockResolvedValueOnce(Response.json({
        status: "completed",
        output: [{
          type: "message", role: "assistant", content: [{ type: "output_text", text: answer }],
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateChatCompletion(prompt)).resolves.toEqual({
      provider: "openai", path: "openai_fallback", reason: "gemini_credits_depleted", content: answer,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.openai.com/v1/responses");
  });

  it("discards unpublished Gemini text and does not switch after a safety block", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(geminiSse("SAFETY"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateChatCompletion(prompt)).rejects.toMatchObject({
      code: "gemini_generation_failed",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
