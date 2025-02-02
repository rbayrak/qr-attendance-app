import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */// Güvenlik header'ları
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }
        ],
      },
    ];
  },
  // Diğer yapılandırmalar...
};

export default nextConfig;
