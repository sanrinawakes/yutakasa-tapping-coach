import { NextRequest, NextResponse } from "next/server";
import { getAdminAuthError } from "@/lib/admin-auth";
import {
  getAdminSupportTicket,
  updateAdminSupportTicket,
} from "@/lib/server/support-service";
import { supportApiError } from "@/lib/server/support-request";
import {
  isSupportAutomationStatus,
  isSupportStatus,
  parseClientRequestId,
} from "@/lib/support";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authError = getAdminAuthError(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    if (!parseClientRequestId(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const detail = await getAdminSupportTicket(id);
    if (!detail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return supportApiError(error, "お問い合わせを読み込めませんでした。");
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const authError = getAdminAuthError(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    if (!parseClientRequestId(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (input.status !== undefined && !isSupportStatus(input.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    if (
      input.automationStatus !== undefined &&
      !isSupportAutomationStatus(input.automationStatus)
    ) {
      return NextResponse.json(
        { error: "Invalid automation status" },
        { status: 400 }
      );
    }
    if (
      input.decisionRequired !== undefined &&
      typeof input.decisionRequired !== "boolean"
    ) {
      return NextResponse.json(
        { error: "Invalid decision flag" },
        { status: 400 }
      );
    }
    if (
      input.status === undefined &&
      input.automationStatus === undefined &&
      input.decisionRequired === undefined
    ) {
      return NextResponse.json({ error: "No changes supplied" }, { status: 400 });
    }

    const ticket = await updateAdminSupportTicket({
      ticketId: id,
      status: isSupportStatus(input.status) ? input.status : undefined,
      automationStatus: isSupportAutomationStatus(input.automationStatus)
        ? input.automationStatus
        : undefined,
      decisionRequired:
        typeof input.decisionRequired === "boolean"
          ? input.decisionRequired
          : undefined,
    });
    if (!ticket) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ticket });
  } catch (error) {
    return supportApiError(error, "お問い合わせを更新できませんでした。");
  }
}
