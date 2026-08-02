import { NextRequest } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import {
  createSupportTicket,
  listUserSupportTickets,
} from "@/lib/server/support-service";
import {
  SupportRequestError,
  validateSupportFiles,
} from "@/lib/server/support-request";
import {
  MAX_SUPPORT_ATTACHMENT_BYTES,
  MAX_SUPPORT_TOTAL_ATTACHMENT_BYTES,
} from "@/lib/support";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/server/support-service", () => ({
  createSupportTicket: vi.fn(),
  listUserSupportTickets: vi.fn(),
}));

const sessionMock = vi.mocked(getSessionFromCookies);
const createMock = vi.mocked(createSupportTicket);
const listMock = vi.mocked(listUserSupportTickets);
const requestId = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";

function jsonRequest(body: unknown) {
  return new NextRequest("http://localhost/api/support/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("user support tickets API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.mockResolvedValue({
      email: "member@example.com",
      iat: 0,
      exp: 4_102_444_800,
    });
  });

  it("rejects unauthenticated history access", async () => {
    sessionMock.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("lists only the authenticated user's tickets", async () => {
    listMock.mockResolvedValue([]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith("member@example.com");
  });

  it("creates a validated ticket with the authenticated email", async () => {
    createMock.mockResolvedValue({
      ticket_id: requestId,
      message_id: requestId,
      created: true,
    });
    const response = await POST(
      jsonRequest({
        category: "technical",
        subject: "  履歴が表示されない  ",
        body: "  画面を更新しても表示されません。  ",
        clientRequestId: requestId,
      })
    );
    expect(response.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith({
      userEmail: "member@example.com",
      category: "technical",
      subject: "履歴が表示されない",
      body: "画面を更新しても表示されません。",
      clientRequestId: requestId,
      files: [],
    });
  });

  it("returns 200 for an idempotent retry instead of creating a duplicate", async () => {
    createMock.mockResolvedValue({
      ticket_id: requestId,
      message_id: requestId,
      created: false,
    });
    const response = await POST(
      jsonRequest({
        category: "quality",
        subject: "回答について",
        body: "回答が短すぎます。",
        clientRequestId: requestId,
      })
    );
    expect(response.status).toBe(200);
  });

  it("rejects an unknown category before writing to the database", async () => {
    const response = await POST(
      jsonRequest({
        category: "unknown",
        subject: "件名",
        body: "本文",
        clientRequestId: requestId,
      })
    );
    expect(response.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects more than three attachments", async () => {
    const form = new FormData();
    form.set("category", "technical");
    form.set("subject", "添付確認");
    form.set("body", "画像を確認してください");
    form.set("clientRequestId", requestId);
    for (let index = 0; index < 4; index += 1) {
      form.append(
        "attachments",
        new File([new Uint8Array([0xff, 0xd8, 0xff])], `${index}.jpg`, {
          type: "image/jpeg",
        })
      );
    }
    const response = await POST(
      new NextRequest("http://localhost/api/support/tickets", {
        method: "POST",
        body: form,
      })
    );
    expect(response.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects an attachment larger than 4MB before writing", async () => {
    const largeFile = new File(
      [new Uint8Array(MAX_SUPPORT_ATTACHMENT_BYTES + 1)],
      "large.jpg",
      {
        type: "image/jpeg",
      }
    );
    expect(() => validateSupportFiles([largeFile])).toThrow(
      "画像は1枚4MB以下にしてください。"
    );
  });

  it("rejects attachments whose combined size exceeds 4MB", async () => {
    const halfPlusOne = Math.floor(MAX_SUPPORT_TOTAL_ATTACHMENT_BYTES / 2) + 1;
    const files = Array.from({ length: 2 }, (_, index) =>
      new File([new Uint8Array(halfPlusOne)], `${index}.jpg`, {
        type: "image/jpeg",
      })
    );
    expect(() => validateSupportFiles(files)).toThrow(
      "画像は合計4MB以下にしてください。"
    );
  });

  it("returns a specific 400 error for an invalid image detected by storage", async () => {
    createMock.mockRejectedValue(
      new SupportRequestError(
        "PNG、JPEG、WebP、HEIC形式の画像を添付してください。"
      )
    );

    const response = await POST(
      jsonRequest({
        category: "technical",
        subject: "画像確認",
        body: "画像を添付しました。",
        clientRequestId: requestId,
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "PNG、JPEG、WebP、HEIC形式の画像を添付してください。",
    });
  });
});
