import { NextRequest, NextResponse } from "next/server";
import { getAdminAuthError } from "@/lib/admin-auth";
import { evaluateAccess } from "@/lib/access-control";
import {
  getSubscriberByEmail,
  upsertSubscriber,
  Subscriber,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ManualRescueRequest {
  email?: string;
  name?: string;
  orderId?: string;
  scenarioId?: string;
  receiptDate?: string;
  note?: string;
  overrideCancelled?: boolean;
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function serializeSubscriber(subscriber: Subscriber | null) {
  if (!subscriber) return null;
  return {
    email: subscriber.email,
    name: subscriber.name ?? null,
    status: subscriber.status,
    subscriptionStatus: subscriber.subscription_status,
    firstPaymentDate: subscriber.first_payment_date ?? null,
    createdAt: subscriber.created_at,
    updatedAt: subscriber.updated_at,
    myaspData: subscriber.myasp_data ?? null,
  };
}

export async function POST(request: NextRequest) {
  const authError = getAdminAuthError(request);
  if (authError) return authError;

  const body = (await request.json().catch(() => ({}))) as ManualRescueRequest;
  const email = body.email?.toLowerCase().trim();
  const orderId = body.orderId?.trim();
  const receiptDate = body.receiptDate?.trim();

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }
  if (!receiptDate || !isDateOnly(receiptDate)) {
    return NextResponse.json(
      { error: "receiptDate must be YYYY-MM-DD" },
      { status: 400 }
    );
  }

  const existing = await getSubscriberByEmail(email);
  if (existing?.status === "cancelled" && body.overrideCancelled !== true) {
    return NextResponse.json(
      {
        error: "Subscriber is cancelled. Set overrideCancelled=true to reactivate.",
        subscriber: serializeSubscriber(existing),
      },
      { status: 409 }
    );
  }

  const subscriber = await upsertSubscriber(email, {
    name: body.name?.trim() || existing?.name || undefined,
    status: "active",
    first_payment_date: receiptDate,
    subscription_status: existing?.subscription_status || "none",
    myasp_data: {
      added_via: "admin_manual_rescue",
      source: "staff_confirmed_myasp_receipt",
      myasp_order_id: orderId,
      scenario_id: body.scenarioId?.trim() || null,
      receipt_date: receiptDate,
      note: body.note?.trim() || null,
      rescued_at: new Date().toISOString(),
    },
  });

  return NextResponse.json({
    success: true,
    subscriber: serializeSubscriber(subscriber),
    access: evaluateAccess(subscriber),
  });
}
