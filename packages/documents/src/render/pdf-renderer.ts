import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
} from 'playwright';

export interface PdfRendererOptions {
  /** Pages kept open and ready, and the most renders that run at once. */
  readonly poolSize?: number;
  /** The longest one render may take before it is abandoned, in milliseconds. */
  readonly timeoutMs?: number;
  /** Called with the URL of each request the renderer refused. */
  readonly onBlockedRequest?: (url: string) => void;
  /** Passed to Chromium's launch, for example the executable in the worker image. */
  readonly launchOptions?: LaunchOptions;
}

export type PdfRenderErrorCode = 'timeout' | 'closed' | 'failed';

export class PdfRenderError extends Error {
  override readonly name = 'PdfRenderError';
  constructor(
    readonly code: PdfRenderErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface Session {
  readonly browser: Browser;
  readonly context: BrowserContext;
}

const MAX_POOL_SIZE = 16;
const closedError = () => new PdfRenderError('closed', 'The renderer is closed');

/**
 * Renders HTML to A4 PDF in headless Chromium (ADR-006, docs/plans/M1.md section 4.13). It keeps
 * a few pages warm, refuses every request except data: URIs, and runs no page scripts.
 *
 * Each page renders one document and is then closed, while a fresh page is opened in the
 * background. A reused page would carry state into the next document (setContent writes into the
 * same document, keeping for example an earlier Content-Security-Policy), and resetting it with a
 * navigation opens a window in which Chromium leaves a close unanswered.
 */
export class PdfRenderer {
  private readonly poolSize: number;
  private readonly timeoutMs: number;
  /** Opened and not yet used. */
  private readonly idle: Page[] = [];
  private opening = 0;
  private running = 0;
  private readonly waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private session: Promise<Session> | undefined;
  private closed = false;

  private constructor(private readonly options: PdfRendererOptions) {
    this.poolSize = options.poolSize ?? 2;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (
      !Number.isSafeInteger(this.poolSize) ||
      this.poolSize < 1 ||
      this.poolSize > MAX_POOL_SIZE
    ) {
      throw new RangeError(`poolSize must be 1 to ${MAX_POOL_SIZE}`);
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError('timeoutMs must be a positive integer');
    }
  }

  /** Starts Chromium and opens the warm pages. */
  static async launch(options: PdfRendererOptions = {}): Promise<PdfRenderer> {
    const renderer = new PdfRenderer(options);
    try {
      const pages = await Promise.all(
        Array.from({ length: renderer.poolSize }, () => renderer.openPage()),
      );
      renderer.idle.push(...pages);
    } catch (error) {
      await renderer.close();
      throw error;
    }
    return renderer;
  }

  /** Renders a complete HTML document, with its images and fonts as data URIs, to PDF bytes. */
  async render(html: string, options: { readonly timeoutMs?: number } = {}): Promise<Buffer> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    await this.acquire();
    let page: Page | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        const taken = await this.takePage();
        if (finished) {
          // The render timed out while its page was being opened.
          void taken.close().catch(() => undefined);
          throw new PdfRenderError('timeout', `Rendering took over ${timeoutMs} ms`);
        }
        page = taken;
        return this.renderOn(taken, html, timeoutMs);
      })();
      // When the timeout wins, closing the page rejects `work`; that rejection is expected.
      work.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PdfRenderError('timeout', `Rendering took over ${timeoutMs} ms`)),
          timeoutMs,
        );
      });
      return await Promise.race([work, timeout]);
    } catch (error) {
      throw this.renderError(error, timeoutMs);
    } finally {
      finished = true;
      clearTimeout(timer);
      // Not awaited, so a page that will not close can never hold up the pool.
      if (page) void page.close().catch(() => undefined);
      this.releaseTurn();
      this.refill();
    }
  }

  /** Closes Chromium. Waiting and later renders fail with `closed`. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(closedError());
    this.idle.length = 0;
    const session = this.session;
    this.session = undefined;
    if (session) await session.then((s) => s.browser.close()).catch(() => undefined);
  }

  private renderError(error: unknown, timeoutMs: number): PdfRenderError {
    if (error instanceof PdfRenderError) return error;
    if (error instanceof errors.TimeoutError) {
      return new PdfRenderError('timeout', `Rendering took over ${timeoutMs} ms`, { cause: error });
    }
    if (this.closed)
      return new PdfRenderError('closed', 'The renderer is closed', { cause: error });
    return new PdfRenderError('failed', 'Rendering failed', { cause: error });
  }

  private async renderOn(page: Page, html: string, timeoutMs: number): Promise<Buffer> {
    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
    // Printing before the embedded fonts are ready would fall back to another font.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  }

  /** Waits for one of the `poolSize` turns to render. */
  private acquire(): Promise<void> {
    if (this.closed) return Promise.reject(closedError());
    if (this.running < this.poolSize) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private releaseTurn(): void {
    const next = this.waiting.shift();
    if (next) next.resolve();
    else this.running -= 1;
  }

  private async takePage(): Promise<Page> {
    for (let page = this.idle.pop(); page; page = this.idle.pop()) {
      // A page closed by a browser crash is skipped; openPage starts Chromium again.
      if (!page.isClosed()) return page;
    }
    return this.openPage();
  }

  /** Opens pages in the background until `poolSize` are ready. */
  private refill(): void {
    while (!this.closed && this.idle.length + this.opening < this.poolSize) {
      this.opening += 1;
      void this.openPage()
        .then(
          (page) => {
            if (this.closed) void page.close().catch(() => undefined);
            else this.idle.push(page);
          },
          // The next render opens its own page and reports the failure.
          () => undefined,
        )
        .finally(() => {
          this.opening -= 1;
        });
    }
  }

  private async openPage(): Promise<Page> {
    const { context } = await this.liveSession();
    return context.newPage();
  }

  /** The browser and its context, launched again if Chromium has gone away. */
  private async liveSession(): Promise<Session> {
    if (this.closed) throw closedError();
    const current = this.session;
    if (current) {
      const session = await current;
      if (session.browser.isConnected()) return session;
      // Another caller may already be launching again.
      if (this.session !== current) return this.liveSession();
    }
    const launching = this.startSession();
    this.session = launching;
    launching.catch(() => {
      if (this.session === launching) this.session = undefined;
    });
    return launching;
  }

  private async startSession(): Promise<Session> {
    const browser = await chromium.launch(this.options.launchOptions);
    try {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      // Templates carry everything as data URIs (which are never routed); any other request is
      // a template bug or an injection, and is refused.
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('data:')) return route.continue();
        try {
          this.options.onBlockedRequest?.(url);
        } catch {
          // A failing report must not let the request through or stall the render.
        }
        return route.abort('blockedbyclient');
      });
      return { browser, context };
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }
}
