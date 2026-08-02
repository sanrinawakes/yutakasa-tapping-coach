import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import {
  appendUserSupportMessage,
  getUserSupportTicket,
} from "@/lib/server/support-service";
import {
  parseSupportMessageRequest,
  supportApiError,
} from "@/lib/server/support-request";
import { parseClientRequestId } from "@/lib/support";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    if (!parseClientRequestId(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const detail = await getUserSupportTicket(session.email, id);
    if (!detail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return supportApiError(error, "お問い合わせを読み込めませんでした。");
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    if (!parseClientRequestId(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const payload = await parseSupportMessageRequest(request);
    const result = await appendUserSupportMessage({
      userEmail: session.email,
      ticketId: id,
      ...payload,
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return supportApiError(error, "メッセージを送信できませんでした。");
  }
}
