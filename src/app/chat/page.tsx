"use client";

import { useEffect, useState, useRef } from "react";
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

export default function ChatPage() {
  const router = useRouter();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [remainingMessages, setRemainingMessages] = useState<number | null>(null);
  const [dailyLimit, setDailyLimit] = useState(15);
  const [showWelcome, setShowWelcome] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadUsage = async () => {
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
  };

  // Load threads and usage on mount
  useEffect(() => {
    loadThreads();
    loadUsage();
  }, []);

  // Load messages when thread changes
  useEffect(() => {
    if (currentThreadId) {
      loadThreadMessages();
    }
  }, [currentThreadId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadThreads = async () => {
    try {
      const response = await fetch("/api/threads");
      if (response.ok) {
        const data = await response.json();
        setThreads(data.threads || []);
        if (data.threads?.length > 0 && !currentThreadId) {
          setCurrentThreadId(data.threads[0].id);
        } else if (!currentThreadId) {
          // 初回ログイン判定: threadsが0件 かつ welcome未表示
          if (typeof window !== "undefined" && !localStorage.getItem("yutakasa_welcome_seen")) {
            setShowWelcome(true);
          }
          createNewThread();
        }
      } else if (response.status === 401) {
        router.push("/login");
      }
    } catch (error) {
      console.error("Failed to load threads:", error);
    }
  };

  const loadThreadMessages = async () => {
    if (!currentThreadId) return;

    try {
      const response = await fetch(`/api/threads/${currentThreadId}`);
      if (response.ok) {
        const data = await response.json();
        setMessages(data.messages || []);
      }
    } catch (error) {
      console.error("Failed to load messages:", error);
    }
  };

  const createNewThread = async () => {
    try {
      const response = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新しいチャット" }),
      });

      if (response.ok) {
        const data = await response.json();
        setThreads((prev) => [data.thread, ...prev]);
        setCurrentThreadId(data.thread.id);
        setMessages([]);
      }
    } catch (error) {
      console.error("Failed to create thread:", error);
    }
  };

  const handleSendMessage = async (message: string) => {
    if (!currentThreadId) {
      await createNewThread();
      return;
    }

    setLoading(true);
    setStreaming(true);

    try {
      const userMessage: ChatMessage = {
        id: Date.now().toString(),
        thread_id: currentThreadId,
        role: "user",
        content: message,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: currentThreadId,
          message,
        }),
      });

      if (response.status === 429) {
        const errorData = await response.json();
        const limitMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          thread_id: currentThreadId,
          role: "assistant",
          content: errorData.error || "本日の利用回数に達しました。明日またご利用ください。",
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, limitMessage]);
        loadUsage();
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      let assistantMessage = "";
      const assistantId = (Date.now() + 1).toString();

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value);
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
                thread_id: currentThreadId,
                role: "assistant" as const,
                content: assistantMessage,
                created_at: new Date().toISOString(),
              },
            ];
          }
        });
      }

      loadThreads();
      loadUsage();
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setLoading(false);
      setStreaming(false);
    }
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
        onLogout={handleLogout}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <ChatMessages messages={messages} messagesEndRef={messagesEndRef} />
        <ChatInput
          onSendMessage={handleSendMessage}
          disabled={loading}
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
