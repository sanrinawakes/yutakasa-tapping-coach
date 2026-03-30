"use client";

import { useState } from "react";

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
  onLogout: () => void;
  isOpen: boolean;
  onToggle: () => void;
}

export default function ChatSidebar({
  threads,
  currentThreadId,
  onSelectThread,
  onCreateThread,
  onDeleteThread,
  onLogout,
  isOpen,
  onToggle,
}: ChatSidebarProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, threadId: string) => {
    e.stopPropagation();
    setDeletingId(threadId);

    try {
      await onDeleteThread(threadId);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      {/* Toggle button for mobile */}
      <button
        onClick={onToggle}
        className="md:hidden fixed top-4 left-4 z-30 bg-primary-500 text-white p-2 rounded-lg"
        aria-label="Toggle sidebar"
      >
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
      </button>

      {/* Sidebar overlay for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 md:hidden z-20"
          onClick={onToggle}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed md:relative w-64 h-full bg-white border-r border-gray-200 z-20 transform transition-transform duration-200 md:transform-none flex flex-col ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <button
            onClick={onCreateThread}
            className="w-full bg-primary-500 hover:bg-primary-600 text-white font-semibold py-2 px-4 rounded-lg transition flex items-center justify-center gap-2"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            新しいチャット
          </button>
        </div>

        {/* Threads list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {threads.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-4">
              チャットスレッドがありません
            </p>
          ) : (
            threads.map((thread) => (
              <div
                key={thread.id}
                onClick={() => {
                  onSelectThread(thread.id);
                  onToggle();
                }}
                className={`p-3 rounded-lg cursor-pointer transition group relative ${
                  currentThreadId === thread.id
                    ? "bg-primary-100 text-primary-900"
                    : "bg-gray-100 hover:bg-gray-200 text-gray-700"
                }`}
              >
                <div className="pr-8 truncate">
                  <p className="text-sm font-medium truncate">{thread.title}</p>
                  <p className="text-xs opacity-70 truncate">
                    {new Date(thread.updated_at).toLocaleDateString("ja-JP")}
                  </p>
                </div>

                {currentThreadId === thread.id && (
                  <button
                    onClick={(e) => handleDelete(e, thread.id)}
                    disabled={deletingId === thread.id}
                    className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1 opacity-0 group-hover:opacity-100 transition"
                    aria-label="Delete thread"
                  >
                    <svg
                      className="w-4 h-4 text-red-500 hover:text-red-700"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 space-y-2">
          <button
            onClick={onLogout}
            className="w-full text-gray-700 hover:text-gray-900 font-medium py-2 px-4 rounded-lg hover:bg-gray-100 transition flex items-center justify-center gap-2"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
            ログアウト
          </button>
        </div>
      </div>
    </>
  );
}
