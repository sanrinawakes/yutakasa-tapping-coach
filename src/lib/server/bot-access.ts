import { NextResponse } from "next/server";
import { accessReasonToMessage, evaluateAccess } from "@/lib/access-control";
import { getSubscriberByEmail } from "@/lib/supabase";

export async function botAccessDenial(email: string) {
  const access = evaluateAccess(await getSubscriberByEmail(email));
  if (access.allowed) return null;

  return NextResponse.json(
    {
      error: accessReasonToMessage(access.reason),
      reason: access.reason,
      code: "ACCESS_DENIED",
    },
    { status: 403 }
  );
}
