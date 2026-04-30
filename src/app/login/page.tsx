"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "@/components/ThemeProvider";

type LoginStep = "email" | "otp";

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { theme, toggleTheme } = useTheme();
  const [step, setStep] = useState<LoginStep>("email");
  const [email, setEmail] = useState(() => searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isWelcome = searchParams.get("welcome") === "1";

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "メール送信に失敗しました");
        setErrorReason(data.reason ?? null);
        return;
      }

      setError("");
      setErrorReason(null);
      setStep("otp");
      setCode("");
    } catch (err) {
      setError("エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "コードが無効です");
        return;
      }

      router.push("/chat");
    } catch (err) {
      setError("エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6 bg-pattern"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="fixed top-5 right-5 p-3 rounded-full transition-all duration-200 hover:scale-110"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-secondary)",
          color: "var(--text-secondary)",
          boxShadow: "var(--shadow-sm)",
        }}
        aria-label="テーマ切替"
      >
        {theme === "dark" ? (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        ) : (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        )}
      </button>

      <div className="w-full max-w-lg fade-in">
        {/* Card */}
        <div
          className="rounded-2xl p-10 md:p-12"
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-secondary)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {/* Logo & Title */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full mb-5" style={{ backgroundColor: "var(--bg-tertiary)" }}>
              <span className="text-4xl">🌿</span>
            </div>
            <h1 className="font-display text-4xl font-semibold tracking-wide mb-2" style={{ color: "var(--text-primary)" }}>
              豊かさタッピング
            </h1>
            <p className="text-gold-gradient text-base font-medium tracking-widest uppercase">
              AI Coach
            </p>
          </div>

          {/* 決済直後 welcome バナー */}
          {isWelcome && step === "email" && (
            <div
              className="mb-6 p-5 rounded-xl text-base leading-relaxed"
              style={{
                backgroundColor: "rgba(34, 197, 94, 0.08)",
                border: "1px solid rgba(34, 197, 94, 0.25)",
                color: "var(--text-secondary)",
              }}
            >
              <p className="font-bold mb-2 text-lg" style={{ color: "#16a34a" }}>
                ✨ ご決済ありがとうございます
              </p>
              <p>
                ようこそ「豊かさタッピング AIコーチ」へ。
                ご決済時にご登録いただいたメールアドレスを下に入力してください。
                認証コードをお送りします。
              </p>
            </div>
          )}

          {step === "email" ? (
            <form onSubmit={handleSendOTP} className="space-y-6">
              <div>
                <label
                  className="block text-sm font-medium tracking-wider uppercase mb-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  メールアドレス
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  disabled={loading}
                  className="w-full px-5 py-5 rounded-xl text-lg transition-all duration-200 disabled:opacity-50"
                  style={{
                    backgroundColor: "var(--bg-input)",
                    border: "2px solid var(--border-primary)",
                    color: "var(--text-primary)",
                  }}
                  required
                />
              </div>

              {error && (
                <div className="p-4 rounded-xl text-base space-y-3" style={{ backgroundColor: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", color: "#ef4444" }}>
                  <div>{error}</div>
                  {errorReason === "license_expired_no_subscription" && (
                    <a
                      href="/subscribe"
                      className="inline-block w-full text-center py-3 rounded-lg font-bold text-base text-white transition-all duration-200"
                      style={{
                        background: "linear-gradient(135deg, #166534, #15803d)",
                      }}
                    >
                      月額継続プランへのご加入はこちら
                    </a>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !email}
                className="w-full py-5 rounded-xl font-bold text-lg text-white transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: loading ? "var(--accent-green)" : "linear-gradient(135deg, #166534, #15803d)",
                  boxShadow: !loading && email ? "0 4px 16px rgba(22, 101, 52, 0.25)" : "none",
                }}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    送信中...
                  </span>
                ) : (
                  "ログインコードを送信"
                )}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOTP} className="space-y-6">
              <div
                className="p-5 rounded-xl text-base leading-relaxed"
                style={{
                  backgroundColor: "var(--accent-gold-soft)",
                  border: "1px solid rgba(200, 164, 21, 0.15)",
                  color: "var(--text-secondary)",
                }}
              >
                <span className="font-bold" style={{ color: "var(--text-primary)" }}>{email}</span>
                <span> にコードを送信しました</span>
              </div>

              <div>
                <label
                  className="block text-sm font-medium tracking-wider uppercase mb-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  6桁の認証コード
                </label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))
                  }
                  placeholder="000000"
                  maxLength={6}
                  disabled={loading}
                  className="w-full px-5 py-5 rounded-xl text-center text-3xl tracking-[0.6em] font-mono transition-all duration-200 disabled:opacity-50"
                  style={{
                    backgroundColor: "var(--bg-input)",
                    border: "2px solid var(--border-primary)",
                    color: "var(--text-primary)",
                  }}
                  required
                  autoFocus
                />
              </div>

              {error && (
                <div className="p-4 rounded-xl text-base" style={{ backgroundColor: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", color: "#ef4444" }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full py-5 rounded-xl font-bold text-lg text-white transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: loading ? "var(--accent-green)" : "linear-gradient(135deg, #166534, #15803d)",
                  boxShadow: !loading && code.length === 6 ? "0 4px 16px rgba(22, 101, 52, 0.25)" : "none",
                }}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    確認中...
                  </span>
                ) : (
                  "ログイン"
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setError("");
                }}
                className="w-full py-3 text-base font-medium transition-colors duration-200"
                style={{ color: "var(--text-muted)" }}
              >
                ← メールアドレスを変更
              </button>
            </form>
          )}

          <p className="text-center text-sm mt-8" style={{ color: "var(--text-muted)" }}>
            コードの有効期限は10分間です
          </p>

          {/* 既に豊かさタッピング受講中の方への案内 (welcome表示時は重複するので隠す) */}
          {step === "email" && !isWelcome && (
            <div
              className="mt-6 p-4 rounded-xl text-sm leading-relaxed"
              style={{
                backgroundColor: "var(--accent-gold-soft)",
                border: "1px solid rgba(200, 164, 21, 0.15)",
                color: "var(--text-secondary)",
              }}
            >
              <p className="font-bold mb-1" style={{ color: "var(--text-primary)" }}>
                💡 すでに「豊かさタッピング」をご受講中の方へ
              </p>
              <p>
                MyASPに登録したメールアドレスをそのまま入力してください。
                ご購入から365日以内であれば、追加のお手続きなしでログインしてご利用いただけます。
              </p>
            </div>
          )}
        </div>

        <p className="text-center text-xs mt-6" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
          Powered by AI
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}
