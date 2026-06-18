"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";

type DiagnosticRow = {
  email: string;
  subscriber: {
    email: string;
    name: string | null;
    status: string;
    subscriptionStatus: string;
    firstPaymentDate: string | null;
    updatedAt: string;
    addedVia: string | null;
  } | null;
  access: { allowed: true } | { allowed: false; reason: string; firstPaymentDate?: string | null };
  payment: { source: "stripe" | "paypal"; paidAt: string; name: string | null } | null;
  rescued: boolean;
  recommendation: string;
};

type ApiState = {
  loading: boolean;
  error: string;
  data: unknown;
};

const initialApiState: ApiState = { loading: false, error: "", data: null };

function parseEmails(value: string): string[] {
  return value
    .split(/[\n,、\s]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function isDiagnosticData(data: unknown): data is { diagnostics: DiagnosticRow[] } {
  return Boolean(
    data &&
      typeof data === "object" &&
      "diagnostics" in data &&
      Array.isArray((data as { diagnostics?: unknown }).diagnostics)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export default function LoginSupportPage() {
  const [token, setToken] = useState("");
  const [emails, setEmails] = useState("");
  const [rescueProviderPayment, setRescueProviderPayment] = useState(false);
  const [lookbackDays, setLookbackDays] = useState(14);
  const [diagnostics, setDiagnostics] = useState<ApiState>(initialApiState);
  const [syncResult, setSyncResult] = useState<ApiState>(initialApiState);
  const [manualResult, setManualResult] = useState<ApiState>(initialApiState);
  const [manual, setManual] = useState({
    email: "",
    name: "",
    orderId: "",
    scenarioId: "",
    receiptDate: "",
    note: "",
  });

  useEffect(() => {
    const savedToken = window.localStorage.getItem("admin-login-support-token");
    if (savedToken) setToken(savedToken);
  }, []);

  useEffect(() => {
    if (token) {
      window.localStorage.setItem("admin-login-support-token", token);
    }
  }, [token]);

  async function postJson(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token.trim(),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  async function runDiagnostics() {
    setDiagnostics({ loading: true, error: "", data: null });
    try {
      const data = await postJson("/api/admin/login-diagnostics", {
        emails: parseEmails(emails),
        includePaymentLookup: true,
        rescueProviderPayment,
      });
      setDiagnostics({ loading: false, error: "", data });
    } catch (error) {
      setDiagnostics({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: null,
      });
    }
  }

  async function runSync(apply: boolean) {
    setSyncResult({ loading: true, error: "", data: null });
    try {
      const data = await postJson("/api/admin/sync-payments", {
        lookbackDays,
        apply,
      });
      setSyncResult({ loading: false, error: "", data });
    } catch (error) {
      setSyncResult({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: null,
      });
    }
  }

  async function runManualRescue(event: React.FormEvent) {
    event.preventDefault();
    setManualResult({ loading: true, error: "", data: null });
    try {
      const data = await postJson("/api/admin/manual-rescue", manual);
      setManualResult({ loading: false, error: "", data });
    } catch (error) {
      setManualResult({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: null,
      });
    }
  }

  const diagnosticRows = isDiagnosticData(diagnostics.data)
    ? diagnostics.data.diagnostics
    : [];
  const syncSummary = isRecord(syncResult.data)
    ? (syncResult.data.summary as Record<string, unknown> | undefined)
    : undefined;

  return (
    <main
      className={styles.page}
      style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
    >
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>
              Admin
            </p>
            <h1 className={styles.title}>ログイン救済</h1>
          </div>
          <label className={`${styles.field} ${styles.tokenField}`}>
            管理トークン
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              style={{
                backgroundColor: "var(--bg-input)",
                borderColor: "var(--border-primary)",
                color: "var(--text-primary)",
              }}
            />
          </label>
        </header>

        <section className={styles.panel}>
          <div className={styles.diagnosticGrid}>
            <label className={styles.field}>
              メール診断
              <textarea
                value={emails}
                onChange={(event) => setEmails(event.target.value)}
                rows={5}
                placeholder="customer@example.com"
                style={{
                  backgroundColor: "var(--bg-input)",
                  borderColor: "var(--border-primary)",
                  color: "var(--text-primary)",
                }}
              />
            </label>
            <div className={styles.actionColumn}>
              <label className={styles.checkboxLine}>
                <input
                  type="checkbox"
                  checked={rescueProviderPayment}
                  onChange={(event) => setRescueProviderPayment(event.target.checked)}
                  className="h-4 w-4"
                />
                Stripe/PayPal一致時に救済
              </label>
              <button
                type="button"
                onClick={runDiagnostics}
                disabled={diagnostics.loading || !token || !emails.trim()}
                className={styles.button}
                style={{ backgroundColor: "#166534" }}
              >
                {diagnostics.loading ? "確認中" : "診断"}
              </button>
            </div>
          </div>

          {diagnostics.error && (
            <p className={styles.error}>
              {diagnostics.error}
            </p>
          )}

          {diagnosticRows.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>メール</th>
                    <th>DB</th>
                    <th>ログイン</th>
                    <th>決済API</th>
                    <th>処理</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnosticRows.map((row) => (
                    <tr key={row.email}>
                      <td>{row.email}</td>
                      <td>
                        {row.subscriber ? (
                          <div>
                            <div>{row.subscriber.status} / {row.subscriber.subscriptionStatus}</div>
                            <div className={styles.muted}>{row.subscriber.firstPaymentDate || "決済日なし"}</div>
                            <div className={styles.muted}>{row.subscriber.addedVia || "added_viaなし"}</div>
                          </div>
                        ) : (
                          "なし"
                        )}
                      </td>
                      <td>
                        {row.access.allowed ? "可" : `不可: ${row.access.reason}`}
                      </td>
                      <td>
                        {row.payment ? `${row.payment.source} / ${row.payment.paidAt}` : "なし"}
                      </td>
                      <td>
                        <div>{row.recommendation}</div>
                        {row.rescued && <div className={styles.ok}>救済済み</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={styles.twoColumn}>
          <div className={styles.panel}>
            <h2 className={styles.sectionTitle}>支払い同期</h2>
            <div className={styles.syncControls}>
              <label className={styles.field}>
                対象日数
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={lookbackDays}
                  onChange={(event) => setLookbackDays(Number(event.target.value))}
                  style={{
                    backgroundColor: "var(--bg-input)",
                    borderColor: "var(--border-primary)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => runSync(false)}
                disabled={syncResult.loading || !token}
                className={styles.secondaryButton}
                style={{ borderColor: "var(--border-primary)", color: "var(--text-primary)" }}
              >
                ドライラン
              </button>
              <button
                type="button"
                onClick={() => runSync(true)}
                disabled={syncResult.loading || !token}
                className={styles.button}
                style={{ backgroundColor: "#166534" }}
              >
                実行
              </button>
            </div>
            {syncResult.error && (
              <p className={styles.error}>
                {syncResult.error}
              </p>
            )}
            {syncSummary && (
              <dl className={styles.summaryGrid}>
                {Object.entries(syncSummary).map(([key, value]) => (
                  <div key={key} className={styles.summaryItem}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          <form onSubmit={runManualRescue} className={styles.panel}>
            <h2 className={styles.sectionTitle}>MyASP確認済み救済</h2>
            <div className={styles.fieldGrid}>
              {[
                ["email", "メール", "email"],
                ["name", "名前", "text"],
                ["orderId", "注文ID", "text"],
                ["scenarioId", "シナリオID", "text"],
                ["receiptDate", "受領日", "date"],
                ["note", "メモ", "text"],
              ].map(([key, label, type]) => (
                <label key={key} className={styles.field}>
                  {label}
                  <input
                    type={type}
                    value={manual[key as keyof typeof manual]}
                    onChange={(event) =>
                      setManual((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                    style={{
                      backgroundColor: "var(--bg-input)",
                      borderColor: "var(--border-primary)",
                      color: "var(--text-primary)",
                    }}
                    required={key === "email" || key === "orderId" || key === "receiptDate"}
                  />
                </label>
              ))}
            </div>
            <button
              type="submit"
              disabled={manualResult.loading || !token}
              className={`${styles.button} ${styles.fullButton}`}
              style={{ backgroundColor: "#166534" }}
            >
              {manualResult.loading ? "救済中" : "救済"}
            </button>
            {manualResult.error && (
              <p className={styles.error}>
                {manualResult.error}
              </p>
            )}
            {manualResult.data !== null && (
              <pre className={styles.pre}>
                {JSON.stringify(manualResult.data, null, 2)}
              </pre>
            )}
          </form>
        </section>
      </div>
    </main>
  );
}
