import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { baseStyles } from '../lib/styles';

export const metadata: Metadata = {
  title: 'Secure link',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The proxy's per-request nonce. Reading request headers also renders every page per request,
  // which a nonce needs: a page rendered at build time would carry none.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <head>
        <style nonce={nonce}>{baseStyles}</style>
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
