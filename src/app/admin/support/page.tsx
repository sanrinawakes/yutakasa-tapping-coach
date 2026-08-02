"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  ImageIcon,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  Send,
} from "lucide-react";
import {
  SUPPORT_AUTOMATION_LABELS,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_STATUS_LABELS,
  type SupportAutomationStatus,
  type SupportCategory,
  type SupportStatus,
} from "@/lib/support";
import styles from "./page.module.css";

type Ticket = {
  id: string;
  user_email: string;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  decision_required: boolean;
  automation_status: SupportAutomationStatus;
  created_at: string;
  updated_at: string;
  last_message?: string;
  last_message_at?: string;
  has_unread_message?: boolean;
};

type Message = {
  id: string;
  sender_type: "user" | "admin" | "system";
  sender_email: string | null;
  body: string;
  created_at: string;
  attachments: Array<{
    id: string;
    filename: string;
    url: string | null;
  }>;
};

type WorkLog = {
  id: string;
  event_type: string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type Detail = { ticket: Ticket; messages: Message[]; work_logs: WorkLog[] };

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function parseResponse(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string" ? data.error : `HTTP ${response.status}`
    );
  }
  return data;
}

export default function AdminSupportPage() {
  const [token, setToken] = useState("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SupportStatus | "">("");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [resolveWithReply, setResolveWithReply] = useState(true);
  const replyRequestId = useRef(crypto.randomUUID());

  useEffect(() => {
    setToken(window.localStorage.getItem("admin-login-support-token") ?? "");
  }, []);

  useEffect(() => {
    if (token.trim()) {
      window.localStorage.setItem("admin-login-support-token", token.trim());
    }
  }, [token]);

  const headers = useMemo(
    () => ({ "x-admin-token": token.trim() }),
    [token]
  );

  const loadTickets = useCallback(async (): Promise<Ticket[] | null> => {
    if (!token.trim()) return null;
    setLoadingList(true);
    try {
      const search = new URLSearchParams();
      if (status) search.set("status", status);
      if (query.trim()) search.set("query", query.trim());
      const response = await fetch(`/api/admin/support?${search}`, {
        headers: { "x-admin-token": token.trim() },
        cache: "no-store",
      });
      const data = await parseResponse(response);
      const loaded = (data.tickets ?? []) as Ticket[];
      setTickets(loaded);
      setSelectedId((current) =>
        current && loaded.some((ticket) => ticket.id === current)
          ? current
          : loaded[0]?.id ?? null
      );
      setError("");
      return loaded;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setLoadingList(false);
    }
  }, [query, status, token]);

  const loadDetail = useCallback(
    async (ticketId: string) => {
      if (!token.trim()) return;
      setLoadingDetail(true);
      try {
        const response = await fetch(`/api/admin/support/${ticketId}`, {
          headers: { "x-admin-token": token.trim() },
          cache: "no-store",
        });
        const loaded = (await parseResponse(response)) as Detail;
        setDetail(loaded);
        setTickets((current) =>
          current.map((ticket) =>
            ticket.id === ticketId
              ? { ...ticket, has_unread_message: false }
              : ticket
          )
        );
        setError("");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoadingDetail(false);
      }
    },
    [token]
  );

  const refreshAll = useCallback(async () => {
    const loaded = await loadTickets();
    if (!loaded) return;
    if (selectedId && loaded.some((ticket) => ticket.id === selectedId)) {
      await loadDetail(selectedId);
    } else if (loaded.length === 0) {
      setDetail(null);
    }
  }, [loadDetail, loadTickets, selectedId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTickets(), 250);
    return () => window.clearTimeout(timer);
  }, [loadTickets]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [loadDetail, selectedId]);

  async function patchTicket(body: Record<string, unknown>) {
    if (!selectedId) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/support/${selectedId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await parseResponse(response);
      await loadTickets();
      await loadDetail(selectedId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function sendReply(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || !replyBody.trim() || replying) return;
    setReplying(true);
    try {
      const response = await fetch(`/api/admin/support/${selectedId}/messages`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          body: replyBody,
          clientRequestId: replyRequestId.current,
          resolve: resolveWithReply,
        }),
      });
      await parseResponse(response);
      setReplyBody("");
      replyRequestId.current = crypto.randomUUID();
      await loadTickets();
      await loadDetail(selectedId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReplying(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>豊かさAI 管理</span>
          <h1>問い合わせ管理</h1>
        </div>
        <nav>
          <Link href="/admin/login-support">ログイン救済</Link>
          <Link href="/chat" target="_blank">
            利用画面 <ExternalLink size={14} />
          </Link>
        </nav>
      </header>

      <section className={styles.authbar}>
        <LockKeyhole size={18} aria-hidden="true" />
        <label>
          管理トークン
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="管理トークンを入力"
          />
        </label>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={!token.trim() || loadingList}
          title="再読み込み"
          aria-label="再読み込み"
        >
          <RefreshCw className={loadingList ? styles.spin : ""} size={19} />
        </button>
      </section>

      {error && (
        <div className={styles.error} role="alert">
          <AlertCircle size={18} />
          {error}
        </div>
      )}

      <div className={styles.filters}>
        <label className={styles.search}>
          <Search size={18} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="メール・件名・本文を検索"
          />
        </label>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as SupportStatus | "")}
          aria-label="状態で絞り込み"
        >
          <option value="">すべての状態</option>
          <option value="open">受付済み</option>
          <option value="in_progress">対応中</option>
          <option value="waiting_user">返信あり</option>
          <option value="resolved">対応完了</option>
        </select>
      </div>

      <div className={styles.workspace}>
        <aside className={styles.ticketList}>
          <div className={styles.listCount}>
            <strong>問い合わせ</strong>
            <span>{tickets.length}件</span>
          </div>
          {loadingList && tickets.length === 0 ? (
            <div className={styles.empty}>
              <LoaderCircle className={styles.spin} />
              読み込み中
            </div>
          ) : tickets.length === 0 ? (
            <div className={styles.empty}>該当する問い合わせはありません</div>
          ) : (
            tickets.map((ticket) => (
              <button
                type="button"
                key={ticket.id}
                className={`${styles.ticketItem} ${
                  selectedId === ticket.id ? styles.active : ""
                }`}
                onClick={() => setSelectedId(ticket.id)}
              >
                <div className={styles.itemTop}>
                  <span>{SUPPORT_CATEGORY_LABELS[ticket.category]}</span>
                  <time>{formatDate(ticket.last_message_at ?? ticket.updated_at)}</time>
                </div>
                <strong>
                  {ticket.has_unread_message && <i aria-label="未読" />}
                  {ticket.subject}
                </strong>
                <small>{ticket.user_email}</small>
                <p>{ticket.last_message}</p>
                <div className={styles.itemStatus}>
                  <span>{SUPPORT_STATUS_LABELS[ticket.status]}</span>
                  {ticket.decision_required && <b>判断待ち</b>}
                </div>
              </button>
            ))
          )}
        </aside>

        <section className={styles.detail}>
          {!selectedId ? (
            <div className={styles.empty}>問い合わせを選択してください</div>
          ) : loadingDetail && !detail ? (
            <div className={styles.empty}>
              <LoaderCircle className={styles.spin} />
              読み込み中
            </div>
          ) : detail ? (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.detailLabels}>
                    <span>{SUPPORT_CATEGORY_LABELS[detail.ticket.category]}</span>
                    <span>{SUPPORT_STATUS_LABELS[detail.ticket.status]}</span>
                    <span>
                      {SUPPORT_AUTOMATION_LABELS[detail.ticket.automation_status]}
                    </span>
                    {detail.ticket.decision_required && <b>経営判断待ち</b>}
                  </div>
                  <h2>{detail.ticket.subject}</h2>
                  <a href={`mailto:${detail.ticket.user_email}`}>
                    {detail.ticket.user_email}
                  </a>
                </div>
                <div className={styles.headerActions}>
                  <select
                    aria-label="対応状態"
                    value={detail.ticket.status}
                    disabled={saving}
                    onChange={(event) =>
                      void patchTicket({ status: event.target.value })
                    }
                  >
                    <option value="open">受付済み</option>
                    <option value="in_progress">対応中</option>
                    <option value="waiting_user">返信あり</option>
                    <option value="resolved">対応完了</option>
                  </select>
                  <label className={styles.decisionToggle}>
                    <input
                      type="checkbox"
                      checked={detail.ticket.decision_required}
                      disabled={saving}
                      onChange={(event) =>
                        void patchTicket({ decisionRequired: event.target.checked })
                      }
                    />
                    経営判断が必要
                  </label>
                </div>
              </div>

              <div className={styles.detailBody}>
                <div className={styles.messages}>
                  {detail.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`${styles.message} ${styles[message.sender_type]}`}
                    >
                      <div>
                        <strong>
                          {message.sender_type === "user"
                            ? "利用者"
                            : message.sender_type === "admin"
                              ? "サポート"
                              : "受付"}
                        </strong>
                        <time>{formatDate(message.created_at)}</time>
                      </div>
                      <p>{message.body}</p>
                      {message.attachments.length > 0 && (
                        <div className={styles.attachments}>
                          {message.attachments.map((attachment) =>
                            attachment.url ? (
                              <a
                                key={attachment.id}
                                href={attachment.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <ImageIcon size={16} />
                                {attachment.filename}
                              </a>
                            ) : null
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                <aside className={styles.workLogs}>
                  <h3>Codex作業記録</h3>
                  {detail.work_logs.length === 0 ? (
                    <p>作業記録はまだありません</p>
                  ) : (
                    detail.work_logs.map((log) => (
                      <article key={log.id}>
                        <span>{log.event_type}</span>
                        <p>{log.summary}</p>
                        <time>{formatDate(log.created_at)}</time>
                      </article>
                    ))
                  )}
                </aside>
              </div>

              <form className={styles.replyForm} onSubmit={sendReply}>
                <label>
                  利用者へ返信
                  <textarea
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    maxLength={10_000}
                    rows={4}
                    placeholder="調査結果や操作方法を具体的に入力"
                    required
                  />
                </label>
                <div>
                  <label className={styles.resolveToggle}>
                    <input
                      type="checkbox"
                      checked={resolveWithReply}
                      onChange={(event) => setResolveWithReply(event.target.checked)}
                    />
                    この返信で対応完了にする
                  </label>
                  <button
                    type="submit"
                    disabled={replying || !replyBody.trim()}
                  >
                    {replying ? (
                      <LoaderCircle className={styles.spin} size={18} />
                    ) : resolveWithReply ? (
                      <CheckCircle2 size={18} />
                    ) : (
                      <Send size={18} />
                    )}
                    返信を送信
                  </button>
                </div>
              </form>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
