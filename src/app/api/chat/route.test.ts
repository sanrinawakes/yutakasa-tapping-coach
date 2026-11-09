import { NextRequest } from "next/server";
import { POST } from "./route";
import { getSessionFromCookies } from "@/lib/auth";
import {
  addChatMessage,
  ChatMessageIdConflictError,
  getChatMessageById,
  getChatMessages,
  getChatThread,
  getDailyUserMessageCount,
  getSubscriberByEmail,
  titleChatThreadFromFirstMessage,
  type ChatMessage,
} from "@/lib/supabase";
import { generateChatCompletion } from "@/lib/gemini";
import { DAILY_MESSAGE_LIMIT } from "@/lib/constants";
import { assistantMessageIdFor } from "@/lib/chat-turn-id";
import {
  AI_RESPONSE_NOT_GENERATED_CODE,
  AI_RESPONSE_NOT_GENERATED_MESSAGE,
} from "@/lib/chat-errors";

vi.mock("@/lib/auth", () => ({
  getSessionFromCookies: vi.fn(),
}));

vi.mock("@/lib/access-control", () => ({
  evaluateAccess: vi.fn(() => ({ allowed: true, reason: null })),
  accessReasonToMessage: vi.fn(() => "利用できません"),
}));

vi.mock("@/lib/supabase", () => ({
  addChatMessage: vi.fn(),
  ChatMessageIdConflictError: class ChatMessageIdConflictError extends Error {
    readonly code = "CHAT_MESSAGE_ID_CONFLICT";
  },
  getChatMessageById: vi.fn(),
  getChatMessages: vi.fn(),
  getChatThread: vi.fn(),
  getDailyUserMessageCount: vi.fn(),
  getSubscriberByEmail: vi.fn(),
  titleChatThreadFromFirstMessage: vi.fn(),
}));

vi.mock("@/lib/gemini", () => ({
  GEMINI_GENERATION_FAILED_CODE: "gemini_generation_failed",
  geminiGenerationErrorCode: vi.fn(() => "gemini_credits_depleted"),
  generateChatCompletion: vi.fn(),
}));

const THREAD_ID = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";
const MESSAGE_ID = "9bf30543-7667-45bb-82f1-53a3ef9b25b5";
const ASSISTANT_ID = assistantMessageIdFor(THREAD_ID, MESSAGE_ID);
const USER_TEXT = "仕事の不安を相談したいです";
const ANSWER_TEXT = "一緒に整理しましょう。";
const INTERNAL_FAILURE = "synthetic-private-provider-or-database-detail";

const addMessageMock = vi.mocked(addChatMessage);
const messageByIdMock = vi.mocked(getChatMessageById);
const historyMock = vi.mocked(getChatMessages);
const dailyCountMock = vi.mocked(getDailyUserMessageCount);
const generateMock = vi.mocked(generateChatCompletion);
const rows = new Map<string, ChatMessage>();

function chatRequest(message = USER_TEXT) {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: THREAD_ID,
      message,
      clientMessageId: MESSAGE_ID,
    }),
  });
}

function seedMessage(
  role: ChatMessage["role"],
  content: string,
  id: string,
  threadId = THREAD_ID,
) {
  const message = {
    id,
    thread_id: threadId,
    role,
    content,
    created_at: new Date(Date.UTC(2026, 7, 2, 0, 0, rows.size)).toISOString(),
  } satisfies ChatMessage;
  rows.set(id, message);
  return message;
}

