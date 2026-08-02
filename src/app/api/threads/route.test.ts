import { NextRequest } from "next/server";
import { GET, PATCH, POST } from "./route";
import { getSessionFromCookies } from "@/lib/auth";
import {
  createChatThread,
  getChatThread,
  getUserChatThreads,
  updateChatThreadTitle,
} from "@/lib/supabase";

vi.mock("@/lib/auth", () => ({
  getSessionFromCookies: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  createChatThread: vi.fn(),
  getChatThread: vi.fn(),
  getUserChatThreads: vi.fn(),
  updateChatThreadTitle: vi.fn(),
}));

const sessionMock = vi.mocked(getSessionFromCookies);
const createThreadMock = vi.mocked(createChatThread);
const getThreadMock = vi.mocked(getChatThread);
const getThreadsMock = vi.mocked(getUserChatThreads);
const updateTitleMock = vi.mocked(updateChatThreadTitle);

const thread = {
  id: "2e4710db-9274-4e4c-96c4-59dc97e21c8d",
  user_email: "member@example.com",
  title: "新しいチャット",
  created_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z",
};

function request(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/threads", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("threads API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.mockResolvedValue({
      email: "member@example.com",
      iat: 0,
      exp: 4_102_444_800,
    });
  });

  it("returns the signed-in email with the history", async () => {
    getThreadsMock.mockResolvedValue([thread]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      threads: [thread],
      email: "member@example.com",
    });
  });

  it("does not allow one member to rename another member's thread", async () => {
    getThreadMock.mockResolvedValue({
      ...thread,
      user_email: "other@example.com",
    });

    const response = await PATCH(
      request("PATCH", { threadId: thread.id, title: "変更後" })
    );

    expect(response.status).toBe(403);
    expect(updateTitleMock).not.toHaveBeenCalled();
  });

  it("normalizes a title before saving it", async () => {
    getThreadMock.mockResolvedValue(thread);
    updateTitleMock.mockResolvedValue({ ...thread, title: "家族との関係" });

    const response = await PATCH(
      request("PATCH", {
        threadId: thread.id,
        title: "  家族との\n関係  ",
      })
    );

    expect(response.status).toBe(200);
    expect(updateTitleMock).toHaveBeenCalledWith(
      thread.id,
      "member@example.com",
      "家族との 関係"
    );
  });

  it("uses the default title when a new chat has no supplied title", async () => {
    createThreadMock.mockResolvedValue(thread);

    const response = await POST(request("POST", {}));

    expect(response.status).toBe(200);
    expect(createThreadMock).toHaveBeenCalledWith(
      "member@example.com",
      "新しいチャット"
    );
  });
});
