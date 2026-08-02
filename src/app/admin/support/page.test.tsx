import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminSupportPage from "./page";

const ticketId = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";

function ticket(resolved: boolean) {
  return {
    id: ticketId,
    user_email: "member@example.com",
    category: "technical",
    subject: "履歴が表示されない",
    status: resolved ? "resolved" : "open",
    decision_required: false,
    automation_status: resolved ? "completed" : "queued",
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:01:00.000Z",
    last_message: resolved ? "自動対応が完了しました。" : "履歴が表示されません。",
    last_message_at: "2026-08-02T00:01:00.000Z",
    has_unread_message: false,
  };
}

describe("AdminSupportPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.localStorage.setItem("admin-login-support-token", "a".repeat(32));
  });

  it("refreshes the open ticket detail as well as the list", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/support?")) {
        return Response.json({ tickets: [ticket(resolved)] });
      }
      if (url === `/api/admin/support/${ticketId}`) {
        return Response.json({
          ticket: ticket(resolved),
          messages: [
            {
              id: "a61fb99e-874b-4111-a95a-4f4cb268e48c",
              sender_type: resolved ? "admin" : "user",
              sender_email: resolved ? null : "member@example.com",
              body: resolved
                ? "自動対応が完了しました。"
                : "履歴が表示されません。",
              created_at: "2026-08-02T00:01:00.000Z",
              attachments: [],
            },
          ],
          work_logs: resolved
            ? [
                {
                  id: "dd31d5c4-8aa3-45ab-8f90-567a32342049",
                  event_type: "automation_resolved",
                  summary: "排他制御を確認しました。",
                  metadata: {},
                  created_at: "2026-08-02T00:01:00.000Z",
                },
              ]
            : [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSupportPage />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "対応状態" })).toHaveValue(
        "open"
      )
    );

    resolved = true;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "再読み込み" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "対応状態" })).toHaveValue(
        "resolved"
      )
    );
    expect(screen.getByText("排他制御を確認しました。")).toBeInTheDocument();
  });
});
