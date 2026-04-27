import { createClient, SupabaseClient } from "@supabase/supabase-js";

let supabaseInstance: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (supabaseInstance) return supabaseInstance;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Missing Supabase credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"
    );
  }

  supabaseInstance = createClient(supabaseUrl, supabaseServiceRoleKey);
  return supabaseInstance;
}

// Database types
export interface Subscriber {
  id: string;
  email: string;
  name?: string;
  status: "active" | "cancelled";
  myasp_data?: Record<string, unknown>;
  // 365日ライセンス & 月額サブスク制御
  first_payment_date?: string | null;
  subscription_status: "active" | "cancelled" | "none";
  subscription_started_at?: string | null;
  subscription_last_event_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface OTPCode {
  id: string;
  email: string;
  code: string;
  expires_at: string;
  used: boolean;
  created_at: string;
}

export interface ChatThread {
  id: string;
  user_email: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

// Subscriber functions
export async function getSubscriberByEmail(email: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("subscribers")
    .select("*")
    .eq("email", email)
    .single();

  if (error && error.code !== "PGRST116") {
    throw error;
  }

  return data as Subscriber | null;
}

export async function upsertSubscriber(
  email: string,
  data: Partial<Subscriber>
) {
  const supabase = getSupabase();
  const { data: result, error } = await supabase
    .from("subscribers")
    .upsert(
      {
        email,
        ...data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" }
    )
    .select()
    .single();

  if (error) throw error;
  return result as Subscriber;
}

// OTP functions
export async function createOTPCode(email: string) {
  const supabase = getSupabase();
  const code = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const { data, error } = await supabase
    .from("otp_codes")
    .insert({
      email,
      code,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return { code, expiresAt } as { code: string; expiresAt: Date };
}

export async function verifyOTPCode(email: string, code: string) {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("otp_codes")
    .select("*")
    .eq("email", email)
    .eq("code", code)
    .gt("expires_at", now)
    .eq("used", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== "PGRST116") {
    throw error;
  }

  if (!data) {
    return null;
  }

  // Mark as used
  await supabase.from("otp_codes").update({ used: true }).eq("id", data.id);

  return data as OTPCode;
}

// Chat thread functions
export async function createChatThread(userEmail: string, title?: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("chat_threads")
    .insert({
      user_email: userEmail,
      title: title || "新しいチャット",
    })
    .select()
    .single();

  if (error) throw error;
  return data as ChatThread;
}

export async function getChatThread(threadId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("id", threadId)
    .single();

  if (error && error.code !== "PGRST116") {
    throw error;
  }

  return data as ChatThread | null;
}

export async function getUserChatThreads(userEmail: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("user_email", userEmail)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return (data || []) as ChatThread[];
}

export async function updateChatThreadTitle(threadId: string, title: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("chat_threads")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", threadId)
    .select()
    .single();

  if (error) throw error;
  return data as ChatThread;
}

export async function deleteChatThread(threadId: string) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("chat_threads")
    .delete()
    .eq("id", threadId);

  if (error) throw error;
}

// Chat message functions
export async function addChatMessage(
  threadId: string,
  role: "user" | "assistant",
  content: string
) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      thread_id: threadId,
      role,
      content,
    })
    .select()
    .single();

  if (error) throw error;

  // Update thread's updated_at
  await supabase
    .from("chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId);

  return data as ChatMessage;
}

export async function getDailyUserMessageCount(userEmail: string): Promise<number> {
  const supabase = getSupabase();

  // 日本時間（JST = UTC+9）で当日の開始時刻をUTCに変換
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const jstTodayStart = new Date(jstNow.getFullYear(), jstNow.getMonth(), jstNow.getDate());
  const todayStartUTC = new Date(jstTodayStart.getTime() - jstOffset);

  // ユーザーのスレッドIDを取得
  const { data: threads } = await supabase
    .from("chat_threads")
    .select("id")
    .eq("user_email", userEmail);

  if (!threads || threads.length === 0) return 0;

  const threadIds = threads.map((t) => t.id);

  // 当日のユーザーメッセージ数をカウント
  const { count, error } = await supabase
    .from("chat_messages")
    .select("*", { count: "exact", head: true })
    .in("thread_id", threadIds)
    .eq("role", "user")
    .gte("created_at", todayStartUTC.toISOString());

  if (error) throw error;
  return count || 0;
}

export async function getChatMessages(threadId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data || []) as ChatMessage[];
}

/**
 * 単発購入webhook受信時に「初回決済日」を記録する。
 * 既に first_payment_date が入っている場合は更新しない（仕様：初回決済日固定）。
 */
export async function recordFirstPaymentIfMissing(
  email: string,
  paidAt: Date
): Promise<{ updated: boolean; first_payment_date: string }> {
  const supabase = getSupabase();
  const isoPaidAt = paidAt.toISOString();

  // 現状確認
  const { data: existing } = await supabase
    .from("subscribers")
    .select("first_payment_date")
    .eq("email", email)
    .single();

  if (existing?.first_payment_date) {
    // 既に決済日が入ってる → そのまま
    return { updated: false, first_payment_date: existing.first_payment_date };
  }

  // 既存レコードに first_payment_date が無い、もしくはレコード自体が無いケース
  const { data: result, error } = await supabase
    .from("subscribers")
    .upsert(
      {
        email,
        first_payment_date: isoPaidAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" }
    )
    .select()
    .single();

  if (error) throw error;
  return { updated: true, first_payment_date: (result as Subscriber).first_payment_date || isoPaidAt };
}

/**
 * 月額サブスクの状態を更新する（webhook受信時用）
 */
export async function setSubscriptionState(
  email: string,
  state: {
    status: "active" | "cancelled";
    eventAt: Date;
    setStartedAtIfMissing?: boolean;
    name?: string;
  }
) {
  const supabase = getSupabase();

  // 既存レコード取得（subscription_started_atの判定用）
  const { data: existing } = await supabase
    .from("subscribers")
    .select("subscription_started_at, first_payment_date")
    .eq("email", email)
    .single();

  const updateRow: Record<string, unknown> = {
    email,
    subscription_status: state.status,
    subscription_last_event_at: state.eventAt.toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (state.name) {
    updateRow.name = state.name;
  }

  // サブスク開始日が未設定の場合のみセット
  if (state.status === "active" && state.setStartedAtIfMissing && !existing?.subscription_started_at) {
    updateRow.subscription_started_at = state.eventAt.toISOString();
  }

  // first_payment_dateが空のサブスク新規加入者（過去購入なくいきなりサブスクから入る人）には
  // first_payment_date 自体は設定しない。365日ライセンスは単発購入だけのもの。
  // サブスクの加入者はそもそも subscription_status='active' で許可されるので問題ない。

  const { data: result, error } = await supabase
    .from("subscribers")
    .upsert(updateRow, { onConflict: "email" })
    .select()
    .single();

  if (error) throw error;
  return result as Subscriber;
}

