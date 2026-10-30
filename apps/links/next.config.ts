import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Every URL on this host can carry a link token, so dev logging stays off (CLAUDE.md section 9).
  logging: false,
  // The e2e run builds into its own folder, so it never replaces files a running server reads.
  distDir: process.env.LINKS_DIST_DIR ?? '.next',
  // The shared contracts are TypeScript source (ADR-014); only server code imports them here.
  transpilePackages: ['@rent/contracts', '@rent/domain'],
};

export default config;
