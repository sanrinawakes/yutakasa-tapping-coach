import { NextRequest, NextResponse } from "next/server";
import { getAdminAuthError } from "@/lib/admin-auth";
import { evaluateAccess } from "@/lib/access-control";
import { getSubscriberByEmail, Subscriber } from "@/lib/supabase";
import {
  findStripePaymentForEmail,
  rescueFromStripe,
  StripePaymentMatch,
} from "@/lib/stripe-fallback";
import {
  findPayPalPaymentForEmail,
  rescueFromPayPal,
  PayPalPaymentMatch,
} from "@/lib/paypal-fallback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type ProviderMatch = StripePaymentMatch | PayPalPaymentMatch;

interface DiagnosticRequest {
  email?: string;
  emails?: string[];
  includePaymentLookup?: boolean;
  rescueProviderPayment?: boolean;
}

function normalizeEmails(body: DiagnosticRequest): string[] {
  const rawEmails = [
    ...(body.email ? [body.email] : []),
    ...(Array.isArray(body.emails) ? body.emails : []),
  ];

  return Array.from(
    new Set(
      rawEmails
        .map((email) => String(email).toLowerCase().trim())
        .filter((email) => email.includes("@"))
    )
  ).slice(0, 20);
}

function getAddedVia(subscriber: Subscriber | null): string | null {
  const addedVia = subscriber?.myasp_data?.added_via;
  return typeof addedVia === "string" ? addedVia : null;
}

function serializeSubscriber(subscriber: Subscriber | null) {
  if (!subscriber) return null;

  return {
    email: subscriber.email,
    name: subscriber.name ?? null,
    status: subscriber.status,
    subscriptionStatus: subscriber.subscription_status,
    firstPaymentDate: subscriber.first_payment_date ?? null,
    subscriptionStartedAt: subscriber.subscription_started_at ?? null,
    createdAt: subscriber.created_at,
    updatedAt: subscriber.updated_at,
    addedVia: getAddedVia(subscriber),
    myaspData: subscriber.myasp_data ?? null,
  };
}

function makeRecommendation(
  subscriber: Subscriber | null,
  access: ReturnType<typeof evaluateAccess>,
  providerMatch: ProviderMatch | null,
  rescued: boolean
): string {
  if (rescued) return "provider_payment_rescued";
  if (access.allowed) return "ok_can_login";
  if (!subscriber && providerMatch) return "provider_payment_found_rescue_available";
  if (!subscriber) return "missing_from_subscribers_check_myasp_or_manual_rescue";
  if (!access.allowed && access.reason === "first_payment_unknown" && providerMatch) {
    return "payment_date_found_rescue_available";
  }
  if (!access.allowed) return access.reason;
  return "needs_review";
}

async function findProviderMatch(
  email: string,
  includePaymentLookup: boolean
): Promise<ProviderMatch | null> {
  if (!includePaymentLookup) return null;

  const stripe = await findStripePaymentForEmail(email);
  if (stripe) return stripe;

  const paypal = await findPayPalPaymentForEmail(email);
  if (paypal) return paypal;

  return null;
}

async function rescueProviderPayment(
  email: string,
  providerMatch: ProviderMatch | null
) {
  if (!providerMatch) return null;
  if (providerMatch.source === "stripe") return rescueFromStripe(email);
  return rescueFromPayPal(email);
}

export async function POST(request: NextRequest) {
  const authError = getAdminAuthError(request);
  if (authError) return authError;

  const body = (await request.json().catch(() => ({}))) as DiagnosticRequest;
  const emails = normalizeEmails(body);
  if (emails.length === 0) {
    return NextResponse.json(
      { error: "At least one valid email is required" },
      { status: 400 }
    );
  }

  const includePaymentLookup = body.includePaymentLookup !== false;
  const shouldRescue = body.rescueProviderPayment === true;
  const diagnostics = [];

  for (const email of emails) {
    let subscriber = await getSubscriberByEmail(email);
    let access = evaluateAccess(subscriber);
    const providerMatch = await findProviderMatch(email, includePaymentLookup);
    let rescued = false;

    if (shouldRescue && providerMatch && !access.allowed) {
      const rescuedSubscriber = await rescueProviderPayment(email, providerMatch);
      if (rescuedSubscriber) {
        rescued = true;
        subscriber = await getSubscriberByEmail(email);
        access = evaluateAccess(subscriber);
      }
    }

    diagnostics.push({
      email,
      subscriber: serializeSubscriber(subscriber),
      access,
      payment: providerMatch,
      rescued,
      recommendation: makeRecommendation(subscriber, access, providerMatch, rescued),
    });
  }

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    includePaymentLookup,
    rescueProviderPayment: shouldRescue,
    diagnostics,
  });
}
