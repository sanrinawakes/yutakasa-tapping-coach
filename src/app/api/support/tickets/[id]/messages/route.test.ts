import { NextRequest } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import {
  appendUserSupportMessage,
  getUserSupportTicket,
} from "@/lib/server/support-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/server/support-service", () => ({
  appendUserSupportMessage: vi.fn(),
  getUserSupportTicket: vi.fn(),
}));

const sessionMock = vi.mocked(getSessionFromCookies);
const getTicketMock = vi.mocked(getUserSupportTicket);
const appendMock = vi.mocked(appendUserSupportMessage);
const ticketId = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";
const messageId = "09919e11-742a-41b4-b3f2-8cc3ff86b5cd";
const context = { params: Promise.resolve({ id: ticketId }) };

describe("user support message API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.mockResolvedValue({
      email: "member@example.com",
      iat: 0,
      exp: 4_102_444_800,
    });
  });

  it("does not reveal a ticket that does not belong to the signed-in user", async () => {
    getTicketMock.mockResolvedValue(null);
    const response = await GET(
      new NextRequest(`http://localhost/api/support/tickets/${ticketId}/messages`),
      context
    );
    expect(response.status).toBe(404);
    expect(getTicketMock).toHaveBeenCalledWith("member@example.com", ticketId);
  });

  it("rejects malformed ticket IDs before a database lookup", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/support/tickets/bad/messages"),
      { params: Promise.resolve({ id: "bad" }) }
    );
    expect(response.status).toBe(404);
    expect(getTicketMock).not.toHaveBeenCalled();
  });

  it("appends a message using the authenticated user's email", async () => {
    appendMock.mockResolvedValue({ message_id: messageId, created: true });
    const request = new NextRequest(
      `http://localhost/api/support/tickets/${ticketId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "追加の状況です。",
          clientRequestId: messageId,
        }),
      }
    );
    const response = await POST(request, context);
    expect(response.status).toBe(201);
    expect(appendMock).toHaveBeenCalledWith({
      userEmail: "member@example.com",
      ticketId,
      body: "追加の状況です。",
      clientRequestId: messageId,
      files: [],
    });
  });

  it("rejects message creation when the session is missing", async () => {
    sessionMock.mockResolvedValue(null);
    const response = await POST(
      new NextRequest(
        `http://localhost/api/support/tickets/${ticketId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: "本文", clientRequestId: messageId }),
        }
      ),
      context
    );
    expect(response.status).toBe(401);
    expect(appendMock).not.toHaveBeenCalled();
  });
});
