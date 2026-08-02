import { getSupabase } from "@/lib/supabase";
import {
  appendUserSupportMessage,
  claimSupportTicket,
  createSupportTicket,
  listPendingAutomatedSupportTickets,
  recoverStaleSupportAutomationTickets,
  renewSupportAutomationLock,
} from "./support-service";

vi.mock("@/lib/supabase", () => ({ getSupabase: vi.fn() }));

const getSupabaseMock = vi.mocked(getSupabase);
const ticketId = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";
const lockToken = "09919e11-742a-41b4-b3f2-8cc3ff86b5cd";

function ticket() {
  return {
    id: ticketId,
    user_email: "member@example.com",
    category: "technical",
    subject: "送信できない",
    status: "in_progress",
    decision_required: false,
    automation_status: "investigating",
    automation_locked_at: "2026-08-02T00:00:00.000Z",
    automation_lock_token: lockToken,
    user_last_read_at: null,
    admin_last_read_at: null,
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
  };
}

describe("support automation leases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers an abandoned investigation and records why it was requeued", async () => {
    const ticketQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: ticketId }], error: null }),
    };
    const workLogQuery = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    const from = vi.fn((table: string) =>
      table === "support_tickets" ? ticketQuery : workLogQuery
    );
    getSupabaseMock.mockReturnValue({ from } as never);

    await expect(recoverStaleSupportAutomationTickets()).resolves.toEqual([
      ticketId,
    ]);
    expect(ticketQuery.or).toHaveBeenCalledWith(
      "automation_locked_at.is.null,automation_locked_at.lt.2026-08-02T00:30:00.000Z"
    );
    expect(workLogQuery.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        ticket_id: ticketId,
        event_type: "automation_lock_recovered",
      }),
    ]);
  });

  it("recovers stale work before listing the next queue", async () => {
    const recoveryQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const listQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const from = vi
      .fn()
      .mockReturnValueOnce(recoveryQuery)
      .mockReturnValueOnce(listQuery);
    getSupabaseMock.mockReturnValue({ from } as never);

    await expect(listPendingAutomatedSupportTickets(100)).resolves.toEqual([]);
    expect(recoveryQuery.update).toHaveBeenCalled();
    expect(listQuery.limit).toHaveBeenCalledWith(25);
  });

  it("claims only an unlocked queued ticket", async () => {
    const claimQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: ticket(), error: null }),
    };
    getSupabaseMock.mockReturnValue({
      from: vi.fn().mockReturnValue(claimQuery),
    } as never);

    await expect(claimSupportTicket(ticketId, lockToken)).resolves.toMatchObject({
      id: ticketId,
    });
    expect(claimQuery.is).toHaveBeenCalledWith("automation_locked_at", null);
  });

  it("renews the active lease before continuing work", async () => {
    const renewQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: ticket(), error: null }),
    };
    getSupabaseMock.mockReturnValue({
      from: vi.fn().mockReturnValue(renewQuery),
    } as never);

    await expect(
      renewSupportAutomationLock(ticketId, lockToken)
    ).resolves.toMatchObject({ id: ticketId });
    expect(renewQuery.update).toHaveBeenCalledWith({
      automation_locked_at: "2026-08-02T01:00:00.000Z",
      updated_at: "2026-08-02T01:00:00.000Z",
    });
  });
});

function attachmentClient(options: {
  rpcData?: unknown;
  rpcError?: unknown;
  referenced?: boolean;
}) {
  const upload = vi.fn().mockResolvedValue({ data: { path: "uploaded" }, error: null });
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });
  const attachmentQuery = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn((_column: string, paths: string[]) =>
      Promise.resolve({
        data: options.referenced
          ? paths.map((storagePath) => ({ storage_path: storagePath }))
          : [],
        error: null,
      })
    ),
  };
  const client = {
    storage: {
      getBucket: vi.fn().mockResolvedValue({ data: { id: "yutakasa-support" }, error: null }),
      createBucket: vi.fn(),
      from: vi.fn().mockReturnValue({ upload, remove }),
    },
    rpc: vi.fn().mockResolvedValue({
      data: options.rpcData ?? null,
      error: options.rpcError ?? null,
    }),
    from: vi.fn().mockReturnValue(attachmentQuery),
  };
  return { client, upload, remove, attachmentQuery };
}

