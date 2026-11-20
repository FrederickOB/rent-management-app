import type { NextConfig } from 'next';
import { securityHeaders } from './lib/security-headers';

/**
 * The browser only ever talks to this origin. Better Auth and the API are proxied, so staff
 * cookies stay host-only on the web origin (M1 plan, section 4.5). Rewrites are resolved when
 * the app is built, so a deployment sets API_BASE_URL at build time as well as at run time.
 */
const apiBaseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@rent/contracts', '@rent/domain'],
  async rewrites() {
    return [
      { source: '/api/auth/:path*', destination: `${apiBaseUrl}/api/auth/:path*` },
      { source: '/api/v1/:path*', destination: `${apiBaseUrl}/:path*` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders(process.env.NODE_ENV) }];
  },
};

export default nextConfig;
