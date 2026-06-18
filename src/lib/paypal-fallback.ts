import { upsertSubscriber, Subscriber } from "./supabase";

export interface PayPalPaymentMatch {
  source: "paypal";
  email: string;
  name: string | null;
  paidAt: string;
  transactionId: string;
  amount: number;
  currency: string;
}

/**
 * PayPal Reporting APIを使った subscribers 漏れの即時救済。
 *
 * 動作:
 *  - PayPal OAuth2 で access_token を取得
 *  - 過去90日のtransactions APIを照会し、emailで一致する成功完了取引を検索
 *  - 見つかれば subscribers に upsert して該当Subscriberを返す
 *
 * Required env:
 *  - PAYPAL_CLIENT_ID
 *  - PAYPAL_CLIENT_SECRET
 *  - PAYPAL_MODE: "live" (default) or "sandbox"
 */

const PAYPAL_API_BASE = (mode?: string) =>
  mode === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

interface PayPalAccessTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface PayPalTransaction {
  transaction_info?: {
    transaction_id?: string;
    transaction_initiation_date?: string;
    transaction_updated_date?: string;
    transaction_status?: string;
    transaction_amount?: { value: string; currency_code: string };
    transaction_subject?: string;
  };
  payer_info?: {
    account_id?: string;
    email_address?: string;
    payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string };
  };
}

interface PayPalSearchResponse {
  transaction_details?: PayPalTransaction[];
  total_items?: number;
  total_pages?: number;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getPayPalAccessToken(): Promise<string | null> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const mode = process.env.PAYPAL_MODE;

  if (!clientId || !clientSecret) {
    console.warn("[paypal] PAYPAL_CLIENT_ID/SECRET not configured");
    return null;
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.value;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${PAYPAL_API_BASE(mode)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[paypal] OAuth failed: ${res.status} ${errText.substring(0, 200)}`);
    return null;
  }

  const data = (await res.json()) as PayPalAccessTokenResponse;
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

/**
 * PayPal Reporting APIで指定期間の取引を検索
 * start/end は ISO8601 (yyyy-MM-ddTHH:mm:ss+TZ).
 */
async function searchTransactions(
  token: string,
  startIso: string,
  endIso: string,
  emailFilter?: string
): Promise<PayPalTransaction[]> {
  const mode = process.env.PAYPAL_MODE;
  const results: PayPalTransaction[] = [];
  let page = 1;
  const maxPages = 10;

  while (page <= maxPages) {
    const params = new URLSearchParams({
      start_date: startIso,
      end_date: endIso,
      fields: "transaction_info,payer_info",
      transaction_status: "S",
      page_size: "100",
      page: String(page),
    });

    const res = await fetch(
      `${PAYPAL_API_BASE(mode)}/v1/reporting/transactions?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(
        `[paypal] transactions search failed (page ${page}): ${res.status} ${errText.substring(0, 200)}`
      );
      break;
    }

    const data = (await res.json()) as PayPalSearchResponse;
    const items = data.transaction_details || [];

    for (const tx of items) {
      const email = tx.payer_info?.email_address?.toLowerCase().trim();
      if (!emailFilter || (email && email === emailFilter)) {
        results.push(tx);
      }
    }

    if (page >= (data.total_pages || 1)) break;
    page++;
  }

  return results;
}

function isoNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function transactionToPaymentMatch(tx: PayPalTransaction): PayPalPaymentMatch | null {
  const email = tx.payer_info?.email_address?.toLowerCase().trim();
  if (!email) return null;

  const payerInfo = tx.payer_info;
  const name =
    payerInfo?.payer_name?.alternate_full_name ||
    [payerInfo?.payer_name?.surname, payerInfo?.payer_name?.given_name]
      .filter(Boolean)
      .join(" ") ||
    null;
  const initiated = tx.transaction_info?.transaction_initiation_date || "";

  return {
    source: "paypal",
    email,
    name,
    paidAt: initiated.split("T")[0],
    transactionId: tx.transaction_info?.transaction_id || "",
    amount: parseFloat(tx.transaction_info?.transaction_amount?.value || "0"),
    currency: tx.transaction_info?.transaction_amount?.currency_code || "JPY",
  };
}

export async function findPayPalPaymentForEmail(
  email: string,
  daysBack: number = 90
): Promise<PayPalPaymentMatch | null> {
  const token = await getPayPalAccessToken();
  if (!token) return null;

  const normalized = email.toLowerCase().trim();
  const boundedDays = Math.min(Math.max(Math.floor(daysBack), 1), 365);

  try {
    // PayPal Reporting APIは最大31日刻みなので分割検索する。
    let bestTx: PayPalTransaction | null = null;
    for (let offset = 0; offset < boundedDays; offset += 31) {
      const startDaysAgo = Math.min(offset + 31, boundedDays);
      const start = isoNDaysAgo(startDaysAgo);
      const end = isoNDaysAgo(offset);
      const txs = await searchTransactions(token, start, end, normalized);
      for (const tx of txs) {
        const txDate = tx.transaction_info?.transaction_initiation_date || "";
        if (!bestTx || txDate > (bestTx.transaction_info?.transaction_initiation_date || "")) {
          bestTx = tx;
        }
      }
    }

    return bestTx ? transactionToPaymentMatch(bestTx) : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[findPayPalPaymentForEmail] error for ${normalized}:`, msg);
    return null;
  }
}

/**
 * subscribersに居ない人のログイン試行時に呼ばれる。
 * PayPalで該当emailの成功取引があれば、subscribersに追加して返す。
 */
export async function rescueFromPayPal(email: string): Promise<Subscriber | null> {
  const match = await findPayPalPaymentForEmail(email);
  if (!match) return null;

  try {
    const inserted = await upsertSubscriber(match.email, {
      name: match.name || undefined,
      status: "active",
      first_payment_date: match.paidAt || null,
      subscription_status: "none",
      myasp_data: {
        added_via: "send_otp_paypal_rescue",
        paypal_transaction_id: match.transactionId,
        amount: match.amount,
        currency: match.currency,
        rescued_at: new Date().toISOString(),
      },
    });

    console.log(
      `[rescueFromPayPal] rescued ${match.email} (txId=${match.transactionId}, paidAt=${match.paidAt})`
    );

    return inserted;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[rescueFromPayPal] error for ${match.email}:`, msg);
    return null;
  }
}

/**
 * Cron用: 過去N日の全成功取引を取得（emailフィルタなし）
 */
export async function listRecentPayPalPayments(daysBack: number = 2): Promise<
  PayPalPaymentMatch[]
> {
  const token = await getPayPalAccessToken();
  if (!token) return [];

  const boundedDays = Math.min(Math.max(Math.floor(daysBack), 1), 31);
  const start = isoNDaysAgo(boundedDays);
  const end = new Date().toISOString();
  const txs = await searchTransactions(token, start, end);

  return txs
    .map(transactionToPaymentMatch)
    .filter((payment): payment is PayPalPaymentMatch => Boolean(payment));
}
