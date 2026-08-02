import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { getSupabase } from "@/lib/supabase";
import {
  detectSupportFileType,
  MAX_SUPPORT_ATTACHMENT_BYTES,
  MAX_SUPPORT_ATTACHMENTS,
  MAX_SUPPORT_MESSAGE_LENGTH,
  MAX_SUPPORT_SUBJECT_LENGTH,
  MAX_SUPPORT_TOTAL_ATTACHMENT_BYTES,
  normalizeSupportText,
  requiresOwnerDecision,
  sanitizeSupportFilename,
  type SupportAutomationStatus,
  type SupportCategory,
  type SupportStatus,
} from "@/lib/support";
import { SupportRequestError } from "@/lib/server/support-request";

const SUPPORT_BUCKET = "yutakasa-support";
const SUPPORT_NOTIFICATION_EMAIL =
  process.env.SUPPORT_NOTIFICATION_EMAIL || "181wyc@gmail.com";
const SUPPORT_FROM_EMAIL = process.env.FROM_EMAIL || "noreply@silversense.cc";
const SUPPORT_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.BASE_URL ||
  "https://yutakasa-tapping-coach.vercel.app";
const SUPPORT_AUTOMATION_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const SUPPORT_EMAIL_TIMEOUT_MS = 5_000;

export type SupportAttachment = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  url: string | null;
};

export type SupportMessage = {
  id: string;
  ticket_id: string;
  sender_type: "user" | "admin" | "system";
  sender_email: string | null;
  body: string;
  created_at: string;
  attachments: SupportAttachment[];
};

export type SupportTicket = {
  id: string;
  user_email: string;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  decision_required: boolean;
  automation_status: SupportAutomationStatus;
  user_last_read_at: string | null;
  admin_last_read_at: string | null;
  created_at: string;
  updated_at: string;
};

type UploadedAttachment = {
  storage_path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
};

type StoredAttachmentRow = UploadedAttachment & {
  id: string;
  ticket_id: string;
  message_id: string;
};

function isTestAddress(email: string): boolean {
  return /^codex[-+.].*@silversense\.cc$/iu.test(email);
}

function shouldSendEmail(email: string): boolean {
  if (isTestAddress(email)) return false;
  if (process.env.NODE_ENV === "test") return false;
  return process.env.VERCEL_ENV !== "preview";
}

async function sendSupportEmail(params: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ sent: boolean; error: string | null }> {
  if (!shouldSendEmail(params.to)) return { sent: false, error: null };
  if (!process.env.RESEND_API_KEY) {
    return { sent: false, error: "RESEND_API_KEY is not configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(SUPPORT_EMAIL_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `豊かさAI サポート <${SUPPORT_FROM_EMAIL}>`,
        to: [params.to],
        subject: params.subject,
        text: params.text,
      }),
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      return {
        sent: false,
        error: `Resend ${response.status}: ${responseBody.slice(0, 500)}`,
      };
    }
    return { sent: true, error: null };
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeWorkLog(
  ticketId: string,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown> = {}
) {
  const { error } = await getSupabase().from("support_work_logs").insert({
    ticket_id: ticketId,
    event_type: eventType,
    summary: normalizeSupportText(summary, 5000),
    metadata,
  });
  if (error) throw error;
}

async function recordNotificationResult(
  ticketId: string,
  recipientType: "admin" | "user",
  result: { sent: boolean; error: string | null }
) {
  if (result.error) {
    await writeWorkLog(
      ticketId,
      "notification_failed",
      `${recipientType === "admin" ? "管理者" : "利用者"}通知メールの送信に失敗しました。`,
      { recipient_type: recipientType, error: result.error }
    ).catch((error) => console.error("Failed to record support email error:", error));
  }
}

