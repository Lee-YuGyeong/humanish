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
          창고 — 모든 화면 뒤에 깔리는 공간 (app/globals.css의 .room).

          벽은 rotateY, 바닥은 rotateX로 **실제 원근 변환**을 받는다. 그래서 골강판 골과
          슬래브 눈금이 소실점을 향해 저절로 좁아진다 — 평면에 그린 격자와 다른 점이다.
          JS는 한 줄도 쓰지 않는다.

          /bg-3d 의 진짜 Three.js 씬은 자기 캔버스로 이걸 덮는다. 그 폴더는 건드리지 않는다.
        */}
        <div aria-hidden className="room">
          <div className="room-wall room-wall-l" />
          <div className="room-wall room-wall-r" />
          <div className="room-floor" />
          <div className="room-screen" />
        </div>
        {children}
      </body>
    </html>
  );
}
