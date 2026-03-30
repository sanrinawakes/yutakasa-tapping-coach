import { redirect } from "next/navigation";
import { getSessionFromCookies } from "@/lib/auth";

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionFromCookies();

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="h-screen flex bg-warm-50">
      {children}
    </div>
  );
}
