"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type LoginStep = "email" | "otp";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<LoginStep>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
        return;
      }

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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-warm-50 to-primary-50 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg p-8">
          <div className="text-center mb-8">
            <div className="text-4xl mb-3">✨</div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              豊かさタッピング
            </h1>
            <p className="text-gray-600 text-sm">AIコーチ</p>
          </div>

          {step === "email" ? (
            <form onSubmit={handleSendOTP} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  メールアドレス
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  disabled={loading}
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 transition disabled:bg-gray-100"
                  required
                />
              </div>

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !email}
                className="w-full bg-primary-500 hover:bg-primary-600 text-white font-semibold py-3 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "送信中..." : "ログインコードを送信"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOTP} className="space-y-4">
              <div className="p-4 bg-primary-50 rounded-lg mb-4">
                <p className="text-sm text-gray-700">
                  <strong>{email}</strong> に送信されたコードを入力してください
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  6桁のコード
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
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 text-center text-2xl letter-spacing-4 transition disabled:bg-gray-100"
                  required
                  autoFocus
                />
              </div>

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full bg-primary-500 hover:bg-primary-600 text-white font-semibold py-3 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "確認中..." : "ログイン"}
              </button>

              <button
                type="button"
                onClick={() => setStep("email")}
                className="w-full text-primary-600 hover:text-primary-700 font-medium py-2 transition"
              >
                メールアドレスを変更
              </button>
            </form>
          )}

          <p className="text-center text-xs text-gray-500 mt-6">
            10分以内にコードを入力してください
          </p>
        </div>
      </div>
    </div>
  );
}
