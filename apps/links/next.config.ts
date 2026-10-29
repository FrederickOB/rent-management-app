import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Every URL on this host can carry a link token, so dev logging stays off (CLAUDE.md section 9).
  logging: false,
  // The e2e run builds into its own folder, so it never replaces files a running server reads.
  distDir: process.env.LINKS_DIST_DIR ?? '.next',
};

export default config;
