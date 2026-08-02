"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, HelpCircle, LoaderCircle, Menu, Pencil, X } from "lucide-react";
import { useTheme } from "./ThemeProvider";

interface ChatThread {
  id: string;
  user_email: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatSidebarProps {
  threads: ChatThread[];
  currentThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => Promise<void> | void;
  onLogout: () => void;
  currentUserEmail: string | null;
  isCreatingThread?: boolean;
  isLoadingThreads?: boolean;
  isOpen: boolean;
  onToggle: () => void;
}

export default function ChatSidebar({
  threads,
  currentThreadId,
  onSelectThread,
  onCreateThread,
  onDeleteThread,
  onRenameThread,
  onLogout,
  currentUserEmail,
  isCreatingThread = false,
  isLoadingThreads = false,
  isOpen,
  onToggle,
}: ChatSidebarProps) {
  const { theme, toggleTheme } = useTheme();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [supportUnreadCount, setSupportUnreadCount] = useState(0);

  useEffect(() => {
    let active = true;
    fetch("/api/support/unread-count", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { count?: unknown };
      })
      .then((data) => {
        if (active && typeof data?.count === "number") {
          setSupportUnreadCount(Math.max(0, data.count));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const handleDelete = async (e: React.MouseEvent, threadId: string) => {
    e.stopPropagation();
    setDeletingId(threadId);

    try {
      await onDeleteThread(threadId);
    } finally {
      setDeletingId(null);
    }
  };

  const beginRename = (e: React.MouseEvent, thread: ChatThread) => {
    e.stopPropagation();
    setEditingId(thread.id);
    setEditingTitle(thread.title);
  };

  const cancelRename = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingId(null);
    setEditingTitle("");
  };

  const saveRename = async (e?: React.MouseEvent | React.FormEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    const title = editingTitle.trim();
    if (!editingId || !title || renamingId) return;

    setRenamingId(editingId);
    try {
      await onRenameThread(editingId, title);
      setEditingId(null);
      setEditingTitle("");
    } finally {
      setRenamingId(null);
    }
  };

  return (
    <>
      {/* Mobile toggle */}
      {!isOpen && (
        <button
          onClick={onToggle}
          className="md:hidden fixed top-4 left-4 z-30 p-3 rounded-xl transition-all duration-200"
          style={{
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border-secondary)",
            color: "var(--text-primary)",
            boxShadow: "var(--shadow-md)",
          }}
          aria-label="メニューを開く"
        >
          <Menu size={24} />
        </button>
      )}

      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 md:hidden z-20 backdrop-blur-sm"
          onClick={onToggle}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed md:relative w-72 h-full z-20 transform transition-transform duration-300 ease-out md:transform-none flex flex-col ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{
          backgroundColor: "var(--bg-sidebar)",
          borderRight: "1px solid var(--border-secondary)",
        }}
      >
        {/* Header */}
        <div className="relative p-5 pb-4" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          {isOpen && (
            <button
              type="button"
              onClick={onToggle}
              className="md:hidden absolute right-3 top-3 p-2 rounded-lg"
              style={{ color: "var(--text-muted)" }}
              aria-label="メニューを閉じる"
            >
              <X size={22} />
            </button>
          )}
          {/* Brand */}
          <div className="flex items-center gap-3 mb-5 pr-10 md:pr-0">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: "var(--bg-tertiary)" }}
            >
              <span className="text-2xl">🌿</span>
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold leading-tight truncate" style={{ color: "var(--text-primary)" }}>
                豊かさタッピング
              </h1>
              <p className="text-sm text-gold-gradient font-medium">AI Coach</p>
            </div>
          </div>

          {/* New chat button */}
          <button
            onClick={onCreateThread}
            disabled={isCreatingThread}
            className="w-full flex items-center justify-center gap-2.5 py-5 px-5 rounded-xl text-lg font-bold transition-all duration-200 text-white"
            style={{
              background: "linear-gradient(135deg, #166534, #15803d)",
              boxShadow: "0 2px 8px rgba(22, 101, 52, 0.2)",
            }}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            新しいチャット
          </button>
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex items-center justify-between px-2 pb-2">
            <h2 className="text-sm font-bold" style={{ color: "var(--text-secondary)" }}>
              会話履歴
            </h2>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {isLoadingThreads ? "読込中" : `${threads.length}件`}
            </span>
          </div>
          <div className="space-y-1.5">
          {isLoadingThreads ? (
            <div
              className="flex flex-col items-center justify-center gap-3 py-16 px-4"
              role="status"
              aria-live="polite"
            >
              <LoaderCircle
                className="h-7 w-7 animate-spin"
                style={{ color: "var(--text-muted)" }}
                aria-hidden="true"
              />
              <p className="text-sm text-center" style={{ color: "var(--text-muted)" }}>
                会話履歴を読み込んでいます
              </p>
            </div>
          ) : threads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-4">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: "var(--bg-tertiary)" }}>
                <svg className="w-8 h-8" style={{ color: "var(--text-muted)" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <p className="text-sm text-center" style={{ color: "var(--text-muted)" }}>
                チャットを始めましょう
              </p>
            </div>
          ) : (
            threads.map((thread) => {
              const isActive = currentThreadId === thread.id;
              const isEditing = editingId === thread.id;
              return (
                <div
                  key={thread.id}
                  onClick={() => {
                    onSelectThread(thread.id);
                    if (window.innerWidth < 768) onToggle();
                  }}
                  className="group relative flex items-center px-4 py-4 rounded-xl cursor-pointer transition-all duration-150"
                  style={{
                    backgroundColor: isActive ? "var(--bg-active)" : "transparent",
                    color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  {/* Active indicator */}
                  {isActive && (
                    <div
                      className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full"
                      style={{ backgroundColor: "var(--accent-green)" }}
                    />
                  )}

                  <div className="flex-1 min-w-0 pr-16">
                    {isEditing ? (
                      <form onSubmit={saveRename} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
                        <input
                          autoFocus
                          aria-label="会話の題名"
                          value={editingTitle}
                          maxLength={60}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          className="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                          style={{
                            backgroundColor: "var(--bg-input)",
                            borderColor: "var(--border-primary)",
                            color: "var(--text-primary)",
                          }}
                        />
                        <button
                          type="submit"
                          aria-label="題名を保存"
                          disabled={!editingTitle.trim() || renamingId === thread.id}
                          className="p-1 rounded disabled:opacity-40"
                          style={{ color: "var(--accent-green)" }}
                        >
                          <Check size={17} />
                        </button>
                        <button
                          type="button"
                          aria-label="題名の変更を中止"
                          onClick={cancelRename}
                          className="p-1 rounded"
                          style={{ color: "var(--text-muted)" }}
                        >
                          <X size={17} />
                        </button>
                      </form>
                    ) : (
                      <p className="text-base font-medium truncate" style={{ lineHeight: 1.5 }}>{thread.title}</p>
                    )}
                    <p className="text-sm mt-1" style={{ color: "var(--text-muted)", lineHeight: 1.6, paddingBottom: 3 }}>
                      {new Date(thread.updated_at).toLocaleDateString("ja-JP", {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>

                  {!isEditing && (
                  <button
                    onClick={(e) => beginRename(e, thread)}
                    className="absolute right-10 top-1/2 -translate-y-1/2 p-2 rounded-lg opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-all duration-150"
                    style={{ color: "var(--text-muted)" }}
                    aria-label="題名を変更"
                    title="題名を変更"
                  >
                    <Pencil size={17} />
                  </button>
                  )}

                  {/* Delete button */}
                  {!isEditing && (
                  <button
                    onClick={(e) => handleDelete(e, thread.id)}
                    disabled={deletingId === thread.id}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-lg opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-all duration-150"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = "rgba(239, 68, 68, 0.1)";
                      e.currentTarget.style.color = "#ef4444";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                    aria-label="会話を削除"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                  )}
                </div>
              );
            })
          )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 space-y-1" style={{ borderTop: "1px solid var(--border-subtle)" }}>
          {currentUserEmail && (
            <p className="px-4 pb-2 text-xs truncate" style={{ color: "var(--text-muted)" }} title={currentUserEmail}>
              <span>ログイン中: </span>
              <span>{currentUserEmail}</span>
            </p>
          )}
          <Link
            href="/support"
            className="relative w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-base transition-all duration-150"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => {
              if (window.innerWidth < 768) onToggle();
            }}
          >
            <HelpCircle size={20} aria-hidden="true" />
            <span>お問い合わせ</span>
            {supportUnreadCount > 0 && (
              <span
                className="ml-auto min-w-6 h-6 px-1.5 rounded-full flex items-center justify-center text-xs font-bold text-white"
                style={{ backgroundColor: "#dc2626" }}
                aria-label={`未読の返信${supportUnreadCount}件`}
              >
                {supportUnreadCount > 99 ? "99+" : supportUnreadCount}
              </span>
            )}
          </Link>
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-base transition-all duration-150"
            style={{ color: "var(--text-secondary)" }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            {theme === "dark" ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
            <span>{theme === "dark" ? "ライトモード" : "ダークモード"}</span>
          </button>

          {/* Logout */}
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-base transition-all duration-150"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>ログアウト</span>
          </button>
        </div>
      </div>
    </>
  );
}