async function ensureSupportBucket() {
  const storage = getSupabase().storage;
  const { data, error } = await storage.getBucket(SUPPORT_BUCKET);
  if (data && !error) return;

  const created = await storage.createBucket(SUPPORT_BUCKET, {
    public: false,
    fileSizeLimit: MAX_SUPPORT_ATTACHMENT_BYTES,
    allowedMimeTypes: [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/heic",
      "image/heif",
    ],
  });
  if (created.error && !/already exists/iu.test(created.error.message)) {
    throw created.error;
  }
}

async function uploadAttachments(
  userEmail: string,
  requestId: string,
  files: File[]
): Promise<{ attachments: UploadedAttachment[]; newlyUploaded: string[] }> {
  if (files.length > MAX_SUPPORT_ATTACHMENTS) {
    throw new SupportRequestError(
      `画像は${MAX_SUPPORT_ATTACHMENTS}枚まで添付できます。`
    );
  }
  if (
    files.reduce((totalBytes, file) => totalBytes + file.size, 0) >
    MAX_SUPPORT_TOTAL_ATTACHMENT_BYTES
  ) {
    throw new SupportRequestError("画像は合計4MB以下にしてください。");
  }
  if (files.length === 0) return { attachments: [], newlyUploaded: [] };

  await ensureSupportBucket();

  const emailHash = createHash("sha256").update(userEmail).digest("hex").slice(0, 24);
  const uploadAttemptId = randomUUID();
  const attachments: UploadedAttachment[] = [];
  const newlyUploaded: string[] = [];

  try {
    for (const [index, file] of files.entries()) {
      if (file.size <= 0 || file.size > MAX_SUPPORT_ATTACHMENT_BYTES) {
        throw new SupportRequestError("画像は1枚4MB以下にしてください。");
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const detected = detectSupportFileType(bytes);
      if (!detected) {
        throw new SupportRequestError(
          "PNG、JPEG、WebP、HEIC形式の画像を添付してください。"
        );
      }

      const contentHash = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
      const storagePath = `${emailHash}/${requestId}/${uploadAttemptId}/${index + 1}-${contentHash}.${detected.extension}`;
      const filename = sanitizeSupportFilename(file.name, detected.extension);
      const result = await getSupabase().storage
        .from(SUPPORT_BUCKET)
        .upload(storagePath, bytes, {
          contentType: detected.contentType,
          upsert: false,
        });

      if (result.error && !/already exists|duplicate/iu.test(result.error.message)) {
        throw result.error;
      }
      if (!result.error) newlyUploaded.push(storagePath);

      attachments.push({
        storage_path: storagePath,
        filename,
        content_type: detected.contentType,
        size_bytes: file.size,
      });
    }
  } catch (error) {
    if (newlyUploaded.length > 0) {
      await getSupabase().storage.from(SUPPORT_BUCKET).remove(newlyUploaded);
    }
    throw error;
  }

  return { attachments, newlyUploaded };
}

async function removeNewUploads(paths: string[]) {
  if (paths.length === 0) return;
  const { error } = await getSupabase().storage.from(SUPPORT_BUCKET).remove(paths);
  if (error) {
    console.error("Failed to remove uncommitted support attachments:", error);
  }
}

async function removeUnreferencedUploads(paths: string[]) {
  if (paths.length === 0) return;

  const { data, error } = await getSupabase()
    .from("support_attachments")
    .select("storage_path")
    .in("storage_path", paths);
  if (error) {
    console.error(
      "Could not verify whether failed support uploads are referenced:",
      error
    );
    return;
  }

  const referenced = new Set(
    (data ?? []).map((attachment) => attachment.storage_path as string)
  );
  await removeNewUploads(paths.filter((storagePath) => !referenced.has(storagePath)));
}

async function signedAttachmentRows(
  rows: StoredAttachmentRow[]
): Promise<Map<string, SupportAttachment[]>> {
  const byMessage = new Map<string, SupportAttachment[]>();
  if (rows.length === 0) return byMessage;

  const paths = rows.map((row) => row.storage_path);
  const { data, error } = await getSupabase().storage
    .from(SUPPORT_BUCKET)
    .createSignedUrls(paths, 60 * 60);
  if (error) throw error;

  rows.forEach((row, index) => {
    const items = byMessage.get(row.message_id) ?? [];
    items.push({
      id: row.id,
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      url: data?.[index]?.signedUrl ?? null,
    });
    byMessage.set(row.message_id, items);
  });
  return byMessage;
}

async function messagesForTicket(ticketId: string): Promise<SupportMessage[]> {
  const [{ data: messages, error: messageError }, { data: attachments, error: attachmentError }] =
    await Promise.all([
      getSupabase()
        .from("support_messages")
        .select("id,ticket_id,sender_type,sender_email,body,created_at")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true }),
      getSupabase()
        .from("support_attachments")
        .select("id,ticket_id,message_id,storage_path,filename,content_type,size_bytes")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true }),
    ]);

  if (messageError) throw messageError;
  if (attachmentError) throw attachmentError;
  const attachmentMap = await signedAttachmentRows(
    (attachments ?? []) as StoredAttachmentRow[]
  );

  return (messages ?? []).map((message) => ({
    ...(message as Omit<SupportMessage, "attachments">),
    attachments: attachmentMap.get(message.id) ?? [],
  }));
}

