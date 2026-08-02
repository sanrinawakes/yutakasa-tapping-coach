export const SUPPORT_CATEGORIES = [
  "technical",
  "login",
  "quality",
  "how_to",
  "feature",
  "billing",
  "other",
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportStatus =
  | "open"
  | "in_progress"
  | "waiting_user"
  | "resolved";
export type SupportAutomationStatus =
  | "queued"
  | "investigating"
  | "blocked_decision"
  | "completed"
  | "failed";

export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  technical: "技術的な不具合",
  login: "ログイン・利用権限",
  quality: "AIの回答品質",
  how_to: "使い方の質問",
  feature: "機能の要望",
  billing: "料金・契約・解約",
  other: "その他",
};

export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  open: "受付済み",
  in_progress: "対応中",
  waiting_user: "返信あり",
  resolved: "対応完了",
};

export const SUPPORT_AUTOMATION_LABELS: Record<SupportAutomationStatus, string> = {
  queued: "技術確認待ち",
  investigating: "技術確認中",
  blocked_decision: "判断待ち",
  completed: "技術対応完了",
  failed: "再確認が必要",
};

export const MAX_SUPPORT_SUBJECT_LENGTH = 120;
export const MAX_SUPPORT_MESSAGE_LENGTH = 10_000;
export const MAX_SUPPORT_ATTACHMENTS = 3;
export const MAX_SUPPORT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const OWNER_DECISION_PATTERN =
  /返金|払い戻し|請求|決済|料金|価格|値上げ|値下げ|課金|契約|解約|退会|キャンセル|補償|賠償|弁護士|訴訟|法的|個人情報.{0,8}(削除|開示)/u;

export function isSupportCategory(value: unknown): value is SupportCategory {
  return (
    typeof value === "string" &&
    (SUPPORT_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isSupportStatus(value: unknown): value is SupportStatus {
  return (
    typeof value === "string" &&
    ["open", "in_progress", "waiting_user", "resolved"].includes(value)
  );
}

export function isSupportAutomationStatus(
  value: unknown
): value is SupportAutomationStatus {
  return (
    typeof value === "string" &&
    [
      "queued",
      "investigating",
      "blocked_decision",
      "completed",
      "failed",
    ].includes(value)
  );
}

export function normalizeSupportText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/gu, "\n").trim().slice(0, maxLength).trim();
}

export function requiresOwnerDecision(
  category: SupportCategory,
  subject: string,
  body: string
): boolean {
  return category === "billing" || OWNER_DECISION_PATTERN.test(`${subject}\n${body}`);
}

export function parseClientRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    normalized
  )
    ? normalized
    : null;
}

export type DetectedSupportFile = {
  contentType: "image/png" | "image/jpeg" | "image/webp" | "image/heic" | "image/heif";
  extension: "png" | "jpg" | "webp" | "heic" | "heif";
};

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function detectSupportFileType(bytes: Uint8Array): DetectedSupportFile | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { contentType: "image/png", extension: "png" };
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }

  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { contentType: "image/webp", extension: "webp" };
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) {
      return { contentType: "image/heic", extension: "heic" };
    }
    if (["heif", "mif1", "msf1"].includes(brand)) {
      return { contentType: "image/heif", extension: "heif" };
    }
  }

  return null;
}

export function sanitizeSupportFilename(value: string, extension: string): string {
  const withoutExtension = value.replace(/\.[^.]+$/u, "");
  const cleaned = withoutExtension
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return `${cleaned || "attachment"}.${extension}`;
}
