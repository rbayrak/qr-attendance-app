import type { NextConfig } from 'next'

// Eski adres (vercel.app) bazı mobil ağlardan açılmıyor; site qryoklama.dev'e taşındı.
// Eski adrese gelen her istek yeni adrese gönderilir. Tanıma çerezi adrese bağlı
// olduğu için öğrencilerin tek bir adreste kalması gerekir. Geçici (307) yönlendirme:
// tarayıcılar kalıcı olarak ezberlemez, gerekirse geri alınabilir.
const OLD_HOST = 'qr-attendance-app-ramazan-bayraks-projects.vercel.app';
const NEW_ORIGIN = 'https://qryoklama.dev';

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: OLD_HOST }],
        destination: `${NEW_ORIGIN}/:path*`,
        permanent: false,
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'api.qrserver.com',
        port: '',
        pathname: '/v1/create-qr-code/**',
      },
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // ✅ Google OAuth için COOP header düzeltmesi
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'unsafe-none',
          },
        ],
      },
    ]
  },
}

export default nextConfig
