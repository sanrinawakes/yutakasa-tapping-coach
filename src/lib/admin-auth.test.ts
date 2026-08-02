import { getSessionFromCookies } from "@/lib/auth";
import { getAdminAuthError } from "./admin-auth";

vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));

const getSessionMock = vi.mocked(getSessionFromCookies);

describe("getAdminAuthError", () => {
  const originalAdminEmail = process.env.SUPPORT_ADMIN_EMAIL;
  const originalNotificationEmail = process.env.SUPPORT_NOTIFICATION_EMAIL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPPORT_ADMIN_EMAIL = "owner@example.com";
    delete process.env.SUPPORT_NOTIFICATION_EMAIL;
  });

  afterAll(() => {
    if (originalAdminEmail === undefined) delete process.env.SUPPORT_ADMIN_EMAIL;
    else process.env.SUPPORT_ADMIN_EMAIL = originalAdminEmail;
    if (originalNotificationEmail === undefined) {
      delete process.env.SUPPORT_NOTIFICATION_EMAIL;
    } else {
      process.env.SUPPORT_NOTIFICATION_EMAIL = originalNotificationEmail;
    }
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await getAdminAuthError();

    expect(response?.status).toBe(401);
  });

  it("rejects a different signed-in member", async () => {
    getSessionMock.mockResolvedValue({
      email: "member@example.com",
      iat: 1,
      exp: 2,
    });

    const response = await getAdminAuthError();

    expect(response?.status).toBe(403);
  });

  it("accepts the configured owner without exposing an admin token", async () => {
    getSessionMock.mockResolvedValue({
      email: "OWNER@example.com",
      iat: 1,
      exp: 2,
    });

    expect(await getAdminAuthError()).toBeNull();
  });

  it("fails closed when the owner email is invalid", async () => {
    process.env.SUPPORT_ADMIN_EMAIL = "not-an-email";
    getSessionMock.mockResolvedValue({
      email: "owner@example.com",
      iat: 1,
      exp: 2,
    });

    const response = await getAdminAuthError();

    expect(response?.status).toBe(500);
  });
});
