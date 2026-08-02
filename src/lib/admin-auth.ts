import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";

function getOwnerEmail(): string | null {
  const configured =
    process.env.SUPPORT_ADMIN_EMAIL ||
    process.env.SUPPORT_NOTIFICATION_EMAIL ||
    "181wyc@gmail.com";
  const ownerEmail = configured.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(ownerEmail) ? ownerEmail : null;
}

export async function getAdminAuthError(): Promise<NextResponse | null> {
  const ownerEmail = getOwnerEmail();
  if (!ownerEmail) {
    return NextResponse.json(
      { error: "Admin auth is not configured" },
      { status: 500 }
    );
  }

  const session = await getSessionFromCookies();
  if (!session) {
    return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  if (session.email.trim().toLowerCase() !== ownerEmail) {
    return NextResponse.json(
      { error: "この管理画面を利用できません。" },
      { status: 403 }
    );
  }

  return null;
}
