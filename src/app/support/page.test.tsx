import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import SupportPage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

const routerMock = vi.mocked(useRouter);
const ticketId = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";

describe("SupportPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routerMock.mockReturnValue({ push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  });

  it("creates a ticket with screenshots and opens the persisted conversation", async () => {
    let created = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/support/tickets" && init?.method === "POST") {
        const form = init.body as FormData;
        expect(form.get("category")).toBe("technical");
        expect(form.get("subject")).toBe("履歴が消えました");
        expect(form.get("body")).toBe("昨日の会話が表示されません。");
        expect(form.getAll("attachments")).toHaveLength(1);
        expect(form.get("clientRequestId")).toMatch(/^[0-9a-f-]{36}$/u);
        created = true;
        return Response.json(
          { ticket_id: ticketId, message_id: ticketId, created: true },
          { status: 201 }
        );
      }
      if (url === "/api/support/tickets") {
        return Response.json({
          tickets: created
            ? [
                {
                  id: ticketId,
                  category: "technical",
                  subject: "履歴が消えました",
                  status: "open",
                  created_at: "2026-08-02T00:00:00.000Z",
                  updated_at: "2026-08-02T00:00:00.000Z",
                  last_message: "お問い合わせを受け付けました。",
                  last_message_at: "2026-08-02T00:00:00.000Z",
                  has_unread_reply: false,
                },
              ]
            : [],
        });
      }
      if (url === `/api/support/tickets/${ticketId}/messages`) {
        return Response.json({
          ticket: {
            id: ticketId,
            category: "technical",
            subject: "履歴が消えました",
            status: "open",
          },
          messages: [
            {
              id: ticketId,
              sender_type: "system",
              body: "お問い合わせを受け付けました。内容を確認して対応します。",
              created_at: "2026-08-02T00:00:00.000Z",
              attachments: [],
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SupportPage />);
    expect(await screen.findByText("問い合わせはまだありません")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "新規問い合わせ" }));
    await user.type(screen.getByLabelText("件名"), "履歴が消えました");
    await user.type(
      screen.getByLabelText("内容"),
      "昨日の会話が表示されません。"
    );
    const image = new File(
      [new Uint8Array([0xff, 0xd8, 0xff])],
      "screen.jpg",
      { type: "image/jpeg" }
    );
    await user.upload(screen.getByLabelText("画像を選択"), image);
    await user.click(screen.getByRole("button", { name: "送信する" }));

    expect(
      await screen.findByText("お問い合わせを受け付けました。内容を確認して対応します。")
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/support/tickets",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("redirects to login when the support session has expired", async () => {
    const push = vi.fn();
    routerMock.mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: "Unauthorized" }, { status: 401 })
      )
    );

    render(<SupportPage />);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });
});