function latestMessage(messages: Array<Pick<SupportMessage, "body" | "created_at" | "sender_type">>) {
  return [...messages].sort((left, right) =>
    right.created_at.localeCompare(left.created_at)
  )[0];
}

export async function listUserSupportTickets(userEmail: string) {
  const { data: tickets, error } = await getSupabase()
    .from("support_tickets")
    .select("*")
    .eq("user_email", userEmail)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  if (!tickets?.length) return [];

  const ids = tickets.map((ticket) => ticket.id);
  const { data: messages, error: messageError } = await getSupabase()
    .from("support_messages")
    .select("ticket_id,sender_type,body,created_at")
    .in("ticket_id", ids)
    .order("created_at", { ascending: false });
  if (messageError) throw messageError;

  return tickets.map((ticket) => {
    const ticketMessages = (messages ?? []).filter(
      (message) => message.ticket_id === ticket.id
    ) as Array<Pick<SupportMessage, "body" | "created_at" | "sender_type">>;
    const latest = latestMessage(ticketMessages);
    const hasUnreadReply = ticketMessages.some(
      (message) =>
        message.sender_type === "admin" &&
        (!ticket.user_last_read_at || message.created_at > ticket.user_last_read_at)
    );
    return {
      ...(ticket as SupportTicket),
      last_message: latest?.body ?? "",
      last_message_at: latest?.created_at ?? ticket.updated_at,
      has_unread_reply: hasUnreadReply,
    };
  });
}

export async function getUserSupportTicket(userEmail: string, ticketId: string) {
  const { data: ticket, error } = await getSupabase()
    .from("support_tickets")
    .select("*")
    .eq("id", ticketId)
    .eq("user_email", userEmail)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) return null;

  const messages = await messagesForTicket(ticketId);
  const latestAdmin = [...messages]
    .reverse()
    .find((message) => message.sender_type === "admin");
  if (latestAdmin) {
    const { error: readError } = await getSupabase()
      .from("support_tickets")
      .update({ user_last_read_at: latestAdmin.created_at })
      .eq("id", ticketId)
      .eq("user_email", userEmail);
    if (readError) throw readError;
  }
  return { ticket: ticket as SupportTicket, messages };
}

export async function countUnreadSupportReplies(userEmail: string): Promise<number> {
  const tickets = await listUserSupportTickets(userEmail);
  return tickets.filter((ticket) => ticket.has_unread_reply).length;
}

