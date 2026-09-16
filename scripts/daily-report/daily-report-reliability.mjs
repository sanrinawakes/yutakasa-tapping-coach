export const FIRST_REPORT_DATE_JST = "2026-09-16";

export const PROVIDER_EVENTS = Object.freeze(new Set([
  "bounced", "canceled", "clicked", "complained", "delivered",
  "delivery_delayed", "failed", "opened", "queued", "scheduled",
  "sent", "suppressed",
]));

export const PROVIDER_FAILURE_EVENTS = Object.freeze(new Set([
  "bounced", "canceled", "complained", "failed", "suppressed",
]));

const WORK_EVENT_LABELS = Object.freeze({
  automation_claimed: "自動調査を開始",
  automation_progress: "自動対応の進捗を記録",
  automation_replied: "利用者へ回答",
  automation_resolved: "利用者へ回答し解決",
  automation_failed: "自動対応に失敗",
  automation_lock_recovered: "中断した自動対応を再調査可能に変更",
  owner_decision_required: "運営判断が必要と記録",
  notification_failed: "通知メールの送信に失敗",
});

export function workEventLabel(eventType) {
  return Object.hasOwn(WORK_EVENT_LABELS, eventType)
    ? WORK_EVENT_LABELS[eventType]
    : "作業記録（種別未分類）";
}

export function nextJstDate(date) {
  const next = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000);
  return next.toISOString().slice(0, 10);
}

export function reportDatesToRun({ latestDate, cursorDate, retryDate }) {
  if (typeof latestDate !== "string" || typeof cursorDate !== "string") {
    throw new Error("report_cursor_invalid");
  }
  if (cursorDate < FIRST_REPORT_DATE_JST || cursorDate > nextJstDate(latestDate)) {
    throw new Error("report_cursor_invalid");
  }
  if (retryDate && (retryDate < FIRST_REPORT_DATE_JST || retryDate >= cursorDate)) {
    throw new Error("report_retry_date_invalid");
  }
  // The most recent day is always first. One older unstarted day and one
  // definitive failure are then recovered per hourly run, without an
  // unbounded burst after a long outage.
  return [...new Set([
    latestDate,
    ...(cursorDate < latestDate ? [cursorDate] : []),
    ...(retryDate ? [retryDate] : []),
  ])];
}
