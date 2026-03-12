import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "upmo",
  description: "社内の情報をAIで一元管理",
  icons: {
    icon: "/upmologo.png",
    shortcut: "/upmologo.png",
    apple: "/upmologo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