export async function createSupportTicket(params: {
  userEmail: string;
  category: SupportCategory;
  subject: string;
  body: string;
  clientRequestId: string;
  files: File[];
}) {
  const subject = normalizeSupportText(params.subject, MAX_SUPPORT_SUBJECT_LENGTH);
  const body = normalizeSupportText(params.body, MAX_SUPPORT_MESSAGE_LENGTH);
  const decisionRequired = requiresOwnerDecision(params.category, subject, body);
  const uploaded = await uploadAttachments(
    params.userEmail,
    params.clientRequestId,
    params.files
  );

  const { data, error } = await getSupabase().rpc(
    "create_support_ticket_with_message",
    {
      p_user_email: params.userEmail,
      p_category: params.category,
      p_subject: subject,
      p_body: body,
      p_client_request_id: params.clientRequestId,
      p_decision_required: decisionRequired,
      p_attachments: uploaded.attachments,
    }
  );
  if (error) {
    await removeUnreferencedUploads(uploaded.newlyUploaded);
    throw error;
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.created) {
    await removeNewUploads(uploaded.newlyUploaded);
  }
  if (result?.created && !isTestAddress(params.userEmail)) {
    const notification = await sendSupportEmail({
      to: SUPPORT_NOTIFICATION_EMAIL,
      subject: `【豊かさAI サポート】${subject}`,
      text:
        `豊かさAIの問い合わせフォームから連絡が届きました。\n\n` +
        `利用者: ${params.userEmail}\n` +
        `分類: ${params.category}\n` +
        `件名: ${subject}\n\n` +
        `${body}\n\n` +
        `管理画面: ${SUPPORT_APP_URL}/admin/support`,
    });
    await recordNotificationResult(result.ticket_id, "admin", notification);
  }
  return result as { ticket_id: string; message_id: string; created: boolean };
}

export async function appendUserSupportMessage(params: {
  userEmail: string;
  ticketId: string;
  body: string;
  clientRequestId: string;
  files: File[];
}) {
  const body = normalizeSupportText(params.body, MAX_SUPPORT_MESSAGE_LENGTH);
  const uploaded = await uploadAttachments(
    params.userEmail,
    params.clientRequestId,
    params.files
  );
  const decisionRequired = requiresOwnerDecision("other", "", body);
  const { data, error } = await getSupabase().rpc("append_support_user_message", {
    p_user_email: params.userEmail,
    p_ticket_id: params.ticketId,
    p_body: body,
    p_client_request_id: params.clientRequestId,
    p_decision_required: decisionRequired,
    p_attachments: uploaded.attachments,
  });
  if (error) {
    await removeUnreferencedUploads(uploaded.newlyUploaded);
    throw error;
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.created) {
    await removeNewUploads(uploaded.newlyUploaded);
  }
  if (result?.created && !isTestAddress(params.userEmail)) {
    const { data: ticket } = await getSupabase()
      .from("support_tickets")
      .select("subject")
      .eq("id", params.ticketId)
      .maybeSingle();
    const notification = await sendSupportEmail({
      to: SUPPORT_NOTIFICATION_EMAIL,
      subject: `【豊かさAI サポート追記】${ticket?.subject ?? "問い合わせ"}`,
      text:
        `利用者から追加メッセージが届きました。\n\n` +
        `利用者: ${params.userEmail}\n\n${body}\n\n` +
        `管理画面: ${SUPPORT_APP_URL}/admin/support`,
    });
    await recordNotificationResult(params.ticketId, "admin", notification);
  }
  return result as { message_id: string; created: boolean };
}

