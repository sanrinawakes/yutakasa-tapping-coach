import Stripe from "stripe";
import { getSubscriberByEmail, upsertSubscriber } from "@/lib/supabase";
import {
  listRecentPayPalPayments,
  PayPalPaymentMatch,
} from "@/lib/paypal-fallback";

export const DEFAULT_PAYMENT_SYNC_LOOKBACK_DAYS = 14;

export interface SyncedUser {
  email: string;
  name: string | null;
  paidAt: string;
  source: "stripe" | "paypal";
}

interface StripeSyncResult {
  sessionsScanned: number;
  newInserts: SyncedUser[];
  wouldInsert: SyncedUser[];
  alreadyExists: number;
  skippedNoEmail: number;
  skippedUnpaid: number;
}

interface PayPalSyncResult {
  txScanned: number;
  newInserts: SyncedUser[];
  wouldInsert: SyncedUser[];
  alreadyExists: number;
  skippedNoEmail: number;
}

export interface PaymentSyncResult {
  stripe: StripeSyncResult;
  paypal: PayPalSyncResult;
  errors: string[];
  fatalErrors: string[];
  syncedAt: string;
  lookbackDays: number;
  dryRun: boolean;
  summary: {
    totalNew: number;
    totalWouldInsert: number;
    stripeNew: number;
    paypalNew: number;
    stripeWouldInsert: number;
    paypalWouldInsert: number;
    fatalErrorCount: number;
    errorCount: number;
  };
}

export interface PaymentSyncOptions {
  lookbackDays?: number;
  dryRun?: boolean;
}

function normalizeLookbackDays(input?: number): number {
  const envValue = process.env.PAYMENT_SYNC_LOOKBACK_DAYS;
  const raw = typeof input === "number" && Number.isFinite(input)
    ? input
    : envValue
      ? Number(envValue)
      : DEFAULT_PAYMENT_SYNC_LOOKBACK_DAYS;

  if (!Number.isFinite(raw)) return DEFAULT_PAYMENT_SYNC_LOOKBACK_DAYS;
  return Math.min(Math.max(Math.floor(raw), 1), 31);
}

function emptyResult(lookbackDays: number, dryRun: boolean): PaymentSyncResult {
  return {
    stripe: {
      sessionsScanned: 0,
      newInserts: [],
      wouldInsert: [],
      alreadyExists: 0,
      skippedNoEmail: 0,
      skippedUnpaid: 0,
    },
    paypal: {
      txScanned: 0,
      newInserts: [],
      wouldInsert: [],
      alreadyExists: 0,
      skippedNoEmail: 0,
    },
    errors: [],
    fatalErrors: [],
    syncedAt: new Date().toISOString(),
    lookbackDays,
    dryRun,
    summary: {
      totalNew: 0,
      totalWouldInsert: 0,
      stripeNew: 0,
      paypalNew: 0,
      stripeWouldInsert: 0,
      paypalWouldInsert: 0,
      fatalErrorCount: 0,
      errorCount: 0,
    },
  };
}

function finalizeResult(result: PaymentSyncResult): PaymentSyncResult {
  const stripeNew = result.stripe.newInserts.length;
  const paypalNew = result.paypal.newInserts.length;
  const stripeWouldInsert = result.stripe.wouldInsert.length;
  const paypalWouldInsert = result.paypal.wouldInsert.length;

  result.summary = {
    totalNew: stripeNew + paypalNew,
    totalWouldInsert: stripeWouldInsert + paypalWouldInsert,
    stripeNew,
    paypalNew,
    stripeWouldInsert,
    paypalWouldInsert,
    fatalErrorCount: result.fatalErrors.length,
    errorCount: result.errors.length,
  };

  return result;
}

export async function syncPayments(
  options: PaymentSyncOptions = {}
): Promise<PaymentSyncResult> {
  const lookbackDays = normalizeLookbackDays(options.lookbackDays);
  const dryRun = Boolean(options.dryRun);
  const result = emptyResult(lookbackDays, dryRun);

  // ============ Stripe ============
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      result.fatalErrors.push("STRIPE_SECRET_KEY not configured, skipped");
    } else {
      const stripe = new Stripe(stripeKey);
      const since = Math.floor(
        (Date.now() - lookbackDays * 24 * 60 * 60 * 1000) / 1000
      );

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

          if (!email || !email.includes("@")) {
            result.stripe.skippedNoEmail++;
            continue;
          }
          if (session.payment_status !== "paid") {
            result.stripe.skippedUnpaid++;
            continue;
          }

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
            const syncedUser: SyncedUser = {
              email,
              name,
              paidAt: paidAtDate,
              source: "stripe",
            };

            if (dryRun) {
              result.stripe.wouldInsert.push(syncedUser);
              continue;
            }

            await upsertSubscriber(email, {
              name: name || undefined,
              status: "active",
              first_payment_date: paidAtDate,
              subscription_status: isSubscription ? "active" : "none",
              myasp_data: {
                added_via: "cron_sync_from_stripe",
                stripe_session_id: session.id,
                stripe_customer:
                  typeof session.customer === "string"
                    ? session.customer
                    : session.customer?.id ?? null,
                amount_jpy: (session.amount_total ?? 0) / 100,
                mode: session.mode,
                synced_at: new Date().toISOString(),
              },
            });

            result.stripe.newInserts.push(syncedUser);
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
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.fatalErrors.push(`stripe fatal: ${msg}`);
  }

  // ============ PayPal ============
  try {
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
      result.fatalErrors.push("PAYPAL_CLIENT_ID/SECRET not configured, skipped");
    } else {
      const payments = await listRecentPayPalPayments(lookbackDays);
      result.paypal.txScanned = payments.length;

      for (const payment of payments) {
        if (!payment.email || !payment.email.includes("@")) {
          result.paypal.skippedNoEmail++;
          continue;
        }

        await syncPayPalPayment(payment, result, dryRun);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.fatalErrors.push(`paypal fatal: ${msg}`);
  }

  const finalized = finalizeResult(result);
  console.log(
    `[sync-payments] lookbackDays=${lookbackDays} dryRun=${dryRun} stripe=${finalized.stripe.sessionsScanned} paypal=${finalized.paypal.txScanned} newTotal=${finalized.summary.totalNew} wouldInsert=${finalized.summary.totalWouldInsert} errors=${finalized.errors.length} fatal=${finalized.fatalErrors.length}`
  );

  return finalized;
}

async function syncPayPalPayment(
  payment: PayPalPaymentMatch,
  result: PaymentSyncResult,
  dryRun: boolean
) {
  try {
    const existing = await getSubscriberByEmail(payment.email);
    if (existing) {
      result.paypal.alreadyExists++;
      return;
    }

    const syncedUser: SyncedUser = {
      email: payment.email,
      name: payment.name,
      paidAt: payment.paidAt,
      source: "paypal",
    };

    if (dryRun) {
      result.paypal.wouldInsert.push(syncedUser);
      return;
    }

    await upsertSubscriber(payment.email, {
      name: payment.name || undefined,
      status: "active",
      first_payment_date: payment.paidAt || null,
      subscription_status: "none",
      myasp_data: {
        added_via: "cron_sync_from_paypal",
        paypal_transaction_id: payment.transactionId,
        amount: payment.amount,
        currency: payment.currency,
        synced_at: new Date().toISOString(),
      },
    });

    result.paypal.newInserts.push(syncedUser);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`paypal:${payment.email}: ${msg}`);
  }
}
