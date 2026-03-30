import { redirect } from "next/navigation";
import { getSessionFromCookies } from "@/lib/auth";

export default async function Home() {
  const session = await getSessionFromCookies();

  if (session) {
    redirect("/chat");
  } else {
    redirect("/login");
  }
}
