import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { getChatMessages, addChatMessage, getChatThread, getDailyUserMessageCount, getSubscriberByEmail } from "@/lib/supabase";
import { evaluateAccess, accessReasonToMessage } from "@/lib/access-control";
import { streamChatCompletion, ChatMessage as GeminiMessage } from "@/lib/gemini";
import { DAILY_MESSAGE_LIMIT } from "@/lib/constants";

export async function POST(request: NextRequest) {
  try {
    // Verify session
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 認可ゲート（365日ライセンス＆月額サブスク）。セッション残存中に期限切れになるケース対策。
    const subscriber = await getSubscriberByEmail(session.email);
    const access = evaluateAccess(subscriber);
    if (!access.allowed) {
      return NextResponse.json(
        {
          error: accessReasonToMessage(access.reason),
          reason: access.reason,
          code: "ACCESS_DENIED",
        },
        { status: 403 }
      );
    }

    const { threadId, message } = await request.json();

    if (!threadId || !message) {
      return NextResponse.json(
        { error: "Thread ID and message are required" },
        { status: 400 }
      );
    }

    // Verify thread belongs to user
    const thread = await getChatThread(threadId);
    if (!thread || thread.user_email !== session.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check daily message limit
    const dailyCount = await getDailyUserMessageCount(session.email);
    if (dailyCount >= DAILY_MESSAGE_LIMIT) {
      return NextResponse.json(
        { error: `本日の利用回数（${DAILY_MESSAGE_LIMIT}回）に達しました。明日またご利用ください。`, code: "DAILY_LIMIT_REACHED" },
        { status: 429 }
      );
    }

    // Add user message to database
    await addChatMessage(threadId, "user", message);

    // Get conversation history
    const messages = await getChatMessages(threadId);

    // Prepare messages for Gemini (including new user message)
    const geminiMessages: GeminiMessage[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Get streaming response from Gemini
    const stream = await streamChatCompletion(geminiMessages);

    // Create a custom response that will save the assistant message
    const reader = stream.getReader();
    const textEncoder = new TextEncoder();

    let fullResponse = "";

    const customStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              // Save the full assistant response to database
              if (fullResponse) {
                await addChatMessage(threadId, "assistant", fullResponse);
              }
              controller.close();
              break;
            }

            if (value) {
              fullResponse += value;
              controller.enqueue(textEncoder.encode(value));
            }
          }
        } catch (error) {
          console.error("Streaming error:", error);
          controller.error(error);
        }
      },
    });

    return new NextResponse(customStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Chat error:", error);
    return NextResponse.json(
      { error: "チャット処理に失敗しました" },
      { status: 500 }
    );
  }
}
