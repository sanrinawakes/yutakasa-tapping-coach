import { NextRequest } from "next/server";
import {
  addSupportWorkLog,
  appendAdminSupportMessage,
  claimSupportTicket,
  listPendingAutomatedSupportTickets,
  renewSupportAutomationLock,
  updateAdminSupportTicket,
} from "@/lib/server/support-service";
import { GET, PATCH } from "./route";

vi.mock("@/lib/server/support-service", () => ({
  addSupportWorkLog: vi.fn(),
  appendAdminSupportMessage: vi.fn(),
  claimSupportTicket: vi.fn(),
  listPendingAutomatedSupportTickets: vi.fn(),
  renewSupportAutomationLock: vi.fn(),
  updateAdminSupportTicket: vi.fn(),
}));

const addLogMock = vi.mocked(addSupportWorkLog);
const appendMock = vi.mocked(appendAdminSupportMessage);
const claimMock = vi.mocked(claimSupportTicket);
const listMock = vi.mocked(listPendingAutomatedSupportTickets);
const renewLockMock = vi.mocked(renewSupportAutomationLock);
const updateMock = vi.mocked(updateAdminSupportTicket);
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
  user_last_read_at: null,
  admin_last_read_at: null,
  created_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z",
};

function request(method: "GET" | "PATCH", body?: unknown, token = secret) {
  return new NextRequest("http://localhost/api/internal/support-automation", {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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
    updateMock.mockResolvedValue(ticket);
    const response = await PATCH(
      request("PATCH", {
        action: "reply",
        ticketId,
        lockToken,
        clientRequestId: messageId,
        body: "原因を修正し、保存と再読み込みを確認しました。",
        resolve: true,
      })
    );
    expect(response.status).toBe(201);
    expect(appendMock).toHaveBeenCalledWith({
      ticketId,
      body: "原因を修正し、保存と再読み込みを確認しました。",
      clientRequestId: messageId,
      resolve: true,
    });
    expect(updateMock).toHaveBeenCalledWith({
      ticketId,
      automationStatus: "completed",
    });
  });

  it("blocks business decisions without replying to the customer", async () => {
    updateMock.mockResolvedValue({ ...ticket, decision_required: true });
    const response = await PATCH(
      request("PATCH", {
        action: "decision_required",
        ticketId,
        lockToken,
        summary: "返金可否の判断が必要です。",
      })
    );
    expect(response.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      ticketId,
      decisionRequired: true,
    });
    expect(appendMock).not.toHaveBeenCalled();
  });
});
