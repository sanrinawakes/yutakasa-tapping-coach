import { NextRequest, NextResponse } from "next/server";
import { syncPayments } from "@/lib/payment-sync";

/**
 * 毎日Vercel Cronで実行: Stripe + PayPal の成功決済を subscribers に同期。
 *
 * トリガー:
 *  - Vercel Cron: vercel.json で 0 0 * * * （UTC0時 = 日本時間9時）
 *  - 手動: curl -H "Authorization: Bearer $CRON_SECRET" https://yutakasa-tapping-coach.vercel.app/api/cron/sync-payments
 *
 * 取りこぼし対策:
 *  - デフォルトで過去14日分を再走査する（PAYMENT_SYNC_LOOKBACK_DAYSで1〜31日に調整可）
 *  - 既存 subscribers はスキップするので、長めに見ても重複登録されない
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await syncPayments();
  return NextResponse.json(result, {
    status: result.fatalErrors.length > 0 ? 500 : 200,
  });
}
