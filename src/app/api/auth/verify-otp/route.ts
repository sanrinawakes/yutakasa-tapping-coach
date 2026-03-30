import { NextRequest, NextResponse } from "next/server";
import { verifyOTPCode } from "@/lib/supabase";
import { createSession, setSessionCookie } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const { email, code } = await request.json();

    if (!email || !code) {
      return NextResponse.json(
        { error: "Email and code are required" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedCode = code.toString().trim();

    // Verify OTP
    const otpRecord = await verifyOTPCode(normalizedEmail, normalizedCode);

    if (!otpRecord) {
      return NextResponse.json(
        { error: "コードが無効または期限切れです" },
        { status: 401 }
      );
    }

    // Create JWT session
    const token = await createSession(normalizedEmail);

    // Set session cookie
    await setSessionCookie(token);

    return NextResponse.json({ success: true, email: normalizedEmail });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return NextResponse.json(
      { error: "認証に失敗しました" },
      { status: 500 }
    );
  }
}