export async function listAdminSupportTickets(params: {
  status?: SupportStatus | "";
  query?: string;
}) {
  let request = getSupabase()
    .from("support_tickets")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(250);
  if (params.status) request = request.eq("status", params.status);
  const { data, error } = await request;
  if (error) throw error;

  const tickets = (data ?? []) as SupportTicket[];
  if (tickets.length === 0) return [];
  const { data: messages, error: messageError } = await getSupabase()
    .from("support_messages")
    .select("ticket_id,sender_type,body,created_at")
    .in(
      "ticket_id",
      tickets.map((ticket) => ticket.id)
    )
    .order("created_at", { ascending: false });
  if (messageError) throw messageError;

  const query = params.query?.trim().toLocaleLowerCase("ja-JP") ?? "";
  return tickets
    .map((ticket) => {
      const ticketMessages = (messages ?? []).filter(
        (message) => message.ticket_id === ticket.id
      ) as Array<Pick<SupportMessage, "body" | "created_at" | "sender_type">>;
      const latest = latestMessage(ticketMessages);
      const hasUnreadMessage = ticketMessages.some(
        (message) =>
          message.sender_type === "user" &&
          (!ticket.admin_last_read_at || message.created_at > ticket.admin_last_read_at)
      );
      return {
        ...ticket,
        last_message: latest?.body ?? "",
        last_message_at: latest?.created_at ?? ticket.updated_at,
        has_unread_message: hasUnreadMessage,
      };
    })
    .filter((ticket) => {
      if (!query) return true;
      return `${ticket.user_email}\n${ticket.subject}\n${ticket.last_message}`
        .toLocaleLowerCase("ja-JP")
        .includes(query);
    });
}

