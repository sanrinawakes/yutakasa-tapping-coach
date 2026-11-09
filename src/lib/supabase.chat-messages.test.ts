import {
  addChatMessage,
  ChatMessageIdConflictError,
  getChatMessageById,
  type ChatMessage,
} from "./supabase";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from })),
}));

const user: ChatMessage = {
  id: "00000000-0000-4000-8000-000000000001",
  thread_id: "00000000-0000-4000-8000-000000000002",
  role: "user",
  content: "synthetic question",
  created_at: "2026-01-01T00:00:00.000Z",
};

function mockQueries({
  inserted = null,
  existing = null,
  insertError = null,
}: {
  inserted?: ChatMessage | null;
  existing?: ChatMessage | null;
  insertError?: Error | null;
} = {}) {
  const upsert = vi.fn(() => ({
    select: vi.fn(() => ({
      maybeSingle: vi.fn().mockResolvedValue({ data: inserted, error: insertError }),
    })),
  }));
  const readback = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: existing, error: null }),
  };
  const select = vi.fn(() => readback);
  const touch = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ error: null }),
  };
  from.mockImplementation((table: string) => {
    if (table === "chat_messages") return { upsert, select };
    if (table === "chat_threads") return touch;
    throw new Error("unexpected table");
  });
  return { upsert, select, readback, touch };
}

describe("immutable chat message writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPABASE_URL", "https://synthetic.example.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("reports an acknowledged insert without updating a conflicting ID", async () => {
    const { upsert, select, touch } = mockQueries({ inserted: user });

    await expect(addChatMessage(user.thread_id, "user", user.content, user.id))
      .resolves.toEqual({ ...user, inserted: true });
    expect(upsert).toHaveBeenCalledWith({
      id: user.id,
      thread_id: user.thread_id,
      role: "user",
      content: user.content,
    }, { onConflict: "id", ignoreDuplicates: true });
    expect(select).not.toHaveBeenCalled();
    expect(touch.eq).toHaveBeenCalledWith("id", user.thread_id);
  });

  it("reads a duplicate only within its exact conversation and role", async () => {
    const { readback, touch } = mockQueries({ existing: user });

    await expect(addChatMessage(user.thread_id, "user", user.content, user.id))
      .resolves.toEqual({ ...user, inserted: false });
    expect(readback.eq.mock.calls).toEqual([
      ["id", user.id], ["thread_id", user.thread_id], ["role", "user"],
    ]);
    expect(touch.update).not.toHaveBeenCalled();
  });

  it("rejects changed user content without exposing the stored content", async () => {
    const { touch } = mockQueries({ existing: user });

    await expect(addChatMessage(user.thread_id, "user", "changed", user.id))
      .rejects.toMatchObject({
        name: "ChatMessageIdConflictError", code: "CHAT_MESSAGE_ID_CONFLICT",
        message: "CHAT_MESSAGE_ID_CONFLICT",
      });
    expect(touch.update).not.toHaveBeenCalled();
  });

  it("rejects a colliding ID outside the scoped conversation or role", async () => {
    const { readback, touch } = mockQueries();

    await expect(addChatMessage(user.thread_id, "assistant", "new answer", user.id))
      .rejects.toBeInstanceOf(ChatMessageIdConflictError);
    expect(readback.eq.mock.calls).toEqual([
      ["id", user.id], ["thread_id", user.thread_id], ["role", "assistant"],
    ]);
    expect(touch.update).not.toHaveBeenCalled();
  });

  it.each(["another candidate", "canonical answer"])(
    "returns the assistant first winner even with candidate %s",
    async (candidate) => {
      const assistant: ChatMessage = { ...user, role: "assistant", content: "canonical answer" };
      const { touch } = mockQueries({ existing: assistant });

      await expect(addChatMessage(user.thread_id, "assistant", candidate, user.id))
        .resolves.toEqual({ ...assistant, inserted: false });
      expect(touch.update).not.toHaveBeenCalled();
    }
  );

  it("allows a separate readback after an unknown insert acknowledgement without rewriting", async () => {
    const error = new Error("synthetic write acknowledgement lost");
    const { upsert, readback, touch } = mockQueries({ existing: user, insertError: error });

    await expect(addChatMessage(user.thread_id, "user", user.content, user.id)).rejects.toBe(error);
    await expect(getChatMessageById(user.thread_id, "user", user.id)).resolves.toEqual(user);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(readback.eq.mock.calls).toEqual([
      ["id", user.id], ["thread_id", user.thread_id], ["role", "user"],
    ]);
    expect(touch.update).not.toHaveBeenCalled();
  });
});
