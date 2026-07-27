import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // public/roles/*.svg 자리표시자를 next/image 로 쓰기 위함.
    // 원격 이미지는 허용하지 않고(remotePatterns 없음), 아래 CSP 로 스크립트 실행을 막는다.
    // 실제 아트(png/jpg)로 교체한 뒤에는 이 블록을 지워도 된다.
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
};

export default nextConfig;
