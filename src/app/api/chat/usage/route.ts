import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { getDailyUserMessageCount } from "@/lib/supabase";
import { DAILY_MESSAGE_LIMIT } from "@/lib/constants";

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const used = await getDailyUserMessageCount(session.email);
    const remaining = Math.max(0, DAILY_MESSAGE_LIMIT - used);

    return NextResponse.json({ used, remaining, limit: DAILY_MESSAGE_LIMIT });
  } catch (error) {
    console.error("Usage check error:", error);
    return NextResponse.json(
      { error: "利用状況の取得に失敗しました" },
      { status: 500 }
    );
  }
}
