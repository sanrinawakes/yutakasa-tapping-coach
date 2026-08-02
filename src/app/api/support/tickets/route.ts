import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import {
  createSupportTicket,
  listUserSupportTickets,
} from "@/lib/server/support-service";
import {
  parseNewSupportTicketRequest,
  supportApiError,
} from "@/lib/server/support-request";

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const tickets = await listUserSupportTickets(session.email);
    return NextResponse.json({ tickets });
  } catch (error) {
    return supportApiError(error, "お問い合わせ履歴を読み込めませんでした。");
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const payload = await parseNewSupportTicketRequest(request);
    const result = await createSupportTicket({
      userEmail: session.email,
      ...payload,
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return supportApiError(error, "お問い合わせを送信できませんでした。");
  }
}
