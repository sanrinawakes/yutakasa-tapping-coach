import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import {
  createChatThread,
  getUserChatThreads,
  updateChatThreadTitle,
} from "@/lib/supabase";

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const threads = await getUserChatThreads(session.email);

    return NextResponse.json({ threads });
  } catch (error) {
    console.error("Get threads error:", error);
    return NextResponse.json(
      { error: "スレッド取得に失敗しました" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { title } = await request.json();

    const thread = await createChatThread(session.email, title);

    return NextResponse.json({ thread });
  } catch (error) {
    console.error("Create thread error:", error);
    return NextResponse.json(
      { error: "スレッド作成に失敗しました" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { threadId, title } = await request.json();

    if (!threadId || !title) {
      return NextResponse.json(
        { error: "Thread ID and title are required" },
        { status: 400 }
      );
    }

    const thread = await updateChatThreadTitle(threadId, title);

    return NextResponse.json({ thread });
  } catch (error) {
    console.error("Update thread error:", error);
    return NextResponse.json(
      { error: "スレッド更新に失敗しました" },
      { status: 500 }
    );
  }
}
