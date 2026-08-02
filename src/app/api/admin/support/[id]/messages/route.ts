import { NextRequest, NextResponse } from "next/server";
import { getAdminAuthError } from "@/lib/admin-auth";
import { appendAdminSupportMessage } from "@/lib/server/support-service";
import { supportApiError, SupportRequestError } from "@/lib/server/support-request";
import {
  MAX_SUPPORT_MESSAGE_LENGTH,
  normalizeSupportText,
  parseClientRequestId,
} from "@/lib/support";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authError = getAdminAuthError(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    if (!parseClientRequestId(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new SupportRequestError("返信内容を読み取れませんでした。");
    }
    const record = input as Record<string, unknown>;
    const body = normalizeSupportText(record.body, MAX_SUPPORT_MESSAGE_LENGTH + 1);
    if (!body || body.length > MAX_SUPPORT_MESSAGE_LENGTH) {
      throw new SupportRequestError(
        `返信は1〜${MAX_SUPPORT_MESSAGE_LENGTH.toLocaleString("ja-JP")}文字で入力してください。`
      );
    }
    const requestId = parseClientRequestId(record.clientRequestId);
    if (!requestId) {
      throw new SupportRequestError("送信情報が正しくありません。");
    }
    if (record.resolve !== undefined && typeof record.resolve !== "boolean") {
      throw new SupportRequestError("完了状態が正しくありません。");
    }
    const result = await appendAdminSupportMessage({
      ticketId: id,
      body,
      clientRequestId: requestId,
      resolve: record.resolve === true,
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return supportApiError(error, "返信を送信できませんでした。");
  }
}
