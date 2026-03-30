import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { getChatThread, deleteChatThread, getChatMessages } from "@/lib/supabase";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const thread = await getChatThread(id);

    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    if (thread.user_email !== session.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const messages = await getChatMessages(id);

    return NextResponse.json({ thread, messages });
  } catch (error) {
    console.error("Get thread error:", error);
    return NextResponse.json(
      { error: "スレッド取得に失敗しました" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const thread = await getChatThread(id);

    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    if (thread.user_email !== session.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await deleteChatThread(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete thread error:", error);
    return NextResponse.json(
      { error: "スレッド削除に失敗しました" },
      { status: 500 }
    );
  }
}
