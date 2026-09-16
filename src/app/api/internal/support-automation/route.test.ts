import { NextRequest } from "next/server";
import {
  addSupportWorkLog,
  appendAutomationSupportMessage,
  claimSupportTicket,
  finishLockedSupportTicket,
  getAdminSupportTicket,
  listPendingAutomatedSupportTickets,
  renewSupportAutomationLock,
} from "@/lib/server/support-service";
import { GET, PATCH } from "./route";

vi.mock("@/lib/server/support-service", () => ({
  addSupportWorkLog: vi.fn(),
  appendAutomationSupportMessage: vi.fn(),
  claimSupportTicket: vi.fn(),
  finishLockedSupportTicket: vi.fn(),
  getAdminSupportTicket: vi.fn(),
  listPendingAutomatedSupportTickets: vi.fn(),
  renewSupportAutomationLock: vi.fn(),
}));

const addLogMock = vi.mocked(addSupportWorkLog);
const appendMock = vi.mocked(appendAutomationSupportMessage);
const claimMock = vi.mocked(claimSupportTicket);
const finishLockedMock = vi.mocked(finishLockedSupportTicket);
const detailMock = vi.mocked(getAdminSupportTicket);
const listMock = vi.mocked(listPendingAutomatedSupportTickets);
const renewLockMock = vi.mocked(renewSupportAutomationLock);
const ticketId = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";
const lockToken = "09919e11-742a-41b4-b3f2-8cc3ff86b5cd";
const messageId = "a61fb99e-874b-4111-a95a-4f4cb268e48c";
const secret = "support-automation-secret-with-32-characters";
const ticket = {
  id: ticketId,
  user_email: "member@example.com",
  category: "technical" as const,
  subject: "送信できない",
  status: "in_progress" as const,
  decision_required: false,
  automation_status: "investigating" as const,
  automation_locked_at: "2026-08-02T00:00:00.000Z",
  automation_lock_token: lockToken,
  user_last_read_at: null,
  admin_last_read_at: null,
  created_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z",
};

