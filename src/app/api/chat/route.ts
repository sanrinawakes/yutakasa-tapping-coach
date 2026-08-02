import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import {
  getChatMessages,
  addChatMessage,
  getChatThread,
  getDailyUserMessageCount,
  getSubscriberByEmail,
  titleChatThreadFromFirstMessage,
} from "@/lib/supabase";
import { evaluateAccess, accessReasonToMessage } from "@/lib/access-control";
import { streamChatCompletion, ChatMessage as GeminiMessage } from "@/lib/gemini";
import { DAILY_MESSAGE_LIMIT } from "@/lib/constants";
import {
  createChatTitle,
  sanitizeAssistantContent,
} from "@/lib/chat-thread";

const MAX_MESSAGE_LENGTH = 20_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PARTIAL_RESPONSE_NOTICE =
  "\n\n※通信が途中で中断されたため、ここまでの回答を履歴へ保存しました。続きが必要な場合は、そのままお知らせください。";

async function saveMessageWithRetry(
  threadId: string,
  role: "user" | "assistant",
  content: string,
  messageId: string
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await addChatMessage(threadId, role, content, messageId);
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
  throw lastError;
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
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

    const body = await request.json().catch(() => null);
    const threadId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { threadId?: unknown }).threadId
        : null;
    const rawMessage =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { message?: unknown }).message
        : null;
    const clientMessageId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { clientMessageId?: unknown }).clientMessageId
        : null;

    if (
      typeof threadId !== "string" ||
      typeof rawMessage !== "string" ||
      !rawMessage.trim()
    ) {
      return NextResponse.json(
        { error: "Thread ID and message are required" },
        { status: 400 }
      );
    }

    const message = rawMessage.trim();
    if (
      clientMessageId !== null &&
      (typeof clientMessageId !== "string" || !UUID_PATTERN.test(clientMessageId))
    ) {
      return NextResponse.json(
        { error: "Invalid client message ID" },
        { status: 400 }
      );
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: "メッセージが長すぎます。20,000文字以内で送信してください。" },
        { status: 413 }
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
    await saveMessageWithRetry(
      threadId,
      "user",
      message,
      clientMessageId || crypto.randomUUID()
    );

    try {
      await titleChatThreadFromFirstMessage(
        threadId,
        session.email,
        createChatTitle(message)
      );
    } catch (error) {
      console.error("Failed to title chat thread:", { requestId, error });
    }

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
    const assistantMessageId = crypto.randomUUID();
    let responseSaved = false;

    const saveAssistantResponse = async (content: string) => {
      if (responseSaved) return;
      const sanitized = sanitizeAssistantContent(content);
      if (!sanitized) return;
      await saveMessageWithRetry(
        threadId,
        "assistant",
        sanitized,
        assistantMessageId
      );
      responseSaved = true;
    };

    const customStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              await saveAssistantResponse(fullResponse);
              controller.close();
              break;
            }

            if (value) {
              fullResponse += value;
              controller.enqueue(textEncoder.encode(value));
            }
          }
        } catch (error) {
          console.error("Streaming error:", { requestId, error });
          const partialResponse = sanitizeAssistantContent(fullResponse);
          if (partialResponse && !responseSaved) {
            const recoveredResponse = `${partialResponse}${PARTIAL_RESPONSE_NOTICE}`;
            try {
              await saveAssistantResponse(recoveredResponse);
              controller.enqueue(textEncoder.encode(PARTIAL_RESPONSE_NOTICE));
              controller.close();
              return;
            } catch (saveError) {
              console.error("Failed to save interrupted response:", {
                requestId,
                saveError,
              });
            }
          }
          controller.error(error);
        }
      },
    });

    return new NextResponse(customStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    console.error("Chat error:", { requestId, error });
    return NextResponse.json(
      { error: "チャット処理に失敗しました" },
      { status: 500 }
    );
  }
}
