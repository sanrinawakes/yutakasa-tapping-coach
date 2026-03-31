import type { Metadata } from "next";
import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";

const SITE_NAME =
  process.env.NEXT_PUBLIC_SITE_NAME || "豊かさタッピング AIコーチ";

export const metadata: Metadata = {
  title: SITE_NAME,
  description: "豊かさタッピングプロジェクトの専門AIコーチング",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='75' font-size='75' font-family='serif'>🌿</text></svg>",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
