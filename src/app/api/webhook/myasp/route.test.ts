import { NextRequest } from "next/server";
import { POST } from "./route";
import { recordFirstPaymentIfMissing, upsertSubscriber } from "@/lib/supabase";

vi.mock("@/lib/supabase", () => ({
  upsertSubscriber: vi.fn(),
  recordFirstPaymentIfMissing: vi.fn(),
}));

const upsertMock = vi.mocked(upsertSubscriber);
const recordFirstPaymentMock = vi.mocked(recordFirstPaymentIfMissing);
const secret = "myasp-webhook-secret";

function request(body: string, token = secret) {
  return new NextRequest(`http://localhost/api/webhook/myasp?token=${token}`, {
    method: "POST",
    body,
  });
}

describe("MyASP webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MYASP_WEBHOOK_SECRET = secret;
    upsertMock.mockResolvedValue({
      id: "subscriber-id",
      email: "member@example.com",
      name: "Member",
      status: "active",
      first_payment_date: null,
      subscription_status: "none",
      myasp_data: {},
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    recordFirstPaymentMock.mockResolvedValue({
      updated: true,
      first_payment_date: "2026-08-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    delete process.env.MYASP_WEBHOOK_SECRET;
  });

  it("activates the subscriber when receiptstate is an unresolved placeholder", async () => {
    const response = await POST(
      request(
        JSON.stringify({
          email: "member@example.com",
          name: "Member",
          receiptstate: "%receiptstate%",
          scenario_id: "FmLgBgI8",
        })
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      action: "added_active_unresolved",
      email: "member@example.com",
    });
    expect(upsertMock).toHaveBeenCalledWith("member@example.com", {
      name: "Member",
      status: "active",
      myasp_data: expect.objectContaining({
        scenario_id: "FmLgBgI8",
        receipt_state: "%receiptstate%",
        receipt_class: "added_unresolved_receipt",
        last_event: "paid",
      }),
    });
    expect(recordFirstPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("still activates a paid subscriber when receiptstate is explicit", async () => {
    const response = await POST(
      request(
        JSON.stringify({
          email: "member@example.com",
          name: "Member",
          receiptstate: "受領済み",
          scenario_id: "FmLgBgI8",
        })
      )
    );

    expect(response.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith("member@example.com", {
      name: "Member",
      status: "active",
      myasp_data: expect.objectContaining({
        scenario_id: "FmLgBgI8",
        receipt_state: "受領済み",
        receipt_class: "paid",
        last_event: "paid",
      }),
    });
    expect(recordFirstPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("skips subscribers whose email is an unresolved placeholder", async () => {
    const response = await POST(
      request(
        JSON.stringify({
          email: "%email%",
          name: "Member",
          receiptstate: "%receiptstate%",
          scenario_id: "FmLgBgI8",
        })
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      action: "skipped_invalid_email",
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(recordFirstPaymentMock).not.toHaveBeenCalled();
  });
});
