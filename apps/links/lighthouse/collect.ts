import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { THREE_G_LIGHTHOUSE } from './three-g';

/**
 * Lighthouse runs for the M11 page budgets (decision 8): Playwright drives a Chromium of its own
 * (signing in, for the tenant app), and Lighthouse measures pages in that same browser through
 * its debugging port, on the 3G profile (three-g.ts). Each report goes into its group's folder,
 * where `lhci assert` checks it against the group's budgets (run.mjs).
 *
 * - **links:** every links page, on a first visit.
 * - **tenant-first:** the tenant web app on a first visit: nothing cached.
 * - **tenant-repeat:** the same screens again, with the app in the browser's cache.
 *
 * Link tokens never reach a report: each is replaced by the page's name.
 */
export const RESULTS = path.join(import.meta.dirname, '.results');
export type Group = 'links' | 'tenant-first' | 'tenant-repeat';

export const LINKS_URL = (process.env.LINKS_BASE_URL ?? 'http://localhost:3702').replace(
  /\/+$/,
  '',
);
export const TENANT_URL = (process.env.TENANT_WEB_ORIGIN ?? 'http://localhost:8081').replace(
  /\/+$/,
  '',
);

interface Lhr {
  readonly audits: Record<string, { readonly numericValue?: number } | undefined>;
  readonly runtimeError?: { readonly message?: string };
}
type Lighthouse = (
  url: string,
  flags: Record<string, unknown>,
  config: Record<string, unknown>,
) => Promise<{ readonly lhr: Lhr } | undefined>;

let lighthouseFn: Lighthouse | null = null;

/** Lighthouse itself, as @lhci/cli installs it (one version for collecting and asserting). */
async function lighthouse(): Promise<Lighthouse> {
  if (lighthouseFn) return lighthouseFn;
  const lhci = createRequire(import.meta.url).resolve('@lhci/cli/package.json');
  const entry = createRequire(lhci).resolve('lighthouse');
  lighthouseFn = ((await import(pathToFileURL(entry).href)) as { default: Lighthouse }).default;
  return lighthouseFn;
}

/** A phone of 5 inches (CLAUDE.md section 9), the same screen the Playwright specs use. */
const SCREEN = { mobile: true, width: 360, height: 640, deviceScaleFactor: 3, disabled: false };

const CONFIG = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance'],
    formFactor: 'mobile',
    screenEmulation: SCREEN,
    throttlingMethod: 'devtools',
    throttling: THREE_G_LIGHTHOUSE,
    maxWaitForLoad: 90_000,
  },
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface MeasuringBrowser {
  readonly context: BrowserContext;
  readonly port: number;
  page(): Promise<Page>;
  close(): Promise<void>;
}

/** A Chromium with a profile of its own, open to Lighthouse on a debugging port. */
export async function openBrowser(baseURL: string): Promise<MeasuringBrowser> {
  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'rent-lighthouse-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [`--remote-debugging-port=${port}`],
    baseURL,
    viewport: { width: SCREEN.width, height: SCREEN.height },
    deviceScaleFactor: SCREEN.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  });
  return {
    context,
    port,
    page: async () => context.pages()[0] ?? (await context.newPage()),
    close: async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export interface Measured {
  readonly group: Group;
  readonly name: string;
  readonly bytes: number;
  readonly lcpMs: number;
  readonly cls: number;
  readonly tbtMs: number;
}

let saved = 0;

/**
 * Measures one page. `firstVisit` empties the browser's cache first; `keepStorage` keeps the
 * session (cookies and the app's storage) for the signed-in screens, and for a repeat visit.
 */
export async function measure(
  browser: MeasuringBrowser,
  options: {
    readonly group: Group;
    readonly name: string;
    readonly url: string;
    readonly firstVisit: boolean;
    readonly keepStorage: boolean;
  },
): Promise<Measured> {
  if (options.firstVisit && options.keepStorage) {
    const page = await browser.page();
    const cdp = await browser.context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.detach();
  }
  const run = await (
    await lighthouse()
  )(
    options.url,
    {
      port: browser.port,
      output: 'json',
      logLevel: 'error',
      disableStorageReset: options.keepStorage,
    },
    CONFIG,
  );
  if (!run) throw new Error(`Lighthouse returned nothing for ${options.name}`);
  if (run.lhr.runtimeError?.message)
    throw new Error(`Lighthouse failed on ${options.name}: ${run.lhr.runtimeError.message}`);
  const label = options.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const json = JSON.stringify(run.lhr).replace(/\/([lpruj])\/[A-Za-z0-9_-]{43}/g, `/$1/${label}`);
  const dir = path.join(RESULTS, options.group, '.lighthouseci');
  mkdirSync(dir, { recursive: true });
  saved += 1;
  // LHCI reads `lhr-<digits>.json`.
  writeFileSync(path.join(dir, `lhr-${Date.now()}${String(saved).padStart(3, '0')}.json`), json);
  const value = (audit: string) => run.lhr.audits[audit]?.numericValue ?? Number.NaN;
  return {
    group: options.group,
    name: options.name,
    bytes: value('total-byte-weight'),
    lcpMs: value('largest-contentful-paint'),
    cls: value('cumulative-layout-shift'),
    tbtMs: value('total-blocking-time'),
  };
}

/** Appends what was measured, for run.mjs's summary. */
export function record(measured: readonly Measured[]): void {
  mkdirSync(RESULTS, { recursive: true });
  for (const m of measured)
    writeFileSync(path.join(RESULTS, 'measured.jsonl'), `${JSON.stringify(m)}\n`, { flag: 'a' });
}
