import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Yoklama Sistemi",
  description: "QR tabanlı akıllı yoklama sistemi",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr">
      <head>
        <meta 
          httpEquiv="Content-Security-Policy" 
          content="default-src 'self';
          connect-src 'self' https://sheets.googleapis.com;
          img-src 'self' https://api.qrserver.com data:;
          style-src 'self' 'unsafe-inline';
          font-src 'self' data:;
          script-src 'self' 'unsafe-eval'"
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-gray-50`}>
        {children}
      </body>
    </html>
  );
}
