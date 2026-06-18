import { NextRequest, NextResponse } from "next/server";
import { upsertSubscriber, recordFirstPaymentIfMissing } from "@/lib/supabase";

const PAID_STATES = ["受領済み", "received", "paid"];
const UNPAID_STATES = ["未受領", "申込時（支払前）", "申込時(支払前)", "unpaid", "申込時"];
const CANCEL_INDICATORS = ["cancel", "退会", "解約", "解除", "中止"];

function classifyReceipt(state: string | null | undefined): "paid" | "unpaid" | "unknown" {
  if (!state) return "unknown";
  const s = state.trim();
  if (PAID_STATES.some((p) => s.includes(p))) return "paid";
  if (UNPAID_STATES.some((p) => s.includes(p))) return "unpaid";
  return "unknown";
}

function classifyType(type: string | null | undefined): "cancel" | "normal" {
  if (!type) return "normal";
  const t = type.toLowerCase();
  if (CANCEL_INDICATORS.some((c) => t.includes(c.toLowerCase()))) return "cancel";
  return "normal";
}

export async function POST(request: NextRequest) {
  try {
    const webhookSecret = process.env.MYASP_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("MYASP_WEBHOOK_SECRET is not set");
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }

    const token =
      request.headers.get("x-webhook-token") ||
      request.nextUrl.searchParams.get("token");

    if (token !== webhookSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contentType = request.headers.get("content-type") || "";
    let email: string | null = null;
    let name: string | null = null;
    let type: string | null = null;
    let scenarioId: string | null = null;
    let receiptState: string | null = null;

    // MyASPの外部フォームPOSTは Content-Type が form 系で届かない場合があるため、
    // Content-Type に依存せず本文を読み取る。JSON のときだけ JSON.parse し、
    // それ以外は URLSearchParams で form-urlencoded として解析する。
    const rawBody = await request.text();
    if (contentType.includes("application/json")) {
      const body = JSON.parse(rawBody);
      email = body?.data?.User?.mail || body?.email;
      name = body?.data?.User?.name1 || body?.name;
      type = body?.Type || body?.type;
      scenarioId = body?.data?.Scenario?.id || body?.scenario_id || null;
      receiptState = body?.data?.User?.receiptstate || body?.receiptstate || null;
    } else {
      const params = new URLSearchParams(rawBody);
      email = params.get("data[User][mail]") || params.get("email");
      name = params.get("data[User][name1]") || params.get("name");
      type = params.get("Type") || params.get("type");
      scenarioId = params.get("data[Scenario][id]") || params.get("scenario_id");
      receiptState =
        params.get("data[User][receiptstate]") || params.get("receiptstate");
    }

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const typeClass = classifyType(type);
    const receiptClass = classifyReceipt(receiptState);

    if (typeClass === "cancel") {
      await upsertSubscriber(normalizedEmail, {
        name: name || undefined,
        status: "cancelled",
        myasp_data: {
          type,
          scenario_id: scenarioId,
          receipt_state: receiptState,
          last_event: "cancel",
          webhookReceivedAt: new Date().toISOString(),
        },
      });
      console.log(
        `[myasp webhook] cancel: ${normalizedEmail} (scenario: ${scenarioId || "n/a"})`
      );
      return NextResponse.json({
        success: true,
        action: "cancelled",
        email: normalizedEmail,
      });
    }

    if (receiptClass === "unpaid") {
      console.log(
        `[myasp webhook] unpaid (skipped): ${normalizedEmail} (state: ${receiptState}, scenario: ${scenarioId || "n/a"})`
      );
      return NextResponse.json({
        success: true,
        action: "skipped_unpaid",
        email: normalizedEmail,
        receiptState,
      });
    }

    await upsertSubscriber(normalizedEmail, {
      name: name || undefined,
      status: "active",
      myasp_data: {
        type,
        scenario_id: scenarioId,
        receipt_state: receiptState,
        receipt_class: receiptClass,
        last_event: receiptClass === "paid" ? "paid" : "registered_legacy",
        webhookReceivedAt: new Date().toISOString(),
      },
    });

    try {
      await recordFirstPaymentIfMissing(normalizedEmail, new Date());
    } catch (e) {
      console.warn("recordFirstPaymentIfMissing failed:", e);
    }

    console.log(
      `[myasp webhook] paid: ${normalizedEmail} (state: ${receiptState || "n/a"}, scenario: ${scenarioId || "n/a"})`
    );

    return NextResponse.json({
      success: true,
      action: "added_active",
      email: normalizedEmail,
      receiptState,
    });
  } catch (error) {
    console.error("MyASP webhook error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
