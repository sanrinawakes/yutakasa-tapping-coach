"use client";

import { useTheme } from "@/components/ThemeProvider";

/**
 * 月額9800円コーチングサブスク 加入LP（仮設置）
 * - myaspのサブスクシナリオ申込URLが用意できたら、ここからリダイレクトor正式LPに差し替える
 */
export default function SubscribePage() {
  const { theme, toggleTheme } = useTheme();

  // 環境変数で本物の申込URLを差し込めるようにしておく
  const subscribeUrl = process.env.NEXT_PUBLIC_SUBSCRIPTION_LANDING_URL || "";

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6 bg-pattern"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
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
        {theme === "dark" ? "☀" : "☾"}
      </button>

      <div className="w-full max-w-2xl">
        <div
          className="rounded-2xl p-10 md:p-14 text-center"
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-secondary)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <div
            className="inline-flex items-center justify-center w-20 h-20 rounded-full mb-6"
            style={{ backgroundColor: "var(--bg-tertiary)" }}
          >
            <span className="text-4xl">🌿</span>
          </div>
          <h1
            className="font-display text-3xl md:text-4xl font-semibold mb-4"
            style={{ color: "var(--text-primary)" }}
          >
            月額継続コーチング
          </h1>
          <p
            className="text-lg mb-8"
            style={{ color: "var(--text-secondary)" }}
          >
            ご購入から365日のご利用期限を超えた方は、月額9,800円の
            <br />
            「継続コーチングプラン」にご加入いただくことで
            <br />
            引き続きAIコーチをご利用いただけます。
          </p>

          <div
            className="rounded-xl p-6 mb-8 text-left"
            style={{
              backgroundColor: "var(--accent-gold-soft)",
              border: "1px solid rgba(200, 164, 21, 0.15)",
              color: "var(--text-secondary)",
            }}
          >
            <p className="font-bold text-base mb-2" style={{ color: "var(--text-primary)" }}>
              プラン詳細
            </p>
            <ul className="text-base space-y-1 list-disc pl-5">
              <li>月額 9,800円（税込）</li>
              <li>AIコーチへの質問が無制限（1日15回まで）</li>
              <li>過去のチャット履歴がそのまま使える</li>
              <li>いつでも解約可能</li>
            </ul>
          </div>

          {subscribeUrl ? (
            <a
              href={subscribeUrl}
              className="inline-block w-full py-5 rounded-xl font-bold text-lg text-white transition-all duration-200"
              style={{
                background: "linear-gradient(135deg, #166534, #15803d)",
                boxShadow: "0 4px 16px rgba(22, 101, 52, 0.25)",
              }}
            >
              プランに加入する
            </a>
          ) : (
            <div
              className="rounded-xl p-5 text-base"
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.2)",
                color: "#ef4444",
              }}
            >
              準備中です。サポートまでご連絡ください。
            </div>
          )}

          <div className="mt-8">
            <a
              href="/login"
              className="text-base font-medium underline"
              style={{ color: "var(--text-muted)" }}
            >
              ← ログインに戻る
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
