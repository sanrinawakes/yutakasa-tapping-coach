import "server-only";

import { NextRequest, NextResponse } from "next/server";
import {
  isSupportCategory,
  MAX_SUPPORT_ATTACHMENT_BYTES,
  MAX_SUPPORT_ATTACHMENTS,
  MAX_SUPPORT_MESSAGE_LENGTH,
  MAX_SUPPORT_SUBJECT_LENGTH,
  normalizeSupportText,
  parseClientRequestId,
  type SupportCategory,
} from "@/lib/support";

export class SupportRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "SupportRequestError";
  }
}

type SupportRequestPayload = {
  category?: SupportCategory;
  subject?: string;
  body: string;
  clientRequestId: string;
  files: File[];
};

function validateFiles(values: FormDataEntryValue[]): File[] {
  const files = values.filter(
    (value): value is File => value instanceof File && value.size > 0
  );
  if (files.length > MAX_SUPPORT_ATTACHMENTS) {
    throw new SupportRequestError(
      `画像は${MAX_SUPPORT_ATTACHMENTS}枚まで添付できます。`
    );
  }
  if (files.some((file) => file.size > MAX_SUPPORT_ATTACHMENT_BYTES)) {
    throw new SupportRequestError("画像は1枚5MB以下にしてください。");
  }
  return files;
}

function validateBasePayload(
  bodyValue: unknown,
  clientRequestIdValue: unknown,
  files: File[]
): Pick<SupportRequestPayload, "body" | "clientRequestId" | "files"> {
  const body = normalizeSupportText(bodyValue, MAX_SUPPORT_MESSAGE_LENGTH + 1);
  if (!body) {
    throw new SupportRequestError("お問い合わせ内容を入力してください。");
  }
  if (body.length > MAX_SUPPORT_MESSAGE_LENGTH) {
    throw new SupportRequestError(
      `お問い合わせ内容は${MAX_SUPPORT_MESSAGE_LENGTH.toLocaleString("ja-JP")}文字以内で入力してください。`
    );
  }

  const clientRequestId = parseClientRequestId(clientRequestIdValue);
  if (!clientRequestId) {
    throw new SupportRequestError("送信情報が正しくありません。画面を更新してください。");
  }
  return { body, clientRequestId, files };
}

async function readRequestValues(request: NextRequest) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) throw new SupportRequestError("送信内容を読み取れませんでした。");
    return {
      category: form.get("category"),
      subject: form.get("subject"),
      body: form.get("body"),
      clientRequestId: form.get("clientRequestId"),
      files: validateFiles(form.getAll("attachments")),
    };
  }

  if (contentType.startsWith("application/json")) {
    const json = await request.json().catch(() => null);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new SupportRequestError("送信内容を読み取れませんでした。");
    }
    const record = json as Record<string, unknown>;
    return {
      category: record.category,
      subject: record.subject,
      body: record.body,
      clientRequestId: record.clientRequestId,
      files: [] as File[],
    };
  }

  throw new SupportRequestError("送信形式が正しくありません。", 415);
}

export async function parseNewSupportTicketRequest(
  request: NextRequest
): Promise<Required<SupportRequestPayload>> {
  const values = await readRequestValues(request);
  if (!isSupportCategory(values.category)) {
    throw new SupportRequestError("お問い合わせの種類を選択してください。");
  }

  const subject = normalizeSupportText(
    values.subject,
    MAX_SUPPORT_SUBJECT_LENGTH + 1
  );
  if (!subject) {
    throw new SupportRequestError("件名を入力してください。");
  }
  if (subject.length > MAX_SUPPORT_SUBJECT_LENGTH) {
    throw new SupportRequestError(
      `件名は${MAX_SUPPORT_SUBJECT_LENGTH}文字以内で入力してください。`
    );
  }

  return {
    category: values.category,
    subject,
    ...validateBasePayload(values.body, values.clientRequestId, values.files),
  };
}

export async function parseSupportMessageRequest(
  request: NextRequest
): Promise<Pick<SupportRequestPayload, "body" | "clientRequestId" | "files">> {
  const values = await readRequestValues(request);
  return validateBasePayload(values.body, values.clientRequestId, values.files);
}

export function supportApiError(
  error: unknown,
  fallback: string
): NextResponse {
  if (error instanceof SupportRequestError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
