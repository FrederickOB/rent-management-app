import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this origin. Better Auth and the API are proxied, so staff
 * cookies stay host-only on the web origin (M1 plan, section 4.5). Rewrites are resolved when
 * the app is built, so a deployment sets API_BASE_URL at build time as well as at run time.
 */
const apiBaseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');

// No script policy here: Next.js needs inline scripts and eval in development. The strict,
// nonce-based policy belongs to apps/links; this one stops framing and base or plugin abuse.
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // The set-password link carries its token in the query string; never send it elsewhere.
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

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
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
