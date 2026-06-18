import { NextRequest, NextResponse } from "next/server";
import { getAdminAuthError } from "@/lib/admin-auth";
import { syncPayments } from "@/lib/payment-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function parseLookbackDays(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return undefined;
}

export async function GET(request: NextRequest) {
  const authError = getAdminAuthError(request);
  if (authError) return authError;

  const lookbackDays = parseLookbackDays(
    request.nextUrl.searchParams.get("lookbackDays")
  );
  const dryRun = request.nextUrl.searchParams.get("apply") !== "true";
  const result = await syncPayments({ lookbackDays, dryRun });

  return NextResponse.json(result, {
    status: result.fatalErrors.length > 0 ? 500 : 200,
  });
}

export async function POST(request: NextRequest) {
  const authError = getAdminAuthError(request);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const lookbackDays = parseLookbackDays(body.lookbackDays);
  const dryRun = body.apply !== true;
  const result = await syncPayments({ lookbackDays, dryRun });

  return NextResponse.json(result, {
    status: result.fatalErrors.length > 0 ? 500 : 200,
  });
}
