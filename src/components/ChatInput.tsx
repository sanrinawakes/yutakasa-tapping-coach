"use client";

import { useState, useRef, useEffect } from "react";

interface ChatInputProps {
  onSendMessage: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  remainingMessages?: number | null;
  dailyLimit?: number;
}

// Web Speech API の型補完（TypeScriptでwindow拡張）
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>; resultIndex: number }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export default function ChatInput({
  onSendMessage,
  disabled = false,
  isStreaming = false,
  remainingMessages = null,
  dailyLimit = 15,
}: ChatInputProps) {
  const [message, setMessage] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalTranscriptRef = useRef<string>("");

  // ブラウザがWeb Speech APIに対応してるか初期チェック
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setVoiceSupported(!!SR);
  }, []);

  // textarea自動リサイズ
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
    }
  }, [message]);

  // 音声認識の開始/停止
  const toggleRecording = () => {
    if (typeof window === "undefined") return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("お使いのブラウザは音声入力に対応していません。Chrome / Safariでお試しください。");
      return;
    }

    if (isRecording) {
      // 停止
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    // 開始
    const recognition = new SR();
    recognition.lang = "ja-JP";
    recognition.interimResults = true;
    recognition.continuous = true;
    finalTranscriptRef.current = message; // 現在の入力内容をベースに継ぎ足す

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          finalTranscriptRef.current += transcript;
        } else {
          interim += transcript;
        }
      }
      // textareaに反映（確定済 + 認識途中）
      setMessage(finalTranscriptRef.current + interim);
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognition.onerror = (e) => {
      console.error("SpeechRecognition error:", e.error);
      setIsRecording(false);
      if (e.error === "not-allowed" || e.error === "permission-denied") {
        alert("マイクへのアクセスが許可されていません。ブラウザの設定からマイク利用を許可してください。");
      } else if (e.error === "no-speech") {
        // 無音で停止 = 普通のケース、エラー扱いしない
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recognition:", err);
      setIsRecording(false);
    }
  };

  // unmount時にrecognition停止
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || disabled) return;

    // 録音中なら停止
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
    }

    onSendMessage(message.trim());
    setMessage("");
    finalTranscriptRef.current = "";
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
          className="flex items-end gap-2 p-2 rounded-2xl transition-all duration-200"
          style={{
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          {/* 音声入力ボタン */}
          {voiceSupported && (
            <button
              type="button"
              onClick={toggleRecording}
              disabled={disabled}
              className="flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: isRecording
                  ? "linear-gradient(135deg, #dc2626, #ef4444)"
                  : "var(--bg-tertiary)",
                color: isRecording ? "#ffffff" : "var(--text-muted)",
                boxShadow: isRecording
                  ? "0 2px 12px rgba(220, 38, 38, 0.4)"
                  : "none",
                animation: isRecording ? "pulse 1.5s ease-in-out infinite" : "none",
              }}
              aria-label={isRecording ? "音声入力を停止" : "音声入力を開始"}
              title={isRecording ? "音声入力中（クリックで停止）" : "音声で入力"}
            >
              {isRecording ? (
                // 停止アイコン（四角）
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              ) : (
                // マイクアイコン
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                </svg>
              )}
            </button>
          )}

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              finalTranscriptRef.current = e.target.value; // 手入力時にbase更新
            }}
            onKeyDown={handleKeyDown}
            placeholder={isRecording ? "聞き取り中..." : "メッセージを入力... (Shift+Enter で改行)"}
            disabled={disabled}
            rows={1}
            className="flex-1 px-3 py-3 bg-transparent border-none resize-none text-base leading-relaxed placeholder:text-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-0 focus:shadow-none"
            style={{
              color: "var(--text-primary)",
              minHeight: "52px",
              maxHeight: "180px",
              boxShadow: "none",
            }}
          />

          <button
            type="submit"
            disabled={disabled || !message.trim()}
            className="flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
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
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            )}
          </button>
        </div>

        <div className="flex items-center justify-between mt-3 px-1">
          <p className="text-sm" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
            {isRecording ? "🎤 音声入力中..." : "AIコーチは講座内容に基づいて回答します"}
          </p>
          {remainingMessages !== null && (
            <p
              className="text-sm font-medium"
              style={{
                color:
                  remainingMessages <= 3
                    ? "#ef4444"
                    : remainingMessages <= 7
                    ? "var(--accent-gold)"
                    : "var(--text-muted)",
              }}
            >
              残り {remainingMessages}/{dailyLimit} 回
            </p>
          )}
        </div>
      </form>

      <style jsx>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.85; transform: scale(1.05); }
        }
      `}</style>
    </div>
  );
}
