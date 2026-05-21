import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // Playwright should not be bundled by Next on the server side.
  serverExternalPackages: ['playwright', 'playwright-core', 'bullmq', 'ioredis'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: 'chromewebstore.google.com' },
      { protocol: 'https', hostname: 'ph-files.imgix.net' },
    ],
  },
}

export default nextConfig
