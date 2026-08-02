import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { countUnreadSupportReplies } from "@/lib/server/support-service";
import { supportApiError } from "@/lib/server/support-request";

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const count = await countUnreadSupportReplies(session.email);
    return NextResponse.json({ count });
  } catch (error) {
    return supportApiError(error, "未読件数を確認できませんでした。");
  }
}
