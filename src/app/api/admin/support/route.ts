import { NextRequest, NextResponse } from "next/server";
import { getAdminAuthError } from "@/lib/admin-auth";
import { listAdminSupportTickets } from "@/lib/server/support-service";
import { supportApiError } from "@/lib/server/support-request";
import { isSupportStatus } from "@/lib/support";

export async function GET(request: NextRequest) {
  const authError = await getAdminAuthError();
  if (authError) return authError;

  try {
    const statusValue = request.nextUrl.searchParams.get("status") ?? "";
    if (statusValue && !isSupportStatus(statusValue)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const tickets = await listAdminSupportTickets({
      status: isSupportStatus(statusValue) ? statusValue : "",
      query: request.nextUrl.searchParams.get("query") ?? "",
    });
    return NextResponse.json({ tickets });
  } catch (error) {
    return supportApiError(error, "お問い合わせ一覧を読み込めませんでした。");
  }
}