export async function getAdminSupportTicket(
  ticketId: string,
  options: { markRead?: boolean } = {}
) {
  const { data: ticket, error } = await getSupabase()
    .from("support_tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) return null;

  const [{ data: logs, error: logError }, messages] = await Promise.all([
    getSupabase()
      .from("support_work_logs")
      .select("id,event_type,summary,metadata,created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true }),
    messagesForTicket(ticketId),
  ]);
  if (logError) throw logError;

  const latestUser = [...messages].reverse().find(
    (message) => message.sender_type === "user"
  );
  if (latestUser && options.markRead !== false) {
    const { error: readError } = await getSupabase()
      .from("support_tickets")
      .update({ admin_last_read_at: latestUser.created_at })
      .eq("id", ticketId);
    if (readError) throw readError;
  }

  return { ticket: ticket as SupportTicket, messages, work_logs: logs ?? [] };
}

export async function appendAdminSupportMessage(params: {
  ticketId: string;
  body: string;
  clientRequestId?: string;
  resolve?: boolean;
}) {
  const body = normalizeSupportText(params.body, MAX_SUPPORT_MESSAGE_LENGTH);
  const clientRequestId = params.clientRequestId || randomUUID();
  const { data, error } = await getSupabase().rpc("append_support_admin_message", {
    p_ticket_id: params.ticketId,
    p_body: body,
    p_client_request_id: clientRequestId,
    p_resolve: Boolean(params.resolve),
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;

  if (result?.created) {
    const { data: ticket, error: ticketError } = await getSupabase()
      .from("support_tickets")
      .select("user_email,subject")
      .eq("id", params.ticketId)
      .single();
    if (ticketError) throw ticketError;
    const notification = await sendSupportEmail({
      to: ticket.user_email,
      subject: `【豊かさAI】「${ticket.subject}」へ返信しました`,
      text:
        `豊かさAIのサポート画面へ返信しました。\n\n` +
        `こちらから内容をご確認ください。\n${SUPPORT_APP_URL}/support\n\n` +
        `このメールへ返信しても、問い合わせ履歴には追加されません。追加のご連絡は豊かさAI内の問い合わせ画面からお送りください。`,
    });
    await recordNotificationResult(params.ticketId, "user", notification);
  }
  return result as { message_id: string; created: boolean };
}

export async function updateAdminSupportTicket(params: {
  ticketId: string;
  status?: SupportStatus;
  automationStatus?: SupportAutomationStatus;
  decisionRequired?: boolean;
}) {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.status) {
    update.status = params.status;
    if (!params.automationStatus && params.status === "resolved") {
      update.automation_status = "completed";
      update.automation_locked_at = null;
      update.automation_lock_token = null;
    }
    if (!params.automationStatus && params.status === "open") {
      update.automation_status = "queued";
      update.automation_locked_at = null;
      update.automation_lock_token = null;
    }
  }
  if (params.automationStatus) update.automation_status = params.automationStatus;
  if (typeof params.decisionRequired === "boolean") {
    update.decision_required = params.decisionRequired;
    update.automation_status = params.decisionRequired
      ? "blocked_decision"
      : params.automationStatus ?? "queued";
  }
  if (
    params.decisionRequired === true ||
    (params.automationStatus && params.automationStatus !== "investigating")
  ) {
    update.automation_locked_at = null;
    update.automation_lock_token = null;
  }
  const { data, error } = await getSupabase()
    .from("support_tickets")
    .update(update)
    .eq("id", params.ticketId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data as SupportTicket | null;
}

export async function addSupportWorkLog(params: {
  ticketId: string;
  eventType: string;
  summary: string;
  metadata?: Record<string, unknown>;
}) {
  await writeWorkLog(
    params.ticketId,
    params.eventType,
    params.summary,
    params.metadata
  );
}

export async function listPendingAutomatedSupportTickets(limit = 10) {
  await recoverStaleSupportAutomationTickets();
  const { data, error } = await getSupabase()
    .from("support_tickets")
    .select("*")
    .eq("decision_required", false)
    .in("automation_status", ["queued", "failed"])
    .in("status", ["open", "in_progress"])
    .order("updated_at", { ascending: true })
    .limit(Math.min(Math.max(Math.floor(limit), 1), 25));
  if (error) throw error;

  const details = await Promise.all(
    ((data ?? []) as SupportTicket[]).map((ticket) =>
      getAdminSupportTicket(ticket.id, { markRead: false })
    )
  );
  return details.filter(Boolean);
}

export async function recoverStaleSupportAutomationTickets(): Promise<string[]> {
  const now = new Date();
  const staleBefore = new Date(
    now.getTime() - SUPPORT_AUTOMATION_LOCK_TIMEOUT_MS
  ).toISOString();
  const { data, error } = await getSupabase()
    .from("support_tickets")
    .update({
      automation_status: "failed",
      automation_locked_at: null,
      automation_lock_token: null,
      updated_at: now.toISOString(),
    })
    .eq("decision_required", false)
    .eq("automation_status", "investigating")
    .in("status", ["open", "in_progress"])
    .or(`automation_locked_at.is.null,automation_locked_at.lt.${staleBefore}`)
    .select("id");
  if (error) throw error;

  const ticketIds = (data ?? []).map((ticket) => ticket.id as string);
  if (ticketIds.length > 0) {
    const { error: logError } = await getSupabase()
      .from("support_work_logs")
      .insert(
        ticketIds.map((ticketId) => ({
          ticket_id: ticketId,
          event_type: "automation_lock_recovered",
          summary:
            "前回の自動対応が完了前に中断したため、再調査できる状態へ戻しました。",
          metadata: {},
        }))
      );
    if (logError) throw logError;
  }
  return ticketIds;
}

export async function claimSupportTicket(ticketId: string, lockToken: string) {
  const { data, error } = await getSupabase()
    .from("support_tickets")
    .update({
      automation_status: "investigating",
      automation_locked_at: new Date().toISOString(),
      automation_lock_token: lockToken,
      status: "in_progress",
      updated_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .eq("decision_required", false)
    .in("automation_status", ["queued", "failed"])
    .in("status", ["open", "in_progress"])
    .is("automation_locked_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data as SupportTicket | null;
}

export async function renewSupportAutomationLock(
  ticketId: string,
  lockToken: string
): Promise<SupportTicket | null> {
  const { data, error } = await getSupabase()
    .from("support_tickets")
    .update({
      automation_locked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .eq("automation_lock_token", lockToken)
    .eq("automation_status", "investigating")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data as SupportTicket | null;
}
