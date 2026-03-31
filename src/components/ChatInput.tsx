"use client";

import { useState, useRef, useEffect } from "react";

interface ChatInputProps {
  onSendMessage: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
}

export default function ChatInput({
  onSendMessage,
  disabled = false,
  isStreaming = false,
}: ChatInputProps) {
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
    }
  }, [message]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!message.trim() || disabled) return;

    onSendMessage(message.trim());
    setMessage("");

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div
      className="px-4 md:px-8 py-4 md:py-5"
      style={{
        backgroundColor: "var(--bg-secondary)",
        borderTop: "1px solid var(--border-subtle)",
      }}
    >
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
        <div
          className="flex items-end gap-3 p-2 rounded-2xl transition-all duration-200"
          style={{
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="メッセージを入力... (Shift+Enter で改行)"
            disabled={disabled}
            rows={1}
            className="flex-1 px-3 py-2 bg-transparent border-none resize-none text-sm leading-relaxed placeholder:text-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-0 focus:shadow-none"
            style={{
              color: "var(--text-primary)",
              minHeight: "40px",
              maxHeight: "160px",
              boxShadow: "none",
            }}
          />

          <button
            type="submit"
            disabled={disabled || !message.trim()}
            className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background:
                !disabled && message.trim()
                  ? "linear-gradient(135deg, #166534, #15803d)"
                  : "var(--bg-tertiary)",
              color: !disabled && message.trim() ? "#ffffff" : "var(--text-muted)",
              boxShadow:
                !disabled && message.trim()
                  ? "0 2px 8px rgba(22, 101, 52, 0.2)"
                  : "none",
            }}
            aria-label="送信"
          >
            {isStreaming ? (
              <svg className="w-4.5 h-4.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            ) : (
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
                />
              </svg>
            )}
          </button>
        </div>

        <p className="text-center text-xs mt-2.5" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
          AIコーチは講座内容に基づいて回答します
        </p>
      </form>
    </div>
  );
}
