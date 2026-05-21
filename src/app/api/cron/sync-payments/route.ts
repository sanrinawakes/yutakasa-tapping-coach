import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import {
  upsertSubscriber,
  getSubscriberByEmail,
} from "@/lib/supabase";
import { listRecentPayPalPayments } from "@/lib/paypal-fallback";

/**
 * 毎日Vercel Cronで実行: Stripe + PayPal の全成功決済を subscribers に同期。
 *
 * 動作:
 *  - Stripe: 過去48時間に completed になった Checkout Session 全件
 *  - PayPal: 過去48時間の transaction_status=S（成功）の全取引
 *  - 各emailを subscribers にupsert（既存ユーザーは触らない）
 *
 * トリガー:
 *  - Vercel Cron: vercel.json で 0 0 * * * （UTC0時 = 日本時間9時）
 *  - 手動: curl -H "Authorization: Bearer $CRON_SECRET" https://yutakasa-tapping-coach.vercel.app/api/cron/sync-payments
 *
 * Required ENV:
 *  - STRIPE_SECRET_KEY
 *  - PAYPAL_CLIENT_ID
 *  - PAYPAL_CLIENT_SECRET
 *  - PAYPAL_MODE (live or sandbox; default live)
 *  - CRON_SECRET
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface InsertedUser {
  email: string;
  name: string | null;
  paidAt: string;
  source: "stripe" | "paypal";
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = {
    stripe: { sessionsScanned: 0, newInserts: [] as InsertedUser[], alreadyExists: 0 },
    paypal: { txScanned: 0, newInserts: [] as InsertedUser[], alreadyExists: 0 },
    errors: [] as string[],
    syncedAt: new Date().toISOString(),
  };

  // ============ Stripe ============
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      const stripe = new Stripe(stripeKey);
      const since = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);

      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const sessions = await stripe.checkout.sessions.list({
          created: { gte: since },
          status: "complete",
          limit: 100,
          starting_after: startingAfter,
        });

        result.stripe.sessionsScanned += sessions.data.length;

        for (const session of sessions.data) {
          const email = (
            session.customer_email ||
            session.customer_details?.email ||
            ""
          )
            .toLowerCase()
            .trim();

          if (!email || !email.includes("@")) continue;
          if (session.payment_status !== "paid") continue;

          try {
            const existing = await getSubscriberByEmail(email);
            if (existing) {
              result.stripe.alreadyExists++;
              continue;
            }

            const name =
              session.customer_details?.name ||
              session.metadata?.name ||
              null;
            const paidAtDate = new Date((session.created || 0) * 1000)
              .toISOString()
              .split("T")[0];
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
                amount_jpy: (session.amount_total ?? 0) / 100,
                mode: session.mode,
                synced_at: new Date().toISOString(),
              },
            });

            result.stripe.newInserts.push({
              email,
              name,
              paidAt: paidAtDate,
              source: "stripe",
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.errors.push(`stripe:${email}: ${msg}`);
          }
        }

        hasMore = sessions.has_more;
        if (hasMore && sessions.data.length > 0) {
          startingAfter = sessions.data[sessions.data.length - 1].id;
        }
      }
    } else {
      result.errors.push("STRIPE_SECRET_KEY not configured, skipped");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`stripe fatal: ${msg}`);
  }

  // ============ PayPal ============
  try {
    const payments = await listRecentPayPalPayments(2);
    result.paypal.txScanned = payments.length;

    for (const p of payments) {
      if (!p.email || !p.email.includes("@")) continue;

      try {
        const existing = await getSubscriberByEmail(p.email);
        if (existing) {
          result.paypal.alreadyExists++;
          continue;
        }

        await upsertSubscriber(p.email, {
          name: p.name || undefined,
          status: "active",
          first_payment_date: p.paidAt || null,
          subscription_status: "none",
          myasp_data: {
            added_via: "cron_sync_from_paypal",
            paypal_transaction_id: p.transactionId,
            amount: p.amount,
            currency: p.currency,
            synced_at: new Date().toISOString(),
          },
        });

        result.paypal.newInserts.push({
          email: p.email,
          name: p.name,
          paidAt: p.paidAt,
          source: "paypal",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`paypal:${p.email}: ${msg}`);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`paypal fatal: ${msg}`);
  }

  const totalInserts =
    result.stripe.newInserts.length + result.paypal.newInserts.length;

  console.log(
    `[cron sync-payments] stripe=${result.stripe.sessionsScanned} paypal=${result.paypal.txScanned} newTotal=${totalInserts} errors=${result.errors.length}`
  );

  return NextResponse.json({
    ...result,
    summary: {
      totalNew: totalInserts,
      stripeNew: result.stripe.newInserts.length,
      paypalNew: result.paypal.newInserts.length,
    },
  });
}
