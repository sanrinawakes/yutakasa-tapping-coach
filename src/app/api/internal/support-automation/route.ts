import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  addSupportWorkLog,
  appendAdminSupportMessage,
  claimSupportTicket,
  listPendingAutomatedSupportTickets,
  updateAdminSupportTicket,
  validateSupportAutomationLock,
} from "@/lib/server/support-service";
import { supportApiError, SupportRequestError } from "@/lib/server/support-request";
import {
  MAX_SUPPORT_MESSAGE_LENGTH,
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

async function requireLock(ticketId: string, lockToken: string) {
  const ticket = await validateSupportAutomationLock(ticketId, lockToken);
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
      await addSupportWorkLog({
        ticketId,
        eventType: "automation_claimed",
        summary: "Codexが技術調査を開始しました。",
      });
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

    if (action === "reply") {
      const body = normalizeSupportText(record.body, MAX_SUPPORT_MESSAGE_LENGTH + 1);
      if (!body || body.length > MAX_SUPPORT_MESSAGE_LENGTH) {
        throw new SupportRequestError("Reply body is invalid");
      }
      const clientRequestId = readLockToken(record.clientRequestId);
      const resolve = record.resolve === true;
      const result = await appendAdminSupportMessage({
        ticketId,
        body,
        clientRequestId,
        resolve,
      });
      await updateAdminSupportTicket({
        ticketId,
        automationStatus: "completed",
      });
      await addSupportWorkLog({
        ticketId,
        eventType: resolve ? "automation_resolved" : "automation_replied",
        summary: resolve
          ? "技術対応と利用者への回答を完了しました。"
          : "利用者へ回答し、追加連絡を待っています。",
        metadata: { message_id: result.message_id, duplicate: !result.created },
      });
      return NextResponse.json(result, { status: result.created ? 201 : 200 });
    }

    if (action === "decision_required") {
      const summary = normalizeSupportText(record.summary, 5001);
      if (!summary || summary.length > 5000) {
        throw new SupportRequestError("Decision summary is invalid");
      }
      const ticket = await updateAdminSupportTicket({
        ticketId,
        decisionRequired: true,
      });
      await addSupportWorkLog({
        ticketId,
        eventType: "owner_decision_required",
        summary,
      });
      return NextResponse.json({ ticket });
    }

    if (action === "failed") {
      const summary = normalizeSupportText(record.summary, 5001);
      if (!summary || summary.length > 5000) {
        throw new SupportRequestError("Failure summary is invalid");
      }
      const ticket = await updateAdminSupportTicket({
        ticketId,
        automationStatus: "failed",
      });
      await addSupportWorkLog({
        ticketId,
        eventType: "automation_failed",
        summary,
      });
      return NextResponse.json({ ticket });
    }

    throw new SupportRequestError("Unknown automation action");
  } catch (error) {
    return supportApiError(error, "自動対応処理を更新できませんでした。");
  }
}
