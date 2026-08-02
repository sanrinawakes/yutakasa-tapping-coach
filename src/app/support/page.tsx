"use client";

/* eslint-disable @next/next/no-img-element -- Private signed URLs are short-lived and cannot use the image optimizer. */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ImagePlus,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Plus,
  Send,
  X,
} from "lucide-react";
import {
  MAX_SUPPORT_ATTACHMENTS,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_CATEGORIES,
  SUPPORT_STATUS_LABELS,
  type SupportCategory,
  type SupportStatus,
} from "@/lib/support";
import styles from "./page.module.css";

type TicketSummary = {
  id: string;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  created_at: string;
  updated_at: string;
  last_message: string;
  last_message_at: string;
  has_unread_reply: boolean;
};

type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  url: string | null;
};

type Message = {
  id: string;
  sender_type: "user" | "admin" | "system";
  body: string;
  created_at: string;
  attachments: Attachment[];
};

type TicketDetail = {
  ticket: TicketSummary;
  messages: Message[];
};

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null);
  return typeof data?.error === "string" ? data.error : fallback;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function appendFiles(form: FormData, files: File[]) {
  files.forEach((file) => form.append("attachments", file));
}

export default function SupportPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [pageError, setPageError] = useState("");
  const [showNewTicket, setShowNewTicket] = useState(false);
  const [sendingTicket, setSendingTicket] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [formError, setFormError] = useState("");
  const [replyError, setReplyError] = useState("");
  const [category, setCategory] = useState<SupportCategory>("technical");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const newTicketRequestId = useRef(crypto.randomUUID());
  const replyRequestId = useRef(crypto.randomUUID());
  const detailRequestVersion = useRef(0);

  const loadTickets = useCallback(async () => {
    try {
      const response = await fetch("/api/support/tickets", { cache: "no-store" });
      if (response.status === 401) {
        router.push("/login");
        return [];
      }
      if (!response.ok) {
        throw new Error(
          await readError(response, "お問い合わせ履歴を読み込めませんでした。")
        );
      }
      const data = await response.json();
      const loaded = (data.tickets ?? []) as TicketSummary[];
      setTickets(loaded);
      setSelectedId((current) =>
        current && loaded.some((ticket) => ticket.id === current)
          ? current
          : loaded[0]?.id ?? null
      );
      setPageError("");
      return loaded;
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setLoadingTickets(false);
    }
  }, [router]);

  const loadDetail = useCallback(
    async (ticketId: string) => {
      const requestVersion = ++detailRequestVersion.current;
      setLoadingDetail(true);
      try {
        const response = await fetch(
          `/api/support/tickets/${ticketId}/messages`,
          { cache: "no-store" }
        );
        if (response.status === 401) {
          router.push("/login");
          return;
        }
        if (!response.ok) {
          throw new Error(
            await readError(response, "お問い合わせを読み込めませんでした。")
          );
        }
        const loaded = (await response.json()) as TicketDetail;
        if (requestVersion !== detailRequestVersion.current) return;
        setDetail(loaded);
        setTickets((current) =>
          current.map((ticket) =>
            ticket.id === ticketId
              ? { ...ticket, has_unread_reply: false }
              : ticket
          )
        );
        setPageError("");
      } catch (error) {
        if (requestVersion === detailRequestVersion.current) {
          setPageError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (requestVersion === detailRequestVersion.current) {
          setLoadingDetail(false);
        }
      }
    },
    [router]
  );

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId);
    } else {
      setDetail(null);
    }
  }, [loadDetail, selectedId]);

  function pickFiles(
    event: React.ChangeEvent<HTMLInputElement>,
    setter: React.Dispatch<React.SetStateAction<File[]>>
  ) {
    const selected = Array.from(event.target.files ?? []).slice(
      0,
      MAX_SUPPORT_ATTACHMENTS
    );
    setter(selected);
    event.target.value = "";
  }

  function resetNewTicket() {
    setCategory("technical");
    setSubject("");
    setBody("");
    setFiles([]);
    setFormError("");
    newTicketRequestId.current = crypto.randomUUID();
  }

  async function submitNewTicket(event: React.FormEvent) {
    event.preventDefault();
    if (sendingTicket) return;
    setSendingTicket(true);
    setFormError("");
    try {
      const form = new FormData();
      form.set("category", category);
      form.set("subject", subject);
      form.set("body", body);
      form.set("clientRequestId", newTicketRequestId.current);
      appendFiles(form, files);
      const response = await fetch("/api/support/tickets", {
        method: "POST",
        body: form,
      });
      if (response.status === 401) {
        router.push("/login");
        return;
      }
      if (!response.ok) {
        throw new Error(await readError(response, "お問い合わせを送信できませんでした。"));
      }
      const result = (await response.json()) as { ticket_id: string };
      resetNewTicket();
      setShowNewTicket(false);
      await loadTickets();
      setSelectedId(result.ticket_id);
      await loadDetail(result.ticket_id);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingTicket(false);
    }
  }

  async function submitReply(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || sendingReply) return;
    setSendingReply(true);
    setReplyError("");
    try {
      const form = new FormData();
      form.set("body", replyBody);
      form.set("clientRequestId", replyRequestId.current);
      appendFiles(form, replyFiles);
      const response = await fetch(
        `/api/support/tickets/${selectedId}/messages`,
        { method: "POST", body: form }
      );
      if (response.status === 401) {
        router.push("/login");
        return;
      }
      if (!response.ok) {
        throw new Error(await readError(response, "メッセージを送信できませんでした。"));
      }
      setReplyBody("");
      setReplyFiles([]);
      replyRequestId.current = crypto.randomUUID();
      await loadTickets();
      await loadDetail(selectedId);
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingReply(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link className={styles.backLink} href="/chat">
            <ArrowLeft size={19} aria-hidden="true" />
            チャットへ戻る
          </Link>
          <div className={styles.heading}>
            <h1>お問い合わせ</h1>
            <p>過去の連絡と回答をまとめて確認できます</p>
          </div>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => setShowNewTicket(true)}
          >
            <Plus size={18} aria-hidden="true" />
            新規問い合わせ
          </button>
        </div>
      </header>

      {pageError && (
        <div className={styles.errorBanner} role="alert">
          <span>{pageError}</span>
          <button type="button" onClick={() => void loadTickets()}>
            再読み込み
          </button>
        </div>
      )}

      <div className={styles.workspace}>
        <aside
          className={`${styles.ticketList} ${selectedId ? styles.mobileHidden : ""}`}
        >
          <div className={styles.listHeader}>
            <h2>問い合わせ履歴</h2>
            <span>{tickets.length}件</span>
          </div>
          {loadingTickets ? (
            <div className={styles.emptyState} role="status">
              <LoaderCircle className={styles.spin} size={26} />
              読み込んでいます
            </div>
          ) : tickets.length === 0 ? (
            <div className={styles.emptyState}>
              <MessageCircle size={34} aria-hidden="true" />
              <strong>問い合わせはまだありません</strong>
              <span>お困りの内容をこちらからお送りください</span>
            </div>
          ) : (
            <div className={styles.ticketItems}>
              {tickets.map((ticket) => (
                <button
                  type="button"
                  key={ticket.id}
                  onClick={() => setSelectedId(ticket.id)}
                  className={`${styles.ticketItem} ${
                    selectedId === ticket.id ? styles.ticketItemActive : ""
                  }`}
                >
                  <div className={styles.ticketItemTop}>
                    <span className={styles.category}>
                      {SUPPORT_CATEGORY_LABELS[ticket.category]}
                    </span>
                    <span className={styles.itemDate}>
                      {formatDate(ticket.last_message_at)}
                    </span>
                  </div>
                  <div className={styles.subjectLine}>
                    {ticket.has_unread_reply && (
                      <span className={styles.unreadDot} aria-label="未読の返信あり" />
                    )}
                    <strong>{ticket.subject}</strong>
                  </div>
                  <p>{ticket.last_message}</p>
                  <span className={styles.statusText}>
                    {SUPPORT_STATUS_LABELS[ticket.status]}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section
          className={`${styles.conversation} ${!selectedId ? styles.mobileHidden : ""}`}
        >
          {!selectedId ? (
            <div className={styles.emptyConversation}>
              <MessageCircle size={42} aria-hidden="true" />
              <strong>問い合わせを選択してください</strong>
            </div>
          ) : loadingDetail && !detail ? (
            <div className={styles.emptyConversation} role="status">
              <LoaderCircle className={styles.spin} size={30} />
              読み込んでいます
            </div>
          ) : detail ? (
            <>
              <div className={styles.conversationHeader}>
                <button
                  type="button"
                  className={styles.mobileBack}
                  onClick={() => setSelectedId(null)}
                  aria-label="問い合わせ一覧へ戻る"
                >
                  <ArrowLeft size={20} />
                </button>
                <div>
                  <div className={styles.detailMeta}>
                    <span>{SUPPORT_CATEGORY_LABELS[detail.ticket.category]}</span>
                    <span>・</span>
                    <span>{SUPPORT_STATUS_LABELS[detail.ticket.status]}</span>
                  </div>
                  <h2>{detail.ticket.subject}</h2>
                </div>
              </div>

              <div className={styles.messages} aria-live="polite">
                {detail.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`${styles.message} ${styles[message.sender_type]}`}
                  >
                    <div className={styles.messageLabel}>
                      {message.sender_type === "user"
                        ? "あなた"
                        : message.sender_type === "admin"
                          ? "豊かさAI サポート"
                          : "受付"}
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
                              className={styles.attachment}
                            >
                              {/* Signed private image URL; alt uses the sender's filename. */}
                              <img src={attachment.url} alt={attachment.filename} />
                              <span>{attachment.filename}</span>
                            </a>
                          ) : null
                        )}
                      </div>
                    )}
                    <time>{formatDate(message.created_at)}</time>
                  </article>
                ))}
              </div>

              <form className={styles.replyForm} onSubmit={submitReply}>
                <textarea
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                  rows={3}
                  maxLength={10_000}
                  placeholder="追加で伝えたい内容を入力"
                  aria-label="追加メッセージ"
                  required
                />
                {replyFiles.length > 0 && (
                  <FileList files={replyFiles} onClear={() => setReplyFiles([])} />
                )}
                {replyError && <p className={styles.formError}>{replyError}</p>}
                <div className={styles.replyActions}>
                  <label className={styles.iconButton} title="画像を添付">
                    <Paperclip size={20} aria-hidden="true" />
                    <span className={styles.visuallyHidden}>画像を添付</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
                      multiple
                      onChange={(event) => pickFiles(event, setReplyFiles)}
                    />
                  </label>
                  <button
                    type="submit"
                    className={styles.sendButton}
                    disabled={sendingReply || !replyBody.trim()}
                  >
                    {sendingReply ? (
                      <LoaderCircle className={styles.spin} size={18} />
                    ) : (
                      <Send size={18} />
                    )}
                    送信
                  </button>
                </div>
              </form>
            </>
          ) : null}
        </section>
      </div>

      {showNewTicket && (
        <div className={styles.modalBackdrop} role="presentation">
          <section
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-ticket-title"
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="new-ticket-title">新規問い合わせ</h2>
                <p>状況が分かる画像を3枚まで添付できます</p>
              </div>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => {
                  setShowNewTicket(false);
                  resetNewTicket();
                }}
                aria-label="閉じる"
              >
                <X size={22} />
              </button>
            </div>
            <form className={styles.newTicketForm} onSubmit={submitNewTicket}>
              <label>
                種類
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value as SupportCategory)}
                >
                  {SUPPORT_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {SUPPORT_CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                件名
                <input
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  maxLength={120}
                  placeholder="例：会話履歴が表示されない"
                  required
                />
              </label>
              <label>
                内容
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={8}
                  maxLength={10_000}
                  placeholder="どの画面で、何をした時に、どのような表示になったかをご記入ください"
                  required
                />
              </label>
              <label className={styles.fileButton}>
                <ImagePlus size={20} aria-hidden="true" />
                画像を選択
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
                  multiple
                  onChange={(event) => pickFiles(event, setFiles)}
                />
              </label>
              {files.length > 0 && (
                <FileList files={files} onClear={() => setFiles([])} />
              )}
              <div className={styles.receiptNotice}>
                <Clock3 size={19} aria-hidden="true" />
                <span>
                  受付後すぐに確認を始めます。調査内容によっては2〜3日かかる場合があり、対応後にこの画面でご連絡します。
                </span>
              </div>
              {formError && <p className={styles.formError}>{formError}</p>}
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => {
                    setShowNewTicket(false);
                    resetNewTicket();
                  }}
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className={styles.primaryButton}
                  disabled={sendingTicket || !subject.trim() || !body.trim()}
                >
                  {sendingTicket ? (
                    <LoaderCircle className={styles.spin} size={18} />
                  ) : (
                    <CheckCircle2 size={18} />
                  )}
                  送信する
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function FileList({ files, onClear }: { files: File[]; onClear: () => void }) {
  return (
    <div className={styles.fileList}>
      <div>
        {files.map((file) => (
          <span key={`${file.name}-${file.size}`}>{file.name}</span>
        ))}
      </div>
      <button type="button" onClick={onClear} aria-label="添付画像をすべて外す">
        <X size={17} />
      </button>
    </div>
  );
}
