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
  title: "사람인 척",
  description: "3~8명 중 누가 AI인지 찾는 게임",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/*
          지하 라운지 조명 — 모든 화면 뒤에 한 장 깔린다 (app/globals.css의 .room-backdrop).
          /bg-3d 의 진짜 Three.js 씬은 자기 캔버스로 이걸 덮는다. 그 폴더는 건드리지 않는다.
        */}
        <div aria-hidden className="room-backdrop" />
        {children}
      </body>
    </html>
  );
}
