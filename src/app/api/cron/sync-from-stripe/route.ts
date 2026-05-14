import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { upsertSubscriber, getSubscriberByEmail } from "@/lib/supabase";

/**
 * Stripeで決済された顧客を毎日subscribersに自動同期する保険ライン。
 *
 * 動作:
 *  - 過去48時間に completed になった Checkout Session を全件取得
 *  - 各セッションの customer_email を抽出
 *  - subscribers に居なければ INSERT（first_payment_date=決済日, status='active'）
 *  - 既存ユーザーは触らない
 *
 * トリガー:
 *  - Vercel Cron (vercel.json で 0 0 * * * = 毎日UTC0時 = 日本時間9時)
 *  - 手動: curl -H "Authorization: Bearer $CRON_SECRET" https://yutakasa-tapping-coach.vercel.app/api/cron/sync-from-stripe
 *
 * 必要なENV:
 *  - STRIPE_SECRET_KEY: Stripeアカウントのsecret key (sk_live_...)
 *  - CRON_SECRET: Vercel Cron認証用のランダムトークン (Vercel自動生成 or 手動)
 *
 * MyASP webhook が時々失敗するための独立した保険。webhookが正常に動けば
 * このcronで挿入される件数は0になる（既にsubscribersに居るため）。
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // Cron 認証 (Vercel Cron は Authorization: Bearer ${CRON_SECRET} を自動で付与)
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("CRON_SECRET not configured");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error("STRIPE_SECRET_KEY not configured");
    return NextResponse.json(
      { error: "STRIPE_SECRET_KEY not configured" },
      { status: 500 }
    );
  }

  const stripe = new Stripe(stripeKey);

  // 過去48時間（保険として広めに取る）
  const since = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);

  const result = {
    sessionsScanned: 0,
    emailsChecked: 0,
    newInserts: [] as { email: string; name: string | null; paidAt: string }[],
    alreadyExists: 0,
    errors: [] as string[],
    syncedAt: new Date().toISOString(),
  };

  try {
    // Checkout Sessions: 完了したもののみ
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const sessions = await stripe.checkout.sessions.list({
        created: { gte: since },
        status: "complete",
        limit: 100,
        starting_after: startingAfter,
      });

      result.sessionsScanned += sessions.data.length;

      for (const session of sessions.data) {
        const email = (
          session.customer_email ||
          session.customer_details?.email ||
          ""
        ).toLowerCase().trim();

        if (!email || !email.includes("@")) continue;
        if (session.payment_status !== "paid") continue;

        result.emailsChecked++;

        try {
          const existing = await getSubscriberByEmail(email);
          if (existing) {
            result.alreadyExists++;
            continue;
          }

          const name =
            session.customer_details?.name ||
            session.metadata?.name ||
            null;
          const paidAtDate = new Date((session.created || 0) * 1000)
            .toISOString()
            .split("T")[0];

          const amount = (session.amount_total ?? 0) / 100;
          const isSubscription = session.mode === "subscription";

          await upsertSubscriber(email, {
            name: name || undefined,
            status: "active",
            first_payment_date: paidAtDate,
            subscription_status: isSubscription ? "active" : "none",
            myasp_data: {
              added_via: "cron_sync_from_stripe",
              stripe_session_id: session.id,
              stripe_customer: session.customer,
              amount_jpy: amount,
              mode: session.mode,
              synced_at: new Date().toISOString(),
            },
          });

          result.newInserts.push({ email, name, paidAt: paidAtDate });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`${email}: ${msg}`);
        }
      }

      hasMore = sessions.has_more;
      if (hasMore && sessions.data.length > 0) {
        startingAfter = sessions.data[sessions.data.length - 1].id;
      }
    }

    console.log(
      `[cron sync-from-stripe] sessions=${result.sessionsScanned} checked=${result.emailsChecked} new=${result.newInserts.length} existing=${result.alreadyExists} errors=${result.errors.length}`
    );

    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[cron sync-from-stripe] fatal:", msg);
    return NextResponse.json(
      { error: msg, partial: result },
      { status: 500 }
    );
  }
}
