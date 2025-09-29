import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Yoklama Sistemi",
  description: "QR tabanlı akıllı yoklama sistemi",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr">
      <head>
        <script src="https://accounts.google.com/gsi/client" async defer></script>
      </head>
      <body className={geist.className}>{children}</body>
    </html>
  );
}