import { getSupabase } from "@/lib/supabase";
import {
  claimSupportTicket,
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