function supportImage() {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], "screen.jpg", {
    type: "image/jpeg",
  });
}

function newTicketInput() {
  return {
    userEmail: "codex-support-test@silversense.cc",
    category: "technical" as const,
    subject: "送信確認",
    body: "画像付き問い合わせの確認です。",
    clientRequestId: "74e6508f-c0ff-4689-ab68-dac8fe324ac9",
    files: [supportImage()],
  };
}

describe("support attachment delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("removes the retry's unique upload when the ticket already exists", async () => {
    const testClient = attachmentClient({
      rpcData: [
        {
          ticket_id: ticketId,
          message_id: ticketId,
          created: false,
        },
      ],
    });
    getSupabaseMock.mockReturnValue(testClient.client as never);

    await expect(createSupportTicket(newTicketInput())).resolves.toMatchObject({
      created: false,
    });

    const uploadedPath = testClient.upload.mock.calls[0][0] as string;
    expect(uploadedPath).toMatch(
      /74e6508f-c0ff-4689-ab68-dac8fe324ac9\/[0-9a-f-]{36}\/1-[0-9a-f]{20}\.jpg$/u
    );
    expect(testClient.remove).toHaveBeenCalledWith([uploadedPath]);
  });

  it("removes the retry's unique upload when a follow-up already exists", async () => {
    const testClient = attachmentClient({
      rpcData: [{ message_id: ticketId, created: false }],
    });
    getSupabaseMock.mockReturnValue(testClient.client as never);

    await expect(
      appendUserSupportMessage({
        userEmail: "codex-support-test@silversense.cc",
        ticketId,
        body: "追加画像です。",
        clientRequestId: "74e6508f-c0ff-4689-ab68-dac8fe324ac9",
        files: [supportImage()],
      })
    ).resolves.toMatchObject({ created: false });

    const uploadedPath = testClient.upload.mock.calls[0][0] as string;
    expect(testClient.client.rpc).toHaveBeenCalledWith(
      "append_support_user_message",
      expect.any(Object)
    );
    expect(testClient.remove).toHaveBeenCalledWith([uploadedPath]);
  });

  it("preserves an upload that a committed ticket already references", async () => {
    const databaseError = { message: "connection ended after commit" };
    const testClient = attachmentClient({
      rpcError: databaseError,
      referenced: true,
    });
    getSupabaseMock.mockReturnValue(testClient.client as never);

    await expect(createSupportTicket(newTicketInput())).rejects.toBe(databaseError);
    expect(testClient.attachmentQuery.in).toHaveBeenCalledOnce();
    expect(testClient.remove).not.toHaveBeenCalled();
  });

  it("removes a unique upload when the database transaction did not commit", async () => {
    const databaseError = { message: "transaction rejected" };
    const testClient = attachmentClient({ rpcError: databaseError });
    getSupabaseMock.mockReturnValue(testClient.client as never);

    await expect(createSupportTicket(newTicketInput())).rejects.toBe(databaseError);
    const uploadedPath = testClient.upload.mock.calls[0][0] as string;
    expect(testClient.remove).toHaveBeenCalledWith([uploadedPath]);
  });

  it("bounds the Resend notification request so it cannot hold the receipt open", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "email-id" }));
    vi.stubGlobal("fetch", fetchMock);
    getSupabaseMock.mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: [{ ticket_id: ticketId, message_id: ticketId, created: true }],
        error: null,
      }),
    } as never);

    await createSupportTicket({
      ...newTicketInput(),
      userEmail: "member@example.com",
      files: [],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
