import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import {
  createChatThread,
  getChatThread,
  getUserChatThreads,
  updateChatThreadTitle,
} from "@/lib/supabase";
import { DEFAULT_CHAT_TITLE, sanitizeChatTitle } from "@/lib/chat-thread";

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const threads = await getUserChatThreads(session.email);

    return NextResponse.json({ threads, email: session.email });
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

    const body = await request.json().catch(() => null);
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const title = sanitizeChatTitle(
      (body as { title?: unknown } | null)?.title ?? DEFAULT_CHAT_TITLE
    );

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

    const body = await request.json().catch(() => null);
    const threadId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { threadId?: unknown }).threadId
        : null;
    const title =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { title?: unknown }).title
        : null;

    if (
      typeof threadId !== "string" ||
      typeof title !== "string" ||
      !title.trim()
    ) {
      return NextResponse.json(
        { error: "Thread ID and title are required" },
        { status: 400 }
      );
    }

    const existingThread = await getChatThread(threadId);
    if (!existingThread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    if (existingThread.user_email !== session.email) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const thread = await updateChatThreadTitle(
      threadId,
      session.email,
      sanitizeChatTitle(title)
    );

    return NextResponse.json({ thread });
  } catch (error) {
    console.error("Update thread error:", error);
    return NextResponse.json(
      { error: "スレッド更新に失敗しました" },
      { status: 500 }
    );
  }
}
