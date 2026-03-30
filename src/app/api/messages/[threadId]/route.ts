import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { getChatThread, getChatMessages } from "@/lib/supabase";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { threadId } = await params;

    // Verify thread ownership
    const thread = await getChatThread(threadId);

    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    if (thread.user_email !== session.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const messages = await getChatMessages(threadId);

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("Get messages error:", error);
    return NextResponse.json(
      { error: "メッセージ取得に失敗しました" },
      { status: 500 }
    );
  }
}
