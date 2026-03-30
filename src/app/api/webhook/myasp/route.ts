import { NextRequest, NextResponse } from "next/server";
import { upsertSubscriber } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  try {
    const webhookSecret = process.env.MYASP_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("MYASP_WEBHOOK_SECRET is not set");
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }

    // Verify webhook secret via header or query param
    const token =
      request.headers.get("x-webhook-token") ||
      request.nextUrl.searchParams.get("token");

    if (token !== webhookSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // MyASP sends form-encoded data
    const contentType = request.headers.get("content-type") || "";
    let email: string | null = null;
    let name: string | null = null;
    let type: string | null = null;

    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      email = formData.get("data[User][mail]") as string;
      name = formData.get("data[User][name1]") as string;
      type = formData.get("Type") as string;
    } else {
      // Also support JSON for flexibility
      const body = await request.json();
      email = body?.data?.User?.mail || body?.email;
      name = body?.data?.User?.name1 || body?.name;
      type = body?.Type || body?.type;
    }

    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Determine status based on webhook type
    let status: "active" | "cancelled" = "active";
    if (type === "cancel" || type === "退会" || type === "解約") {
      status = "cancelled";
    }

    // Upsert subscriber
    await upsertSubscriber(normalizedEmail, {
      name: name || undefined,
      status,
      myasp_data: {
        type,
        webhookReceivedAt: new Date().toISOString(),
      },
    });

    console.log(`MyASP webhook: ${normalizedEmail} -> ${status}`);

    return NextResponse.json({
      success: true,
      email: normalizedEmail,
      status,
    });
  } catch (error) {
    console.error("MyASP webhook error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
