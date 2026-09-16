import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  addSupportWorkLog,
  claimSupportTicket,
  finishLockedSupportTicket,
  getAdminSupportTicket,
  listPendingAutomatedSupportTickets,
  renewSupportAutomationLock,
} from "@/lib/server/support-service";
import { supportApiError, SupportRequestError } from "@/lib/server/support-request";
import {
  normalizeSupportText,
  parseClientRequestId,
} from "@/lib/support";

export const runtime = "nodejs";

function tokensMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function automationAuthError(request: NextRequest): NextResponse | null {
  const token =
    request.headers.get("x-automation-token")?.trim() ||
    request.headers.get("x-cron-secret")?.trim() ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "").trim() ||
    "";
  const configured = [process.env.CRON_SECRET, process.env.JWT_SECRET].filter(
    (value): value is string => Boolean(value && value.length >= 32)
  );
  if (configured.length === 0) {
    return NextResponse.json(
      { error: "Automation auth is not configured" },
      { status: 500 }
    );
  }
  if (!token || !configured.some((secret) => tokensMatch(token, secret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function readTicketId(value: unknown): string {
  const ticketId = parseClientRequestId(value);
  if (!ticketId) throw new SupportRequestError("Invalid ticket ID");
  return ticketId;
}

function readLockToken(value: unknown): string {
  const lockToken = parseClientRequestId(value);
  if (!lockToken) throw new SupportRequestError("Invalid lock token");
  return lockToken;
}

function readTicketVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 ||
      !Number.isFinite(Date.parse(value))) {
    throw new SupportRequestError("Invalid ticket version");
  }
  return value;
}

async function requireLock(ticketId: string, lockToken: string) {
  const ticket = await renewSupportAutomationLock(ticketId, lockToken);
  if (!ticket) {
    throw new SupportRequestError(
      "This ticket is not locked by the current automation run.",
      409
    );
  }
  return ticket;
}

export async function GET(request: NextRequest) {
  const authError = automationAuthError(request);
  if (authError) return authError;

  try {
    const ticketIdParam = request.nextUrl.searchParams.get("ticketId");
    const lockTokenParam = request.headers.get("x-automation-lock-token");
    if (ticketIdParam !== null || lockTokenParam !== null) {
      const ticketId = readTicketId(ticketIdParam);
      const lockToken = readLockToken(lockTokenParam);
      await requireLock(ticketId, lockToken);
      const detail = await getAdminSupportTicket(ticketId, { markRead: false });
      if (!detail || detail.ticket.automation_lock_token !== lockToken ||
          detail.ticket.automation_status !== "investigating" ||
          detail.ticket.status !== "in_progress" || detail.ticket.decision_required) {
        throw new SupportRequestError("Ticket changed after claim", 409);
      }
      return NextResponse.json({
        ticket: {
          id: detail.ticket.id,
          category: detail.ticket.category,
          subject: detail.ticket.subject,
          status: detail.ticket.status,
          decision_required: detail.ticket.decision_required,
          automation_status: detail.ticket.automation_status,
          automation_lock_token: detail.ticket.automation_lock_token,
          updated_at: detail.ticket.updated_at,
        },
        messages: detail.messages.map(({ id, sender_type, body, created_at }) =>
          ({ id, sender_type, body, created_at })),
        work_logs: detail.work_logs.map(({ event_type, metadata }) =>
          ({ event_type, metadata })),
      });
    }
    const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? "10");
    const limit = Number.isFinite(rawLimit) ? rawLimit : 10;
    const tickets = await listPendingAutomatedSupportTickets(limit);
    return NextResponse.json({ tickets });
  } catch (error) {
    return supportApiError(error, "自動対応対象を取得できませんでした。");
  }
}

export async function PATCH(request: NextRequest) {
  const authError = automationAuthError(request);
  if (authError) return authError;

  try {
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new SupportRequestError("Invalid request body");
    }
    const record = input as Record<string, unknown>;
    const action = typeof record.action === "string" ? record.action : "";
    if (action === "reply") {
      throw new SupportRequestError("Automated customer replies are unavailable.", 501);
    }
    const ticketId = readTicketId(record.ticketId);

    if (action === "claim") {
      const lockToken = readLockToken(record.lockToken);
      const ticket = await claimSupportTicket(ticketId, lockToken);
      if (!ticket) {
        return NextResponse.json(
          { error: "Ticket already claimed or unavailable" },
          { status: 409 }
        );
      }
      return NextResponse.json({ ticket });
    }

    const lockToken = readLockToken(record.lockToken);
    await requireLock(ticketId, lockToken);

    if (action === "log") {
      const summary = normalizeSupportText(record.summary, 5001);
      if (!summary || summary.length > 5000) {
        throw new SupportRequestError("Log summary must be 1 to 5000 characters");
      }
      const metadata =
        record.metadata &&
        typeof record.metadata === "object" &&
        !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : {};
      await addSupportWorkLog({
        ticketId,
        eventType:
          typeof record.eventType === "string" && record.eventType.trim()
            ? record.eventType.trim().slice(0, 120)
            : "automation_progress",
        summary,
        metadata,
      });
      return NextResponse.json({ success: true });
    }

    if (action === "decision_required") {
      const summary = normalizeSupportText(record.summary, 5001);
      if (!summary || summary.length > 5000) {
        throw new SupportRequestError("Decision summary is invalid");
      }
      const ticket = await finishLockedSupportTicket({
        ticketId,
        lockToken,
        latestUserMessageId: readTicketId(record.latestUserMessageId),
        ticketVersion: readTicketVersion(record.ticketVersion),
        outcome: "decision_required",
        summary,
      });
      if (!ticket) throw new SupportRequestError("Ticket changed before decision", 409);
      return NextResponse.json({ ticket });
    }

    if (action === "failed") {
      const summary = normalizeSupportText(record.summary, 5001);
      if (!summary || summary.length > 5000) {
        throw new SupportRequestError("Failure summary is invalid");
      }
      const ticket = await finishLockedSupportTicket({
        ticketId,
        lockToken,
        latestUserMessageId: readTicketId(record.latestUserMessageId),
        ticketVersion: readTicketVersion(record.ticketVersion),
        outcome: "failed",
        summary,
      });
      if (!ticket) throw new SupportRequestError("Ticket changed before failure update", 409);
      return NextResponse.json({ ticket });
    }

    throw new SupportRequestError("Unknown automation action");
  } catch (error) {
    return supportApiError(error, "自動対応処理を更新できませんでした。");
  }
}