function request(method: "GET" | "PATCH", body?: unknown, token = secret, query = "") {
  return new NextRequest(`http://localhost/api/internal/support-automation${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(query ? { "x-automation-lock-token": lockToken } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("support automation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = secret;
    renewLockMock.mockResolvedValue(ticket);
    addLogMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("rejects an invalid automation secret", async () => {
    const response = await GET(request("GET", undefined, "wrong-secret"));
    expect(response.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("returns only queued technical tickets through the service", async () => {
    listMock.mockResolvedValue([]);
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith(10);
  });

  it("re-reads claimed history without marking it read or exposing email and attachments", async () => {
    detailMock.mockResolvedValue({
      ticket,
      messages: [{ id: messageId, ticket_id: ticketId, sender_type: "user",
        sender_email: "member@example.com", body: "追加相談", created_at: ticket.updated_at,
        attachments: [{ id: messageId, filename: "secret.jpg", content_type: "image/jpeg",
          size_bytes: 3, url: "https://example.com/secret" }] }],
      work_logs: [],
    });
    const response = await GET(request("GET", undefined, secret,
      `?ticketId=${ticketId}`));
    expect(response.status).toBe(200);
    expect(renewLockMock).toHaveBeenCalledWith(ticketId, lockToken);
    expect(detailMock).toHaveBeenCalledWith(ticketId, { markRead: false });
    const body = await response.json();
    expect(body.messages[0].body).toBe("追加相談");
    expect(JSON.stringify(body)).not.toContain("member@example.com");
    expect(JSON.stringify(body)).not.toContain("secret.jpg");
    expect(JSON.stringify(body)).not.toContain("https://example.com/secret");
  });

  it("rejects a claimed detail read after an administrator replaces the lock", async () => {
    detailMock.mockResolvedValue({
      ticket: { ...ticket, automation_lock_token: "f41fb99e-874b-4111-a95a-4f4cb268e48c" },
      messages: [], work_logs: [],
    });
    const response = await GET(request("GET", undefined, secret, `?ticketId=${ticketId}`));
    expect(response.status).toBe(409);
  });

  it("uses an atomic claim and returns 409 when another worker already claimed it", async () => {
    claimMock.mockResolvedValue(null);
    const response = await PATCH(
      request("PATCH", { action: "claim", ticketId, lockToken })
    );
    expect(response.status).toBe(409);
    expect(addLogMock).not.toHaveBeenCalled();
  });

  it("does not write progress without the matching lock", async () => {
    renewLockMock.mockResolvedValue(null);
    const response = await PATCH(
      request("PATCH", {
        action: "log",
        ticketId,
        lockToken,
        summary: "調査中",
      })
    );
    expect(response.status).toBe(409);
    expect(addLogMock).not.toHaveBeenCalled();
  });

  it("renews the lock before recording progress", async () => {
    const response = await PATCH(
      request("PATCH", {
        action: "log",
        ticketId,
        lockToken,
        summary: "調査を継続しています。",
      })
    );
    expect(response.status).toBe(200);
    expect(renewLockMock).toHaveBeenCalledWith(ticketId, lockToken);
    expect(addLogMock).toHaveBeenCalled();
  });

  it("sends a verified reply once and marks automation complete", async () => {
    appendMock.mockResolvedValue({ message_id: messageId, created: true });
    detailMock.mockResolvedValue({ ticket, messages: [{
      id: messageId, ticket_id: ticketId, sender_type: "user",
      sender_email: "member@example.com", body: "送信できません",
      created_at: ticket.updated_at, attachments: [],
    }], work_logs: [] });
    const response = await PATCH(
      request("PATCH", {
        action: "reply",
        ticketId,
        lockToken,
        clientRequestId: messageId,
        body: "原因を修正し、保存と再読み込みを確認しました。",
        resolve: true,
        latestUserMessageId: messageId,
        releasePrNumber: 37,
      })
    );
    expect(response.status).toBe(201);
    expect(appendMock).toHaveBeenCalledWith({
      ticketId,
      lockToken,
      latestUserMessageId: messageId,
      body: "原因を修正し、保存と再読み込みを確認しました。",
      clientRequestId: messageId,
      resolve: true,
      releasePrNumber: 37,
    });
    expect(addLogMock).not.toHaveBeenCalled();
  });

  it("blocks reply after a new user message or owner decision", async () => {
    detailMock.mockResolvedValue({ ticket, messages: [{
      id: "c27fb99e-874b-4111-a95a-4f4cb268e48c", ticket_id: ticketId,
      sender_type: "user", sender_email: "member@example.com", body: "返金してください",
      created_at: ticket.updated_at, attachments: [],
    }], work_logs: [] });
    const response = await PATCH(request("PATCH", {
      action: "reply", ticketId, lockToken, clientRequestId: messageId,
      latestUserMessageId: messageId, releasePrNumber: 37,
      body: "原因を修正しました。", resolve: true,
    }));
    expect(response.status).toBe(409);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("blocks automatic reply when an attachment could contain an owner decision", async () => {
    detailMock.mockResolvedValue({ ticket, messages: [{
      id: messageId, ticket_id: ticketId, sender_type: "user",
      sender_email: "member@example.com", body: "添付を見てください",
      created_at: ticket.updated_at,
      attachments: [{ id: messageId, filename: "request.png", content_type: "image/png",
        size_bytes: 3, url: null }],
    }], work_logs: [] });
    const response = await PATCH(request("PATCH", {
      action: "reply", ticketId, lockToken, clientRequestId: messageId,
      latestUserMessageId: messageId, releasePrNumber: 37,
      body: "確認しました。", resolve: true,
    }));
    expect(response.status).toBe(409);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("blocks automatic reply to text outside the reviewed Japanese classifier", async () => {
    detailMock.mockResolvedValue({ ticket, messages: [{
      id: messageId, ticket_id: ticketId, sender_type: "user",
      sender_email: "member@example.com", body: "Please delete my personal data",
      created_at: ticket.updated_at, attachments: [],
    }], work_logs: [] });
    const response = await PATCH(request("PATCH", {
      action: "reply", ticketId, lockToken, clientRequestId: messageId,
      latestUserMessageId: messageId, releasePrNumber: 37,
      body: "確認しました。", resolve: true,
    }));
    expect(response.status).toBe(409);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("allows an uncertain HTTP reply result to be retried without another message", async () => {
    appendMock.mockResolvedValue({ message_id: messageId, created: false });
    detailMock.mockResolvedValue({
      ticket: { ...ticket, status: "resolved", automation_status: "completed",
        automation_lock_token: null },
      messages: [{ id: messageId, ticket_id: ticketId, sender_type: "user",
        sender_email: "member@example.com", body: "送信できません",
        created_at: ticket.updated_at, attachments: [] }],
      work_logs: [],
    });
    const response = await PATCH(request("PATCH", {
      action: "reply", ticketId, lockToken, clientRequestId: messageId,
      latestUserMessageId: messageId, releasePrNumber: 37,
      body: "原因を修正し、保存と再読み込みを確認しました。", resolve: true,
    }));
    expect(response.status).toBe(200);
    expect(renewLockMock).not.toHaveBeenCalled();
    expect(appendMock).toHaveBeenCalledOnce();
  });

  it("blocks business decisions without replying to the customer", async () => {
    finishLockedMock.mockResolvedValue({ ...ticket, decision_required: true });
    const response = await PATCH(
      request("PATCH", {
        action: "decision_required",
        ticketId,
        lockToken,
        latestUserMessageId: messageId,
        ticketVersion: ticket.updated_at,
        summary: "返金可否の判断が必要です。",
      })
    );
    expect(response.status).toBe(200);
    expect(finishLockedMock).toHaveBeenCalledWith({
      ticketId,
      lockToken,
      latestUserMessageId: messageId,
      ticketVersion: ticket.updated_at,
      outcome: "decision_required",
    });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("does not log or overwrite a terminal state when the guarded update loses ownership", async () => {
    finishLockedMock.mockResolvedValue(null);
    const response = await PATCH(request("PATCH", {
      action: "failed", ticketId, lockToken, latestUserMessageId: messageId,
      ticketVersion: ticket.updated_at, summary: "再調査が必要です。",
    }));
    expect(response.status).toBe(409);
    expect(addLogMock).not.toHaveBeenCalled();
  });

  it("returns an uncertain failure if the terminal update succeeds but its work log fails", async () => {
    finishLockedMock.mockResolvedValue({ ...ticket, automation_status: "failed" });
    addLogMock.mockRejectedValue(new Error("database log unavailable"));
    const response = await PATCH(request("PATCH", {
      action: "failed", ticketId, lockToken, latestUserMessageId: messageId,
      ticketVersion: ticket.updated_at, summary: "再調査が必要です。",
    }));
    expect(response.status).toBe(500);
    expect(finishLockedMock).toHaveBeenCalledOnce();
    expect(addLogMock).toHaveBeenCalledOnce();
  });
});
