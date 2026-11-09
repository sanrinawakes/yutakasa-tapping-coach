import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import {
  getChatMessages,
  getChatMessageById,
  addChatMessage,
  ChatMessageIdConflictError,
  getChatThread,
  getDailyUserMessageCount,
  getSubscriberByEmail,
  titleChatThreadFromFirstMessage,
  type ChatMessage,
} from "@/lib/supabase";
import { evaluateAccess, accessReasonToMessage } from "@/lib/access-control";
import {
  GEMINI_GENERATION_FAILED_CODE,
  generateChatCompletion,
  geminiGenerationErrorCode,
  type ChatGeneration,
} from "@/lib/gemini";
import { assistantMessageIdFor } from "@/lib/chat-turn-id";
import { DAILY_MESSAGE_LIMIT } from "@/lib/constants";
import {
  createChatTitle,
  sanitizeAssistantContent,
} from "@/lib/chat-thread";
import {
  AI_RESPONSE_NOT_GENERATED_CODE,
  AI_RESPONSE_NOT_GENERATED_MESSAGE,
} from "@/lib/chat-errors";

const MAX_MESSAGE_LENGTH = 20_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// The bounded Gemini and OpenAI budgets together can reach 95 seconds.
export const maxDuration = 120;

type TurnResult =
  | { content: string; generation?: ChatGeneration }
  | { failureCode: string };
const activeTurns = new Map<string, Promise<TurnResult>>();

function completedResponse(
  requestId: string,
  assistantId: string,
  result: Extract<TurnResult, { content: string }>
) {
  return new NextResponse(result.content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
      "X-Chat-Assistant-Id": assistantId,
      "X-Chat-Provider-Path": result.generation?.path ?? "replay",
      ...(result.generation ? { "X-Chat-Provider": result.generation.provider } : {}),
    },
  });
}

function aiResponseNotGeneratedResponse(
  requestId: string,
  providerCode: string
) {
  if (providerCode === "chat_assistant_save_failed") {
    console.error("Chat answer save unconfirmed:", { requestId });
    return NextResponse.json({
      error: "回答の保存結果を確認できませんでした。同じ内容で再試行してください。",
      code: "CHAT_ASSISTANT_SAVE_UNCONFIRMED",
      userMessageSaved: true,
      assistantResponseGenerated: true,
      assistantSaveConfirmed: false,
    }, { status: 503, headers: { "X-Request-Id": requestId } });
  }
  console.error("Chat AI response generation failed:", {
    requestId,
    code: providerCode,
  });
  return NextResponse.json(
    {
      error: AI_RESPONSE_NOT_GENERATED_MESSAGE,
      code: AI_RESPONSE_NOT_GENERATED_CODE,
      userMessageSaved: true,
      assistantResponseGenerated: false,
    },
    {
      status: 503,
      headers: { "X-Request-Id": requestId },
    }
  );
}

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
      if (error instanceof ChatMessageIdConflictError) throw error;
      // An insert can succeed even if its acknowledgement is lost. Read the
      // exact scoped row before trying the same ID again.
      const found = await getChatMessageById(threadId, role, messageId).catch(() => null);
      if (found) {
        if (role === "user" && found.content !== content) throw new ChatMessageIdConflictError();
        return { ...found, inserted: false };
      }
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
  throw lastError;
}

async function completeTurn(
  threadId: string,
  user: ChatMessage,
  assistantId: string,
  requestId: string
): Promise<TurnResult> {
  let generation: ChatGeneration;
  try {
    const messages = await getChatMessages(threadId, user.created_at);
    const turnIndex = messages.findIndex((row) => row.id === user.id && row.role === "user");
    if (turnIndex < 0) return { failureCode: "chat_turn_history_unavailable" };
    generation = await generateChatCompletion(messages.slice(0, turnIndex + 1).map(
      ({ role, content }) => ({ role, content })
    ));
  } catch (error) {
    return { failureCode: geminiGenerationErrorCode(error) };
  }

  const content = sanitizeAssistantContent(generation.content);
  if (!content) return { failureCode: GEMINI_GENERATION_FAILED_CODE };

  try {
    const saved = await saveMessageWithRetry(threadId, "assistant", content, assistantId);
    // Never stream draft text or serve a losing worker's candidate. The DB
    // first-writer wins; an existing row has no attributable provider receipt.
    if (!saved.inserted) return { content: saved.content };
    const fallback = generation.path === "openai_fallback" || generation.path === "openai_circuit";
    const condition = "reason" in generation && generation.reason
      ? {
          gemini_credits_depleted: "prepaid_credits_depleted",
          gemini_transient: "upstream_transport",
          gemini_timeout: "upstream_deadline",
        }[generation.reason]
      : undefined;
    // Success has its own event; the existing broad error searches must not
    // see ordinary Gemini answers or a successful takeover as failed turns.
    console.info(fallback ? "Chat fallback answer saved" : "Chat answer saved", {
      requestId,
      assistantId,
      path: generation.path === "gemini" ? "google_primary" : generation.path,
      ...(condition ? { condition } : {}),
    });
    return { content: saved.content, generation };
  } catch {
    return { failureCode: "chat_assistant_save_failed" };
  }
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
        ? (body as { clientMessageId?: unknown }).clientMessageId ?? null
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

    const userId = typeof clientMessageId === "string"
      ? clientMessageId.toLowerCase()
      : crypto.randomUUID();
    const assistantId = assistantMessageIdFor(threadId, userId);
    let user = await getChatMessageById(threadId, "user", userId);

    if (!user) {
      const dailyCount = await getDailyUserMessageCount(session.email);
      if (dailyCount >= DAILY_MESSAGE_LIMIT) {
        // A simultaneous retry may have consumed the final slot with this ID.
        user = await getChatMessageById(threadId, "user", userId);
        if (!user) {
          return NextResponse.json(
            { error: `本日の利用回数（${DAILY_MESSAGE_LIMIT}回）に達しました。明日またご利用ください。`, code: "DAILY_LIMIT_REACHED" },
            { status: 429 }
          );
        }
      }
      if (!user) {
        user = await saveMessageWithRetry(threadId, "user", message, userId);
        try {
          await titleChatThreadFromFirstMessage(threadId, session.email, createChatTitle(message));
        } catch {
          console.error("Failed to title chat thread:", { requestId });
        }
      }
    }
    if (user.content !== message) throw new ChatMessageIdConflictError();

    const saved = await getChatMessageById(threadId, "assistant", assistantId);
    if (saved) return completedResponse(requestId, assistantId, { content: saved.content });

    const active = activeTurns.get(assistantId);
    if (active) {
      const result = await active;
      return "failureCode" in result
        ? aiResponseNotGeneratedResponse(requestId, result.failureCode)
        : completedResponse(requestId, assistantId, { content: result.content });
    }

    const turn = completeTurn(threadId, user, assistantId, requestId);
    activeTurns.set(assistantId, turn);
    try {
      const result = await turn;
      return "failureCode" in result
        ? aiResponseNotGeneratedResponse(requestId, result.failureCode)
        : completedResponse(requestId, assistantId, result);
    } finally {
      activeTurns.delete(assistantId);
    }
  } catch (error) {
    if (error instanceof ChatMessageIdConflictError) {
      return NextResponse.json(
        { error: "送信済みのメッセージと一致しません。", code: error.code },
        { status: 409 }
      );
    }
    console.error("Chat error:", { requestId });
    return NextResponse.json(
      { error: "チャット処理に失敗しました" },
      { status: 500 }
    );
  }
}
