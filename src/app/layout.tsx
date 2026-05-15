import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Server Monitor",
  description: "Infrastructure monitoring dashboard",
  robots: "noindex, nofollow",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 min-h-screen">
        {children}
      </body>
    </html>
  );
}
