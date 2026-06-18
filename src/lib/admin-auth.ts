import { NextRequest, NextResponse } from "next/server";

export function getAdminAuthError(request: NextRequest): NextResponse | null {
  const adminSecret = process.env.JWT_SECRET;
  const bearerToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const headerToken = request.headers.get("x-admin-token")?.trim();
  const token = headerToken || bearerToken;

  if (!adminSecret || adminSecret.length < 32) {
    return NextResponse.json(
      { error: "Admin auth is not configured" },
      { status: 500 }
    );
  }

  if (!token || token !== adminSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
