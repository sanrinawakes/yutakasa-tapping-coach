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
    expect(screen.queryByText("管理トークン")).not.toBeInTheDocument();
    await waitFor(
      () =>
        expect(screen.getByRole("combobox", { name: "対応状態" })).toHaveValue(
          "open"
        ),
      { timeout: 3_000 }
    );

    resolved = true;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "再読み込み" }));

    await waitFor(
      () =>
        expect(screen.getByRole("combobox", { name: "対応状態" })).toHaveValue(
          "resolved"
        ),
      { timeout: 3_000 }
    );
    expect(screen.getByText("排他制御を確認しました。")).toBeInTheDocument();
  });

  it("shows a private draft only as an editable human reply with resolution off", async () => {
    const latestUserId = "a61fb99e-874b-4111-a95a-4f4cb268e48c";
    const draftBody = "送信した画面と時刻、今の表示を教えてください。";
    const fetchMock=vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/admin/support/${ticketId}/messages` && init?.method === "POST")
        return Response.json({message_id:"dd31d5c4-8aa3-45ab-8f90-567a32342049",created:true});
      if (url.startsWith("/api/admin/support?")) return Response.json({tickets:[{
        ...ticket(false),status:"in_progress",automation_status:"manual_review",
      }]});
      if (url === `/api/admin/support/${ticketId}`) return Response.json({
        ticket:{...ticket(false),status:"in_progress",automation_status:"manual_review"},
        messages:[{id:latestUserId,sender_type:"user",sender_email:"member@example.com",
          body:"送信できません",created_at:"2026-08-02T00:01:00.000Z",attachments:[]}],
        work_logs:[],reply_draft:{work_id:"a1fc220d-19a8-447a-a19d-feac919af642",
          latest_user_message_id:latestUserId,pr_number:91,body:draftBody,
          created_at:"2026-08-02T00:01:00.000Z"},
      });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch",fetchMock);
    render(<AdminSupportPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button",{name:"返信欄へ入れる"}));
    expect(screen.getByRole("textbox",{name:"利用者へ返信"})).toHaveValue(draftBody);
    expect(screen.getByRole("checkbox",{name:"この返信で対応完了にする"})).not.toBeChecked();
    expect(screen.getByRole("checkbox",{name:"この返信で対応完了にする"})).toBeDisabled();
    expect(screen.getByText(/この方の症状が解消した証拠はありません/)).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"返信を送信"}));
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/support/${ticketId}/messages`,expect.objectContaining({method:"POST"})));
    const send=fetchMock.mock.calls.find((call)=>String(call[0]).endsWith("/messages"));
    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({
      body:draftBody,resolve:false,expectedLatestUserMessageId:latestUserId,
      draftWorkId:"a1fc220d-19a8-447a-a19d-feac919af642",
    });
  });
});
