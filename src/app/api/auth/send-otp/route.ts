import { NextRequest, NextResponse } from "next/server";
import { getSubscriberByEmail, createOTPCode } from "@/lib/supabase";
import { evaluateAccess, accessReasonToMessage } from "@/lib/access-control";
import { Resend } from "resend";

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 認可チェック（365日ライセンス & 月額サブスク）
    const subscriber = await getSubscriberByEmail(normalizedEmail);
    const access = evaluateAccess(subscriber);

    if (!access.allowed) {
      const message = accessReasonToMessage(access.reason);
      // 期限切れケースは加入導線を返すため reason をフロントに伝える
      const status = access.reason === "no_subscriber" ? 404 : 403;
      return NextResponse.json(
        {
          error: message,
          reason: access.reason,
          firstPaymentDate: access.firstPaymentDate ?? null,
        },
        { status }
      );
    }

    // Create OTP code
    const { code } = await createOTPCode(normalizedEmail);

    // Send email via Resend
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "豊かさタッピング AIコーチ <noreply@silversense.cc>",
      to: normalizedEmail,
      subject: "豊かさタッピング AIコーチ - ログインコード",
      html: `
        <h2>ログインコード</h2>
        <p>以下のコードを入力してください：</p>
        <h1 style="font-size: 32px; letter-spacing: 5px; font-family: monospace;">${code}</h1>
        <p>このコードは10分間有効です。</p>
      `,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Send OTP error:", error);
    return NextResponse.json(
      { error: "メール送信に失敗しました" },
      { status: 500 }
    );
  }
}