function persistMessage(
  threadId: string,
  role: ChatMessage["role"],
  content: string,
  id = crypto.randomUUID(),
) {
  const prior = rows.get(id);
  if (prior) {
    if (prior.thread_id !== threadId || prior.role !== role ||
        (role === "user" && prior.content !== content)) {
      throw new ChatMessageIdConflictError();
    }
    return { ...prior, inserted: false };
  }
  return { ...seedMessage(role, content, id, threadId), inserted: true };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const geminiAnswer = {
  content: ANSWER_TEXT + "\n\n[1]",
  provider: "gemini",
  path: "gemini",
} as const;

async function expectSafeGenerationFailure(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("x-chat-assistant-id")).toBeNull();
  expect(response.headers.get("x-chat-provider")).toBeNull();
  expect(response.headers.get("x-request-id")).toEqual(expect.any(String));
  expect(await response.json()).toEqual({
    error: AI_RESPONSE_NOT_GENERATED_MESSAGE,
    code: AI_RESPONSE_NOT_GENERATED_CODE,
    userMessageSaved: true,
    assistantResponseGenerated: false,
  });
  expect(rows.get(MESSAGE_ID)?.content).toBe(USER_TEXT);
  expect(rows.has(ASSISTANT_ID)).toBe(false);
}

describe("chat API persistence and retry continuity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rows.clear();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(getSessionFromCookies).mockResolvedValue({
      email: "member@example.com",
      iat: 0,
      exp: 4_102_444_800,
    });
    vi.mocked(getSubscriberByEmail).mockResolvedValue({
      email: "member@example.com",
      status: "active",
      subscription_status: "active",
    } as never);
    vi.mocked(getChatThread).mockResolvedValue({
      id: THREAD_ID,
      user_email: "member@example.com",
      title: "新しいチャット",
      created_at: "2026-08-02T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
    });
    dailyCountMock.mockResolvedValue(0);
    messageByIdMock.mockImplementation(async (threadId, role, id) => {
      const message = rows.get(id);
      return message?.thread_id === threadId && message.role === role ? message : null;
    });
    historyMock.mockImplementation(async (threadId) =>
      [...rows.values()].filter((message) => message.thread_id === threadId),
    );
    addMessageMock.mockImplementation(async (...args) => persistMessage(...args));
    vi.mocked(titleChatThreadFromFirstMessage).mockResolvedValue(null);
    generateMock.mockResolvedValue(geminiAnswer);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the sanitized answer saved under the deterministic assistant ID", async () => {
    const response = await POST(chatRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("x-chat-provider")).toBe("gemini");
    expect(response.headers.get("x-chat-provider-path")).toBe("gemini");
    expect(response.headers.get("x-chat-assistant-id")).toBe(ASSISTANT_ID);
    expect(await response.text()).toBe(ANSWER_TEXT);
    expect(addMessageMock).toHaveBeenNthCalledWith(1, THREAD_ID, "user", USER_TEXT, MESSAGE_ID);
    expect(addMessageMock).toHaveBeenNthCalledWith(2, THREAD_ID, "assistant", ANSWER_TEXT, ASSISTANT_ID);
    expect(rows.get(ASSISTANT_ID)?.content).toBe(ANSWER_TEXT);
    expect(titleChatThreadFromFirstMessage).toHaveBeenCalledWith(
      THREAD_ID, "member@example.com", USER_TEXT,
    );
  });

  it.each(["openai_primary", "openai_fallback", "openai_circuit"] as const)(
    "reports the actual OpenAI route as %s only after saving its answer",
    async (path) => {
      generateMock.mockResolvedValue({
        content: ANSWER_TEXT, provider: "openai", path,
        ...(path === "openai_primary" ? {} : { reason: "gemini_credits_depleted" as const }),
      });

      const response = await POST(chatRequest());

      expect(response.status).toBe(200);
      expect(response.headers.get("x-chat-provider")).toBe("openai");
      expect(response.headers.get("x-chat-provider-path")).toBe(path);
      expect(response.headers.get("x-chat-assistant-id")).toBe(ASSISTANT_ID);
      expect(await response.text()).toBe(rows.get(ASSISTANT_ID)?.content);
      expect(console.info).toHaveBeenCalledWith(
        path === "openai_primary" ? "Chat answer saved" : "Chat fallback answer saved",
        {
          requestId: response.headers.get("x-request-id"),
          assistantId: ASSISTANT_ID,
          path,
          ...(path === "openai_primary" ? {} : { condition: "prepaid_credits_depleted" }),
        }
      );
    },
  );

  it("does not return HTTP success while the assistant save is pending", async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    addMessageMock.mockImplementation(async (...args) => {
      if (args[1] === "assistant") {
        saveStarted.resolve();
        await releaseSave.promise;
      }
      return persistMessage(...args);
    });

    let responseSettled = false;
    const pendingResponse = POST(chatRequest()).finally(() => { responseSettled = true; });
    await saveStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeSave = responseSettled;
    const savedBeforeRelease = rows.has(ASSISTANT_ID);
    releaseSave.resolve();

    const response = await pendingResponse;
    expect(returnedBeforeSave).toBe(false);
    expect(savedBeforeRelease).toBe(false);
    expect(response.status).toBe(200);
    expect(rows.get(ASSISTANT_ID)?.content).toBe(ANSWER_TEXT);
    expect(await response.text()).toBe(ANSWER_TEXT);
  });

  it("returns a fixed 503 without an assistant row when generation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    generateMock.mockRejectedValue(new Error(INTERNAL_FAILURE));

    await expectSafeGenerationFailure(await POST(chatRequest()));

    expect(addMessageMock).toHaveBeenCalledExactlyOnceWith(THREAD_ID, "user", USER_TEXT, MESSAGE_ID);
    expect(consoleError).toHaveBeenCalledWith("Chat AI response generation failed:", {
      requestId: expect.any(String),
      code: "gemini_credits_depleted",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(INTERNAL_FAILURE);
  });

  it("does not save a response consisting only of an internal reference", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    generateMock.mockResolvedValue({ ...geminiAnswer, content: "\n\n[1]" });

    await expectSafeGenerationFailure(await POST(chatRequest()));

    expect(addMessageMock).toHaveBeenCalledExactlyOnceWith(THREAD_ID, "user", USER_TEXT, MESSAGE_ID);
  });

  it("recovers a failed turn with the same ID and then replays the saved answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    generateMock.mockRejectedValueOnce(new Error(INTERNAL_FAILURE));

    await expectSafeGenerationFailure(await POST(chatRequest()));
    dailyCountMock.mockResolvedValue(DAILY_MESSAGE_LIMIT);

    const recovered = await POST(chatRequest());
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("x-chat-provider-path")).toBe("gemini");
    expect(recovered.headers.get("x-chat-assistant-id")).toBe(ASSISTANT_ID);
    expect(await recovered.text()).toBe(ANSWER_TEXT);

    const replayed = await POST(chatRequest());
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("x-chat-provider-path")).toBe("replay");
    expect(replayed.headers.get("x-chat-assistant-id")).toBe(ASSISTANT_ID);
    expect(await replayed.text()).toBe(ANSWER_TEXT);
    expect(dailyCountMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock.mock.calls).toEqual([
      [THREAD_ID, "user", USER_TEXT, MESSAGE_ID],
      [THREAD_ID, "assistant", ANSWER_TEXT, ASSISTANT_ID],
    ]);
  });

  it("returns a fixed 503 rather than the generated answer if saving it fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    addMessageMock.mockImplementation(async (...args) => {
      if (args[1] === "assistant") throw new Error(INTERNAL_FAILURE);
      return persistMessage(...args);
    });

    const response = await POST(chatRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-chat-assistant-id")).toBeNull();
    expect(await response.json()).toMatchObject({
      code: "CHAT_ASSISTANT_SAVE_UNCONFIRMED",
      userMessageSaved: true,
      assistantResponseGenerated: true,
      assistantSaveConfirmed: false,
    });
    expect(rows.has(ASSISTANT_ID)).toBe(false);

    expect(addMessageMock).toHaveBeenCalledWith(THREAD_ID, "assistant", ANSWER_TEXT, ASSISTANT_ID);
    expect(addMessageMock.mock.calls.filter(([, role]) => role === "assistant")
      .every(([, , , id]) => id === ASSISTANT_ID)).toBe(true);
  });

  it("reads back the exact assistant row after a lost save acknowledgment", async () => {
    addMessageMock.mockImplementation(async (...args) => {
      const saved = persistMessage(...args);
      if (args[1] === "assistant") throw new Error(INTERNAL_FAILURE);
      return saved;
    });

    const response = await POST(chatRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ANSWER_TEXT);
    expect(response.headers.get("x-chat-assistant-id")).toBe(ASSISTANT_ID);
    expect(response.headers.get("x-chat-provider")).toBeNull();
    expect(response.headers.get("x-chat-provider-path")).toBe("replay");
    expect(addMessageMock.mock.calls.filter(([, role]) => role === "assistant")).toEqual([
      [THREAD_ID, "assistant", ANSWER_TEXT, ASSISTANT_ID],
    ]);
    expect(messageByIdMock.mock.calls.filter(([, role]) => role === "assistant")).toEqual([
      [THREAD_ID, "assistant", ASSISTANT_ID],
      [THREAD_ID, "assistant", ASSISTANT_ID],
    ]);
  });

  it("replays the persisted answer without a provider call even at the daily limit", async () => {
    seedMessage("user", USER_TEXT, MESSAGE_ID);
    seedMessage("assistant", ANSWER_TEXT, ASSISTANT_ID);
    dailyCountMock.mockResolvedValue(DAILY_MESSAGE_LIMIT);

    const response = await POST(chatRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ANSWER_TEXT);
    expect(response.headers.get("x-chat-provider")).toBeNull();
    expect(response.headers.get("x-chat-provider-path")).toBe("replay");
    expect(response.headers.get("x-chat-assistant-id")).toBe(ASSISTANT_ID);
    expect(messageByIdMock).toHaveBeenCalledWith(THREAD_ID, "user", MESSAGE_ID);
    expect(messageByIdMock).toHaveBeenCalledWith(THREAD_ID, "assistant", ASSISTANT_ID);
    expect(dailyCountMock).not.toHaveBeenCalled();
    expect(historyMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  it("resumes an unanswered saved turn with its original history, not newer turns", async () => {
    seedMessage("user", "前の質問", "d0539579-aa3c-4493-8ed4-c3296b639bd1");
    seedMessage("assistant", "前の回答", "d0539579-aa3c-4493-8ed4-c3296b639bd2");
    seedMessage("user", USER_TEXT, MESSAGE_ID);
    seedMessage("user", "後から送った別の質問", "d0539579-aa3c-4493-8ed4-c3296b639bd3");
    seedMessage("assistant", "後の質問への回答", "d0539579-aa3c-4493-8ed4-c3296b639bd4");
    dailyCountMock.mockResolvedValue(DAILY_MESSAGE_LIMIT);

    const response = await POST(chatRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ANSWER_TEXT);
    expect(dailyCountMock).not.toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalledExactlyOnceWith([
      { role: "user", content: "前の質問" },
      { role: "assistant", content: "前の回答" },
      { role: "user", content: USER_TEXT },
    ]);
    expect(addMessageMock).toHaveBeenCalledExactlyOnceWith(THREAD_ID, "assistant", ANSWER_TEXT, ASSISTANT_ID);
  });

  it("still rejects a new message at the daily limit", async () => {
    dailyCountMock.mockResolvedValue(DAILY_MESSAGE_LIMIT);

    const response = await POST(chatRequest());

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "DAILY_LIMIT_REACHED" });
    expect(dailyCountMock).toHaveBeenCalledExactlyOnceWith("member@example.com");
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("rejects a changed message reusing an existing ID without exposing the old turn", async () => {
    seedMessage("user", USER_TEXT, MESSAGE_ID);
    seedMessage("assistant", ANSWER_TEXT, ASSISTANT_ID);

    const response = await POST(chatRequest("別の質問"));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "CHAT_MESSAGE_ID_CONFLICT" });
    expect(JSON.stringify(body)).not.toContain(USER_TEXT);
    expect(JSON.stringify(body)).not.toContain(ANSWER_TEXT);
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(rows.get(MESSAGE_ID)?.content).toBe(USER_TEXT);
  });

  it("rejects an ID already used in another thread without leaking the other row", async () => {
    seedMessage("user", INTERNAL_FAILURE, MESSAGE_ID, "f34d4562-324b-4114-90d6-09a5e841c32d");

    const response = await POST(chatRequest());

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "CHAT_MESSAGE_ID_CONFLICT" });
    expect(JSON.stringify(body)).not.toContain(INTERNAL_FAILURE);
    expect(addMessageMock).toHaveBeenCalledExactlyOnceWith(THREAD_ID, "user", USER_TEXT, MESSAGE_ID);
    expect(generateMock).not.toHaveBeenCalled();
    expect(rows.get(MESSAGE_ID)?.content).toBe(INTERNAL_FAILURE);
  });

  it("does not read or replay a saved turn for someone else's thread", async () => {
    seedMessage("user", USER_TEXT, MESSAGE_ID);
    seedMessage("assistant", ANSWER_TEXT, ASSISTANT_ID);
    const thread = await getChatThread(THREAD_ID);
    vi.mocked(getChatThread).mockResolvedValue({ ...thread!, user_email: "other@example.com" });

    const response = await POST(chatRequest());

    expect(response.status).toBe(401);
    expect(messageByIdMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  it("joins concurrent same-ID requests to one generation and one saved answer", async () => {
    const generationStarted = deferred<void>();
    const releaseGeneration = deferred<typeof geminiAnswer>();
    generateMock.mockImplementation(() => {
      generationStarted.resolve();
      return releaseGeneration.promise;
    });

    const first = POST(chatRequest());
    await generationStarted.promise;
    const concurrentRetry = POST(chatRequest());
    try {
      await vi.waitFor(() => expect(messageByIdMock.mock.calls.filter(
        ([, role, id]) => role === "user" && id === MESSAGE_ID,
      ).length).toBeGreaterThanOrEqual(2));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      releaseGeneration.resolve(geminiAnswer);
    }

    const responses = await Promise.all([first, concurrentRetry]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.headers.get("x-chat-assistant-id"))).toEqual([
      ASSISTANT_ID, ASSISTANT_ID,
    ]);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      ANSWER_TEXT, ANSWER_TEXT,
    ]);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls.filter(([, role]) => role === "assistant")).toEqual([
      [THREAD_ID, "assistant", ANSWER_TEXT, ASSISTANT_ID],
    ]);
    expect([...rows.keys()]).toEqual([MESSAGE_ID, ASSISTANT_ID]);
  });

  it.each([
    { kind: "different", firstSaved: "別のインスタンスが保存した回答です。" },
    { kind: "identical", firstSaved: ANSWER_TEXT },
  ])(
    "replays a $kind canonical answer without attributing it to the losing instance",
    async ({ firstSaved }) => {
      addMessageMock.mockImplementation(async (...args) => {
        if (args[1] === "assistant") seedMessage("assistant", firstSaved, ASSISTANT_ID);
        return persistMessage(...args);
      });

      const response = await POST(chatRequest());

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(firstSaved);
      expect(response.headers.get("x-chat-assistant-id")).toBe(ASSISTANT_ID);
      expect(response.headers.get("x-chat-provider")).toBeNull();
      expect(response.headers.get("x-chat-provider-path")).toBe("replay");
      expect(rows.get(ASSISTANT_ID)?.content).toBe(firstSaved);
      expect([...rows.keys()]).toEqual([MESSAGE_ID, ASSISTANT_ID]);
    },
  );
});
