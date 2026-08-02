import { jwtVerify } from "jose";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

vi.mock("jose", () => ({ jwtVerify: vi.fn() }));

const jwtVerifyMock = vi.mocked(jwtVerify);

describe("proxy authentication", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    jwtVerifyMock.mockReset();
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  it("allows public pages without a session", async () => {
    const response = await proxy(new NextRequest("https://example.com/login"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("redirects a protected page when the session is missing", async () => {
    const response = await proxy(new NextRequest("https://example.com/chat"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.com/login");
  });

  it("protects the in-app support page with the same session", async () => {
    const response = await proxy(new NextRequest("https://example.com/support"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.com/login");
  });

  it("allows a protected page with a valid session", async () => {
    jwtVerifyMock.mockResolvedValue({} as Awaited<ReturnType<typeof jwtVerify>>);
    const request = new NextRequest("https://example.com/chat", {
      headers: { cookie: "session=valid-token" },
    });

    const response = await proxy(request);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(jwtVerifyMock).toHaveBeenCalledOnce();
  });

  it("redirects a protected page with an invalid session", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("invalid token"));
    const request = new NextRequest("https://example.com/chat", {
      headers: { cookie: "session=invalid-token" },
    });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.com/login");
  });
});
