import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatPage from "./page";

const push = vi.fn();
const router = { push };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("@/components/ChatSidebar", () => ({
  default: () => <div data-testid="sidebar" />,
}));

vi.mock("@/components/ChatMessages", () => ({
  default: ({ messages }: { messages: { id: string; content: string }[] }) => (
    <div data-testid="messages">{messages.map(({ id, content }) =>
      <p key={id}>{content}</p>
    )}</div>
  ),
}));

vi.mock("@/components/ChatInput", () => ({
  default: ({ onSendMessage }: { onSendMessage: (message: string) => void }) => (
    <button onClick={() => onSendMessage("最初の相談です")}>テスト送信</button>
  ),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ChatPage initialization", () => {
  beforeEach(() => {
    push.mockReset();
  });

  it("no longer shows the outage notice and does not create an empty thread", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      void init;
      if (url === "/api/threads") {
        return jsonResponse({ threads: [], email: "member@example.com" });
      }
      if (url === "/api/chat/usage") {
        return jsonResponse({ remaining: 15, limit: 15 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <ChatPage />
      </StrictMode>
    );

    // Answers recovered (2026-11-11): the outage notice is gone.
    expect(
      screen.queryByRole("status", { name: "サービスのお知らせ" })
    ).toBeNull();
    expect(
      screen.queryByText(/回答が返らない不具合/)
    ).toBeNull();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/threads");
    });
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/threads" && init?.method === "POST"
      )
    ).toHaveLength(0);
  });

  it("creates a thread and still sends the first typed message", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url === "/api/threads" && !init?.method) {
          return jsonResponse({ threads: [], email: "member@example.com" });
        }
        if (url === "/api/chat/usage") {
          return jsonResponse({ remaining: 15, limit: 15 });
        }
        if (url === "/api/threads" && init?.method === "POST") {
          return jsonResponse({
            thread: {
              id: "thread-new",
              user_email: "member@example.com",
              title: "新しいチャット",
              created_at: "2026-08-02T00:00:00.000Z",
              updated_at: "2026-08-02T00:00:00.000Z",
            },
          });
        }
        if (url === "/api/chat" && init?.method === "POST") {
          return new Response("相談を受け付けました。", { status: 200 });
        }
        if (url === "/api/threads/thread-new") {
          return jsonResponse({
            thread: { id: "thread-new" },
            messages: [],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/threads"));
    fireEvent.click(screen.getByRole("button", { name: "テスト送信" }));

    await waitFor(() => {
      const chatCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/chat" && init?.method === "POST"
      );
      expect(chatCall).toBeDefined();
      expect(JSON.parse(chatCall?.[1]?.body as string)).toEqual({
        threadId: "thread-new",
        message: "最初の相談です",
        clientMessageId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        ),
      });
    });
  });

  it("does not show partial text and retries the saved turn with the same ID", async () => {
    const thread = {
      id: "thread-existing",
      user_email: "member@example.com",
      title: "相談",
      created_at: "2026-11-05T00:00:00.000Z",
      updated_at: "2026-11-05T00:00:00.000Z",
    };
    let savedMessageId: string | null = null;
    let replySaved = false;
    const attemptedIds: string[] = [];
    const assistantId = "e69178e6-e754-8132-9559-0610314f5e5d";
    const reply = "再試行で返った回答です。";
    const rawProviderError = "402 Payment Required: secret provider detail";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url === "/api/threads" && !init?.method) {
          return jsonResponse({ threads: [thread], email: "member@example.com" });
        }
        if (url === "/api/chat/usage") {
          return jsonResponse({ remaining: 14, limit: 15 });
        }
        if (url === "/api/threads/thread-existing") {
          return jsonResponse({
            thread,
            messages: savedMessageId
              ? [
                  {
                    id: savedMessageId,
                    thread_id: thread.id,
                    role: "user",
                    content: "最初の相談です",
                    created_at: "2026-11-05T00:00:01.000Z",
                  },
                  ...(replySaved ? [{
                    id: assistantId,
                    thread_id: thread.id,
                    role: "assistant",
                    content: reply,
                    created_at: "2026-11-05T00:00:02.000Z",
                  }] : []),
                ]
              : [],
          });
        }
        if (url === "/api/chat" && init?.method === "POST") {
          const requestBody = JSON.parse(init.body as string) as {
            clientMessageId: string;
          };
          savedMessageId = requestBody.clientMessageId;
          attemptedIds.push(savedMessageId);
          if (attemptedIds.length > 1) {
            replySaved = true;
            return new Response(reply, { headers: { "X-Chat-Assistant-Id": assistantId } });
          }
          let sentChunk = false;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!sentChunk) {
                  sentChunk = true;
                  controller.enqueue(new TextEncoder().encode("表示してはいけない途中の回答"));
                  return;
                }
                controller.error(new Error(rawProviderError));
              },
            }),
            { status: 200 }
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(<ChatPage />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/threads/thread-existing")
    );
    fireEvent.click(screen.getByRole("button", { name: "テスト送信" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("送信結果を確認できませんでした。同じ内容で再試行してください。");
    expect(alert).not.toHaveTextContent(rawProviderError);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(rawProviderError);
    expect(screen.queryByText("表示してはいけない途中の回答")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "テスト送信" }));
    expect(await screen.findByText(reply)).toBeInTheDocument();
    expect(attemptedIds).toEqual([savedMessageId, savedMessageId]);
    expect(screen.getAllByText(reply)).toHaveLength(1);
    expect(screen.getAllByText("最初の相談です")).toHaveLength(1);
    consoleError.mockRestore();
  });
});
