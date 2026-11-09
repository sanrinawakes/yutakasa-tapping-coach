import { NextRequest } from "next/server";
import { createSession, setSessionCookie } from "@/lib/auth";
import { getSubscriberByEmail, verifyOTPCode } from "@/lib/supabase";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  createSession: vi.fn(),
  setSessionCookie: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  getSubscriberByEmail: vi.fn(),
  verifyOTPCode: vi.fn(),
}));

it("does not establish a session when the member loses access after receiving a valid code", async () => {
  const email = "member@example.com";
  vi.mocked(verifyOTPCode).mockResolvedValue({
    id: "otp",
    email,
    code: "123456",
    expires_at: "2099-01-01T00:10:00.000Z",
    used: false,
    created_at: "2099-01-01T00:00:00.000Z",
  });
  vi.mocked(getSubscriberByEmail).mockResolvedValue({
    id: "member",
    email,
    status: "active",
    subscription_status: "none",
    first_payment_date: "2020-01-01T00:00:00.000Z",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
  });

  const response = await POST(new NextRequest("http://localhost/api/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ email, code: "123456" }),
  }));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ reason: "license_expired_no_subscription" });
  expect(createSession).not.toHaveBeenCalled();
  expect(setSessionCookie).not.toHaveBeenCalled();
});
