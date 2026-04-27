import { NextRequest, NextResponse } from "next/server";
import { setSubscriptionState } from "@/lib/supabase";

/**
 * 月額9800円サブスクシナリオからのwebhook受信
 *
 * 動作：
 *  - Typeが「決済成功（決済 / 継続）」系 → subscription_status = 'active'
 *  - Typeが「解約 / 退会 / 決済失敗」系 → subscription_status = 'cancelled'
 *
 * MyASP側の設定：
 *   外部フォームPOST URL = https://yutakasa-tapping-coach.vercel.app/api/webhook/myasp/subscription?token=<MYASP_WEBHOOK_SECRET>
 *   このエンドポイントは「月額継続コーチング」シナリオ専用に設定すること
 */
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
    } else {
      const body = await request.json();
      email = body?.data?.User?.mail || body?.email;
      name = body?.data?.User?.name1 || body?.name;
      type = body?.Type || body?.type;
      scenarioId = body?.data?.Scenario?.id || body?.scenario_id || null;
    }

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Type判定（解約 / 失敗 / それ以外）
    const typeStr = (type || "").toLowerCase();
    const isCancellation =
      typeStr.includes("cancel") ||
      typeStr === "退会" ||
      typeStr === "解約" ||
      typeStr.includes("退会") ||
      typeStr.includes("解約") ||
      typeStr.includes("fail") ||
      typeStr.includes("失敗") ||
      typeStr.includes("不能") ||
      typeStr.includes("delinquent") ||
      typeStr.includes("decline");

    const newStatus: "active" | "cancelled" = isCancellation
      ? "cancelled"
      : "active";

    await setSubscriptionState(normalizedEmail, {
      status: newStatus,
      eventAt: new Date(),
      setStartedAtIfMissing: newStatus === "active",
      name: name || undefined,
    });

    console.log(
      `MyASP webhook (subscription): ${normalizedEmail} -> subscription_status=${newStatus} (scenario: ${scenarioId || "n/a"}, type: ${type || "n/a"})`
    );

    return NextResponse.json({
      success: true,
      email: normalizedEmail,
      subscription_status: newStatus,
    });
  } catch (error) {
    console.error("MyASP subscription webhook error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
