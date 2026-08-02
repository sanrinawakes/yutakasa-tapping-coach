import { NextRequest } from "next/server";
import { POST } from "./route";
import { getSessionFromCookies } from "@/lib/auth";
import {
  addChatMessage,
  getChatMessages,
  getChatThread,
  getDailyUserMessageCount,
  getSubscriberByEmail,
  titleChatThreadFromFirstMessage,
} from "@/lib/supabase";
import { streamChatCompletion } from "@/lib/gemini";

vi.mock("@/lib/auth", () => ({
  getSessionFromCookies: vi.fn(),
}));

vi.mock("@/lib/access-control", () => ({
  evaluateAccess: vi.fn(() => ({ allowed: true, reason: null })),
  accessReasonToMessage: vi.fn(() => "利用できません"),
}));

vi.mock("@/lib/supabase", () => ({
  addChatMessage: vi.fn(),
  getChatMessages: vi.fn(),
  getChatThread: vi.fn(),
  getDailyUserMessageCount: vi.fn(),
  getSubscriberByEmail: vi.fn(),
  titleChatThreadFromFirstMessage: vi.fn(),
}));

vi.mock("@/lib/gemini", () => ({
  streamChatCompletion: vi.fn(),
}));

const THREAD_ID = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";
const MESSAGE_ID = "9bf30543-7667-45bb-82f1-53a3ef9b25b5";

const addMessageMock = vi.mocked(addChatMessage);
const streamMock = vi.mocked(streamChatCompletion);

function chatRequest(message = "仕事の不安を相談したいです") {
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

function textStream(chunks: string[], failAfterChunks = false) {
  let index = 0;
  return new ReadableStream<string>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
        return;
      }
      if (failAfterChunks) {
        controller.error(new Error("provider disconnected"));
      } else {
        controller.close();
      }
    },
  });
}

describe("chat API persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(getDailyUserMessageCount).mockResolvedValue(0);
    vi.mocked(getChatMessages).mockResolvedValue([
      {
        id: MESSAGE_ID,
        thread_id: THREAD_ID,
        role: "user",
        content: "仕事の不安を相談したいです",
        created_at: "2026-08-02T00:00:00.000Z",
      },
    ]);
    addMessageMock.mockResolvedValue({} as never);
    vi.mocked(titleChatThreadFromFirstMessage).mockResolvedValue(null);
  });

  it("uses the client message ID and saves a sanitized assistant reply", async () => {
    streamMock.mockResolvedValue(textStream(["一緒に整理しましょう。", "\n\n[1]"]));

    const response = await POST(chatRequest());
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(responseText).toBe("一緒に整理しましょう。\n\n[1]");
    expect(addMessageMock).toHaveBeenNthCalledWith(
      1,
      THREAD_ID,
      "user",
      "仕事の不安を相談したいです",
      MESSAGE_ID
    );
    expect(addMessageMock).toHaveBeenNthCalledWith(
      2,
      THREAD_ID,
      "assistant",
      "一緒に整理しましょう。",
      expect.any(String)
    );
    expect(titleChatThreadFromFirstMessage).toHaveBeenCalledWith(
      THREAD_ID,
      "member@example.com",
      "仕事の不安を相談したいです"
    );
  });

  it("keeps and labels a partial answer when the provider stream stops", async () => {
    streamMock.mockResolvedValue(textStream(["ここまでの回答です。"], true));

    const response = await POST(chatRequest());
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(responseText).toContain("通信が途中で中断されたため");
    expect(addMessageMock).toHaveBeenNthCalledWith(
      2,
      THREAD_ID,
      "assistant",
      expect.stringContaining("ここまでの回答です。\n\n※通信が途中で中断されたため"),
      expect.any(String)
    );
  });
});
