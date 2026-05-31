import { NextRequest, NextResponse } from "next/server";
import { upsertSubscriber, recordFirstPaymentIfMissing } from "@/lib/supabase";

/**
 * 単発購入シナリオ（豊かさタッピング / BL / BL再受講 / Stripe一括 / 銀行振込）からの
 * webhook受信。受領状態を判定して、受領済みのみsubscribers追加。
 *
 * 重要: 銀行振込フローでは初回登録時は「未受領」で webhook が来るので、
 *      その時点では subscribers に追加しない。スタッフが「受領済み」マークした
 *      時の再POSTで初めて追加する。
 *
 * MyASP側の設定（両方必要）:
 *  - 「登録完了時の外部フォームPOST設定」
 *    URL = https://yutakasa-tapping-coach.vercel.app/api/webhook/myasp?token=<MYASP_WEBHOOK_SECRET>
 *    データ = data[User][mail]=%email%&data[User][name1]=%name1%&Type=register&data[User][receiptstate]=%receiptstate%&data[Scenario][id]=%item_id%
 *  - 「登録編集時に再POSTしたいデータ」（受領済みマーク時に発火させるため）
 *    URL = 同上
 *    データ = data[User][mail]=%email%&data[User][name1]=%name1%&Type=update&data[User][receiptstate]=%receiptstate%&data[Scenario][id]=%item_id%
 *    「編集（更新）のあった時に再POSTする」にチェック
 */

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

    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const formData = await request.formData();
      email = formData.get("data[User][mail]") as string;
      name = formData.get("data[User][name1]") as string;
      type = formData.get("Type") as string;
      scenarioId =
        (formData.get("data[Scenario][id]") as string) ||
        (formData.get("scenario_id") as string) ||
        null;
      receiptState =
        (formData.get("data[User][receiptstate]") as string) ||
        (formData.get("receiptstate") as string) ||
        null;
    } else {
      const body = await request.json();
      email = body?.data?.User?.mail || body?.email;
      name = body?.data?.User?.name1 || body?.name;
      type = body?.Type || body?.type;
      scenarioId = body?.data?.Scenario?.id || body?.scenario_id || null;
      receiptState =
        body?.data?.User?.receiptstate ||
        body?.receiptstate ||
        null;
    }

    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();
    const typeClass = classifyType(type);
    const receiptClass = classifyReceipt(receiptState);

    // 解約通知: cancelled に更新
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

    // 未払い: subscribers には追加しない（ログイン不可状態を維持）
    // 銀行振込の初回フォーム提出時にここに来る
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

    // 受領済み or 状態不明（古いシナリオ等の後方互換）: subscribers に upsert
    // 「状態不明」を受領済み扱いする理由:
    //  - 旧シナリオで receiptstate を payload に含めていない設定がある
    //  - 後方互換のため、状態情報なし=従来通り active で登録
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

    // first_payment_date を「未設定なら今」に
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
