import Stripe from "stripe";
import { upsertSubscriber, Subscriber } from "./supabase";

export interface StripePaymentMatch {
  source: "stripe";
  email: string;
  name: string | null;
  paidAt: string;
  customerId: string;
  isSubscription: boolean;
}

/**
 * subscribersテーブルに居ない人がログインを試みた時の即時救済ロジック。
 *
 * 動作:
 *  - Stripeで該当emailのCustomerを検索
 *  - Customer の最新の successful Charge を取得（または Checkout Session）
 *  - 見つかれば subscribers に INSERT して、その Subscriber を返す
 *  - 見つからなければ null を返す（→ 通常通り404）
 *
 * 戻り値が non-null なら「Stripeで決済確認したので追加した」を意味する。
 */
export async function findStripePaymentForEmail(
  email: string
): Promise<StripePaymentMatch | null> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.warn("[findStripePaymentForEmail] STRIPE_SECRET_KEY not set; skipping");
    return null;
  }

  const normalized = email.toLowerCase().trim();
  const stripe = new Stripe(stripeKey);

  try {
    // 1. Customers API でemail検索
    const customers = await stripe.customers.list({
      email: normalized,
      limit: 5,
    });

    if (customers.data.length === 0) {
      return null;
    }

    // 2. 各customerの直近charges/subscriptionをチェック
    let bestCustomer: Stripe.Customer | null = null;
    let bestPaidAt = 0;
    let isSubscription = false;

    for (const customer of customers.data) {
      // Subscriptionあり = 月額継続
      const subs = await stripe.subscriptions.list({
        customer: customer.id,
        status: "active",
        limit: 1,
      });
      if (subs.data.length > 0) {
        bestCustomer = customer;
        bestPaidAt = subs.data[0].created;
        isSubscription = true;
        break;
      }

      // 単発購入の charges を確認
      const charges = await stripe.charges.list({
        customer: customer.id,
        limit: 5,
      });
      for (const ch of charges.data) {
        if (ch.status === "succeeded" && ch.created > bestPaidAt) {
          bestCustomer = customer;
          bestPaidAt = ch.created;
        }
      }
    }

    if (!bestCustomer || bestPaidAt === 0) {
      return null;
    }

    const paidAtDate = new Date(bestPaidAt * 1000).toISOString().split("T")[0];
    const name = bestCustomer.name || null;

    return {
      source: "stripe",
      email: normalized,
      name,
      paidAt: paidAtDate,
      customerId: bestCustomer.id,
      isSubscription,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[findStripePaymentForEmail] error for ${normalized}:`, msg);
    return null;
  }
}

export async function rescueFromStripe(
  email: string
): Promise<Subscriber | null> {
  const match = await findStripePaymentForEmail(email);
  if (!match) return null;

  const inserted = await upsertSubscriber(match.email, {
    name: match.name || undefined,
    status: "active",
    first_payment_date: match.paidAt,
    subscription_status: match.isSubscription ? "active" : "none",
    myasp_data: {
      added_via: "send_otp_stripe_rescue",
      stripe_customer: match.customerId,
      rescued_at: new Date().toISOString(),
    },
  });

  console.log(
    `[rescueFromStripe] rescued ${match.email} (stripe_customer=${match.customerId}, paidAt=${match.paidAt}, isSub=${match.isSubscription})`
  );

  return inserted;
}
