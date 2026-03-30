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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load threads on mount
  useEffect(() => {
    loadThreads();
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
        // Auto-select first thread if available
        if (data.threads?.length > 0 && !currentThreadId) {
          setCurrentThreadId(data.threads[0].id);
        } else if (!currentThreadId) {
          // Create new thread if none exist
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
      // Add user message to UI
      const userMessage: ChatMessage = {
        id: Date.now().toString(),
        thread_id: currentThreadId,
        role: "user",
        content: message,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Get streaming response
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: currentThreadId,
          message,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      // Process stream
      let assistantMessage = "";
      const assistantId = Date.now().toString();

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

      // Reload threads to update UI
      loadThreads();
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

  return (
    <div className="flex w-full h-full">
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

      <div className="flex-1 flex flex-col overflow-hidden">
        <ChatMessages messages={messages} messagesEndRef={messagesEndRef} />
        <ChatInput
          onSendMessage={handleSendMessage}
          disabled={loading}
          isStreaming={streaming}
        />
      </div>
    </div>
  );
}
