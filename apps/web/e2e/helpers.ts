import { expect, type Page, type Response } from '@playwright/test';
import { generate } from 'otplib';

/** Seeded demo accounts (pnpm db:seed; packages/server/scripts/seed.ts). */
export const DEMO_PASSWORD = 'demo-password-2026';
const DEMO_TOTP_SECRET = 'rent-demo-totp-secret-2026-local';

export const PEOPLE = {
  agencyAdmin: { email: 'agency.admin@demo.invalid', name: 'Efua Agency-Admin (demo)' },
  managerOne: { email: 'manager.one@demo.invalid', name: 'Kofi Manager (demo)' },
  managerTwo: { email: 'manager.two@demo.invalid', name: 'Akosua Manager (demo)' },
  accountant: { email: 'accountant@demo.invalid', name: 'Yaw Accountant (demo)' },
  /** The one staff member the seed leaves without TOTP. */
  newManager: { email: 'new.manager@demo.invalid', name: 'Kwesi New-Manager (demo)' },
} as const;

/** RFC 4648 base32 without padding: Better Auth keys the raw secret, authenticators use base32. */
export function base32(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of new TextEncoder().encode(text)) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

const DEMO_SECRET = base32(DEMO_TOTP_SECRET);

/** The current code for every pre-enrolled demo staff member. */
export const demoCode = (): Promise<string> => generate({ secret: DEMO_SECRET });

export const codeFor = (secret: string): Promise<string> => generate({ secret });

/** A 6-digit code that no window the server accepts (previous, current, next) would produce. */
export async function wrongCode(): Promise<string> {
  const now = Math.trunc(Date.now() / 1000);
  const valid = new Set(
    await Promise.all(
      [-30, 0, 30].map((offset) => generate({ secret: DEMO_SECRET, epoch: now + offset })),
    ),
  );
  for (let candidate = 123456; ; candidate += 1) {
    const code = String(candidate % 1_000_000).padStart(6, '0');
    if (!valid.has(code)) return code;
  }
}

/**
 * Submits an auth step and returns Better Auth's response. If the API runs with its per-IP
 * limits on (AUTH_RATE_LIMITS=on), every request through the web proxy shares one address, so
 * a long run can be told to wait; this waits as long as the API says and tries again.
 */
export async function submitAuth(
  page: Page,
  path: string,
  submit: () => Promise<void>,
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const responded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
    );
    await submit();
    const response = await responded;
    if (response.status() !== 429 || attempt === 4) return response;
    const seconds = Number(response.headers()['x-retry-after'] ?? '60');
    await page.waitForTimeout(((Number.isFinite(seconds) ? seconds : 60) + 1) * 1000);
  }
}

/**
 * Waits until React has hydrated the page: buttons stay disabled until then (components/ui/button),
 * and typing into a server-rendered field before that would not reach the form's state.
 */
export async function ready(page: Page, button: string): Promise<void> {
  await expect(page.getByRole('button', { name: button, exact: true })).toBeEnabled();
}

export async function enterPassword(page: Page, email: string): Promise<Response> {
  await page.goto('/sign-in');
  await ready(page, 'Sign in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  const response = await submitAuth(page, '/api/auth/sign-in/email', () =>
    page.getByRole('button', { name: 'Sign in' }).click(),
  );
  expect(response.status(), 'sign-in with the demo password').toBe(200);
  return response;
}

export function enterCode(page: Page, code: () => Promise<string>): Promise<Response> {
  return submitAuth(page, '/api/auth/two-factor/verify-totp', async () => {
    await ready(page, 'Verify');
    await page.getByLabel('6-digit code').fill(await code());
    await page.getByRole('button', { name: 'Verify' }).click();
  });
}

/** Password, then the TOTP code, through the real screens; ends in the app shell. */
export async function signIn(page: Page, email: string): Promise<void> {
  await enterPassword(page, email);
  await expect(page).toHaveURL(/\/sign-in\/verify$/);
  const response = await enterCode(page, demoCode);
  expect(response.status(), 'TOTP verification').toBe(200);
  await expect(page.getByTestId('app-header')).toBeVisible();
}

/** The main navigation, so links are not confused with the same links on the home page. */
export const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

export const unique = (): string =>
  `${Date.now().toString(36)}${Math.trunc(Math.random() * 1296).toString(36)}`.toUpperCase();
