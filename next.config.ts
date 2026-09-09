import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 사용자가 지정한 AGENTS.md가 개발 서버 실행 중 자동 변경되지 않게 합니다.
  agentRules: false,
};

export default nextConfig;
