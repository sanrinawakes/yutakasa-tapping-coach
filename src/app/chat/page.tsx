"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import ChatSidebar from "@/components/ChatSidebar";
import ChatMessages from "@/components/ChatMessages";
import ChatInput from "@/components/ChatInput";

interface ChatThread {
  id: string;
  user_email: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

async function responseErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    return typeof data?.error === "string" ? data.error : fallback;
  } catch {
    return fallback;
  }
}

export default function ChatPage() {
  const router = useRouter();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [creatingThread, setCreatingThread] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [remainingMessages, setRemainingMessages] = useState<number | null>(null);
  const [dailyLimit, setDailyLimit] = useState(15);
  const [showWelcome, setShowWelcome] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initializationStartedRef = useRef(false);
  const createThreadPromiseRef = useRef<Promise<string | null> | null>(null);
  const messageLoadVersionRef = useRef(0);
  const skipNextMessageLoadRef = useRef<string | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      const response = await fetch("/api/chat/usage");
      if (response.ok) {
        const data = await response.json();
        setRemainingMessages(data.remaining);
        setDailyLimit(data.limit);
      }
    } catch (error) {
      console.error("Failed to load usage:", error);
    }
  }, []);

  const loadThreads = useCallback(async () => {
    try {
      const response = await fetch("/api/threads");
      if (response.status === 401) {
        router.push("/login");
        return [];
      }
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "会話履歴を読み込めませんでした。")
        );
      }

      const data = await response.json();
      const loadedThreads = (data.threads || []) as ChatThread[];
      setThreads(loadedThreads);
      setCurrentUserEmail(typeof data.email === "string" ? data.email : null);
      setThreadError(null);
      setCurrentThreadId((current) => {
        if (current && loadedThreads.some((thread) => thread.id === current)) {
          return current;
        }
        return loadedThreads[0]?.id ?? null;
      });

      if (
        loadedThreads.length === 0 &&
        typeof window !== "undefined" &&
        !localStorage.getItem("yutakasa_welcome_seen")
      ) {
        setShowWelcome(true);
      }
      return loadedThreads;
    } catch (error) {
      console.error("Failed to load threads:", error);
      setThreadError(
        error instanceof Error
          ? error.message
          : "会話履歴を読み込めませんでした。画面を更新してください。"
      );
      return null;
    }
  }, [router]);

  const loadThreadMessages = useCallback(async (threadId: string) => {
    const loadVersion = ++messageLoadVersionRef.current;
    try {
      const response = await fetch(`/api/threads/${threadId}`);
      if (response.status === 401) {
        router.push("/login");
        return null;
      }
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "この会話を読み込めませんでした。")
        );
      }

      const data = await response.json();
      const loadedMessages = (data.messages || []) as ChatMessage[];
      if (loadVersion === messageLoadVersionRef.current) {
        setMessages(loadedMessages);
        setHistoryError(null);
      }
      return loadedMessages;
    } catch (error) {
      console.error("Failed to load messages:", error);
      if (loadVersion === messageLoadVersionRef.current) {
        setHistoryError(
          error instanceof Error
            ? error.message
            : "会話を読み込めませんでした。もう一度選び直してください。"
        );
      }
      return null;
    }
  }, [router]);

  // Load threads and usage once. Strict Mode runs effects twice in development.
  useEffect(() => {
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;

    const initialThreads = loadThreads().finally(() => {
      setThreadsLoading(false);
    });

    Promise.all([initialThreads, loadUsage()]).finally(() => {
      setInitializing(false);
    });
  }, [loadThreads, loadUsage]);

  // Load messages when thread changes.
  useEffect(() => {
    if (!currentThreadId) {
      messageLoadVersionRef.current += 1;
      setMessages([]);
      return;
    }

    if (skipNextMessageLoadRef.current === currentThreadId) {
      skipNextMessageLoadRef.current = null;
      return;
    }

    void loadThreadMessages(currentThreadId);
  }, [currentThreadId, loadThreadMessages]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const createNewThread = async (): Promise<string | null> => {
    if (createThreadPromiseRef.current) {
      return createThreadPromiseRef.current;
    }

    setCreatingThread(true);
    setThreadError(null);
    const creation = (async () => {
      try {
        const response = await fetch("/api/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "新しいチャット" }),
        });

        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(response, "新しい会話を作成できませんでした。")
          );
        }

        const data = await response.json();
        const thread = data.thread as ChatThread;
        setThreads((previous) =>
          previous.some((item) => item.id === thread.id)
            ? previous
            : [thread, ...previous]
        );
        skipNextMessageLoadRef.current = thread.id;
        setCurrentThreadId(data.thread.id);
        setMessages([]);
        return thread.id;
      } catch (error) {
        console.error("Failed to create thread:", error);
        setThreadError(
          error instanceof Error
            ? error.message
            : "新しい会話を作成できませんでした。"
        );
        return null;
      } finally {
        setCreatingThread(false);
        createThreadPromiseRef.current = null;
      }
    })();

    createThreadPromiseRef.current = creation;
    return creation;
  };

  const handleSendMessage = async (message: string) => {
    setSendError(null);
    const threadId = currentThreadId ?? (await createNewThread());
    if (!threadId) {
      return false;
    }

    setLoading(true);
    setStreaming(true);
    const clientMessageId = crypto.randomUUID();

    try {
      const userMessage: ChatMessage = {
        id: clientMessageId,
        thread_id: threadId,
        role: "user",
        content: message,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          message,
          clientMessageId,
        }),
      });

      if (response.status === 429) {
        const errorData = await response.json();
        setMessages((previous) =>
          previous.filter((item) => item.id !== clientMessageId)
        );
        const limitMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          thread_id: threadId,
          role: "assistant",
          content: errorData.error || "本日の利用回数に達しました。明日またご利用ください。",
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, limitMessage]);
        void loadUsage();
        return true;
      }

      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "メッセージを送信できませんでした。")
        );
      }

      let assistantMessage = "";
      const assistantId = crypto.randomUUID();

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });
        assistantMessage += text;

        setMessages((prev) => {
          const existing = prev.find((m) => m.id === assistantId);
          if (existing) {
            return prev.map((m) =>
              m.id === assistantId ? { ...m, content: assistantMessage } : m
            );
          } else {
            return [
              ...prev,
              {
                id: assistantId,
                thread_id: threadId,
                role: "assistant" as const,
                content: assistantMessage,
                created_at: new Date().toISOString(),
              },
            ];
          }
        });
      }

      assistantMessage += decoder.decode();
      if (!assistantMessage.trim()) {
        throw new Error("AIから回答を受信できませんでした。もう一度お試しください。");
      }

      await loadThreadMessages(threadId);
      await Promise.all([loadThreads(), loadUsage()]);
      return true;
    } catch (error) {
      console.error("Failed to send message:", error);
      setSendError(
        error instanceof Error
          ? error.message
          : "メッセージを送信できませんでした。"
      );
      const persistedMessages = await loadThreadMessages(threadId);
      const userMessageWasSaved =
        persistedMessages?.some((item) => item.id === clientMessageId) ?? false;
      if (!userMessageWasSaved) {
        setMessages((previous) =>
          previous.filter((item) => item.id !== clientMessageId)
        );
      }
      return userMessageWasSaved;
    } finally {
      setLoading(false);
      setStreaming(false);
    }
  };

  const handleRenameThread = async (threadId: string, title: string) => {
    const response = await fetch("/api/threads", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, title }),
    });

    if (!response.ok) {
      const message = await responseErrorMessage(
        response,
        "会話の題名を変更できませんでした。"
      );
      setThreadError(message);
      throw new Error(message);
    }

    const data = await response.json();
    const updatedThread = data.thread as ChatThread;
    setThreads((previous) =>
      previous.map((thread) =>
        thread.id === updatedThread.id ? updatedThread : thread
      )
    );
    setThreadError(null);
  };

  const handleDeleteThread = async (threadId: string) => {
    try {
      const response = await fetch(`/api/threads/${threadId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        if (currentThreadId === threadId) {
          setCurrentThreadId(null);
          setMessages([]);
        }
      }
    } catch (error) {
      console.error("Failed to delete thread:", error);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const dismissWelcome = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem("yutakasa_welcome_seen", "1");
    }
    setShowWelcome(false);
  };

  return (
    <div className="flex w-full h-screen overflow-hidden" style={{ backgroundColor: "var(--bg-primary)" }}>
      <ChatSidebar
        threads={threads}
        currentThreadId={currentThreadId}
        onSelectThread={setCurrentThreadId}
        onCreateThread={createNewThread}
        onDeleteThread={handleDeleteThread}
        onRenameThread={handleRenameThread}
        onLogout={handleLogout}
        currentUserEmail={currentUserEmail}
        isCreatingThread={creatingThread}
        isLoadingThreads={threadsLoading}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {(threadError || historyError || sendError) && (
          <div
            role="alert"
            className="flex items-start justify-between gap-4 px-5 py-3 text-sm"
            style={{
              backgroundColor: "rgba(220, 38, 38, 0.08)",
              borderBottom: "1px solid rgba(220, 38, 38, 0.2)",
              color: "var(--text-primary)",
            }}
          >
            <p>{sendError || historyError || threadError}</p>
            <button
              type="button"
              onClick={() => {
                setThreadError(null);
                setHistoryError(null);
                setSendError(null);
              }}
              className="flex-shrink-0 font-bold"
              aria-label="エラー表示を閉じる"
            >
              閉じる
            </button>
          </div>
        )}
        <ChatMessages messages={messages} messagesEndRef={messagesEndRef} />
        <ChatInput
          onSendMessage={handleSendMessage}
          disabled={loading || initializing || creatingThread}
          isStreaming={streaming}
          remainingMessages={remainingMessages}
          dailyLimit={dailyLimit}
        />
      </div>

      {/* 初回ユーザー welcome modal */}
      {showWelcome && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.6)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="welcome-title"
        >
          <div
            className="w-full max-w-lg rounded-2xl p-8 md:p-10 fade-in"
            style={{
              backgroundColor: "var(--bg-card)",
              border: "1px solid var(--border-secondary)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <div className="text-center mb-6">
              <div
                className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-4"
                style={{ backgroundColor: "var(--bg-tertiary)" }}
              >
                <span className="text-3xl">🌿</span>
              </div>
              <h2
                id="welcome-title"
                className="font-display text-2xl font-semibold tracking-wide mb-2"
                style={{ color: "var(--text-primary)" }}
              >
                ようこそ豊かさタッピング AIコーチへ
              </h2>
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                ご利用前に、簡単に使い方をご案内します
              </p>
            </div>

            <div className="space-y-4 mb-8">
              <div
                className="p-4 rounded-xl"
                style={{
                  backgroundColor: "var(--accent-gold-soft)",
                  border: "1px solid rgba(200, 164, 21, 0.15)",
                }}
              >
                <p className="text-sm font-bold mb-1" style={{ color: "var(--text-primary)" }}>
                  💬 AIコーチに相談できます
                </p>
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  豊かさタッピングの内容について、いつでも気軽に質問してください。
                  41のコース動画の知識をもとに、AIがあなたの実践をサポートします。
                </p>
              </div>

              <div
                className="p-4 rounded-xl"
                style={{
                  backgroundColor: "rgba(34, 197, 94, 0.06)",
                  border: "1px solid rgba(34, 197, 94, 0.18)",
                }}
              >
                <p className="text-sm font-bold mb-1" style={{ color: "#16a34a" }}>
                  📅 1日{dailyLimit}メッセージまで
                </p>
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  毎日{dailyLimit}回まで質問できます。回数は毎日リセットされます。
                </p>
              </div>

              <div
                className="p-4 rounded-xl"
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-secondary)",
                }}
              >
                <p className="text-sm font-bold mb-1" style={{ color: "var(--text-primary)" }}>
                  ⏰ ご購入から365日ご利用いただけます
                </p>
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  期限を過ぎた後も、月額継続プランへのご加入で引き続きご利用可能です。
                </p>
              </div>
            </div>

            <button
              onClick={dismissWelcome}
              className="w-full py-4 rounded-xl font-bold text-base text-white transition-all duration-200"
              style={{
                background: "linear-gradient(135deg, #166534, #15803d)",
                boxShadow: "0 4px 16px rgba(22, 101, 52, 0.25)",
              }}
            >
              はじめる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
