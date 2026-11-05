import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatPage from "./page";
import { AI_RESPONSE_NOT_GENERATED_MESSAGE } from "@/lib/chat-errors";

const push = vi.fn();
const router = { push };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("@/components/ChatSidebar", () => ({
  default: () => <div data-testid="sidebar" />,
}));

vi.mock("@/components/ChatMessages", () => ({
  default: () => <div data-testid="messages" />,
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

  it("does not create empty threads just by opening the page", async () => {
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

  it("shows that a saved input has no AI answer without exposing a stream error", async () => {
    const thread = {
      id: "thread-existing",
      user_email: "member@example.com",
      title: "相談",
      created_at: "2026-11-05T00:00:00.000Z",
      updated_at: "2026-11-05T00:00:00.000Z",
    };
    let savedMessageId: string | null = null;
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
                ]
              : [],
          });
        }
        if (url === "/api/chat" && init?.method === "POST") {
          const requestBody = JSON.parse(init.body as string) as {
            clientMessageId: string;
          };
          savedMessageId = requestBody.clientMessageId;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
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
    expect(alert).toHaveTextContent(AI_RESPONSE_NOT_GENERATED_MESSAGE);
    expect(alert).not.toHaveTextContent(rawProviderError);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(rawProviderError);
    consoleError.mockRestore();
  });
});
