// 認可ロジック：365日ライセンス + 月額サブスク
// 仕様：
//  ①初回決済日から365日だけbot使える（= subscribers.first_payment_date 起点）
//  ②365日後は月額9800円サブスク継続者のみ使える（= subscription_status='active'）
//  ③過去購入者も初回決済日から365日（同じロジック）
//  ④過去購入者で365日経過済み + サブスク未加入 はアカウント作成不可（OTP送信を弾く）

import { Subscriber } from "./supabase";

export const LICENSE_DAYS = 365;

export type AccessReason =
  | "no_subscriber"               // subscribersテーブルに存在しない
  | "cancelled"                   // 単発購入側でキャンセル扱い
  | "license_expired_no_subscription" // 365日経過＆サブスク未加入
  | "first_payment_unknown";      // バックフィル前で起算日不明（=暫定処理）

export type AccessCheckResult =
  | { allowed: true }
  | { allowed: false; reason: AccessReason; firstPaymentDate?: string | null };

/**
 * 期限切れまでの日数を返す（負数は超過日数）
 */
export function daysUntilLicenseExpiry(firstPaymentDate: string | null | undefined): number | null {
  if (!firstPaymentDate) return null;
  const start = new Date(firstPaymentDate).getTime();
  if (isNaN(start)) return null;
  const elapsedMs = Date.now() - start;
  const elapsedDays = Math.floor(elapsedMs / 86400000);
  return LICENSE_DAYS - elapsedDays;
}

/**
 * ユーザーがbotを使用できるか判定する
 * 
 * 判定順：
 *  - subscribersに無し → no_subscriber（拒否）
 *  - status='cancelled' → cancelled（拒否）
 *  - subscription_status='active' → 許可（サブスク有効ならいつでも通す）
 *  - first_payment_date が365日以内 → 許可
 *  - first_payment_date が NULL → first_payment_unknown（拒否）★バックフィル前は要注意
 *  - それ以外（365日超過＆サブスク未加入） → license_expired_no_subscription（拒否）
 */
export function evaluateAccess(subscriber: Subscriber | null): AccessCheckResult {
  if (!subscriber) {
    return { allowed: false, reason: "no_subscriber" };
  }

  // 単発購入側でキャンセルされた人はサブスクが無い限り拒否
  if (subscriber.status === "cancelled" && subscriber.subscription_status !== "active") {
    return { allowed: false, reason: "cancelled" };
  }

  // サブスク有効 → 期限関係なく許可
  if (subscriber.subscription_status === "active") {
    return { allowed: true };
  }

  // 起算日が無い → バックフィル前。安全側で拒否（仕様④に合わせる）
  if (!subscriber.first_payment_date) {
    return { allowed: false, reason: "first_payment_unknown", firstPaymentDate: null };
  }

  // 365日チェック
  const remaining = daysUntilLicenseExpiry(subscriber.first_payment_date);
  if (remaining === null) {
    return { allowed: false, reason: "first_payment_unknown", firstPaymentDate: subscriber.first_payment_date };
  }
  if (remaining > 0) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: "license_expired_no_subscription",
    firstPaymentDate: subscriber.first_payment_date,
  };
}

/**
 * フロント表示用のエラーメッセージ
 */
export function accessReasonToMessage(reason: AccessReason): string {
  switch (reason) {
    case "no_subscriber":
      return "このメールアドレスは登録されていません。";
    case "cancelled":
      return "このアカウントは解約済みのため、ログインできません。";
    case "license_expired_no_subscription":
      return "ご購入から365日のご利用期限を超えました。月額サブスクへのご加入で引き続きご利用いただけます。";
    case "first_payment_unknown":
      return "決済日情報が確認できませんでした。お手数ですがサポートまでご連絡ください。";
  }
}
