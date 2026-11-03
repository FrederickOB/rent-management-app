// Documents rendered by the worker (the documents service): a report's PDF is asked for, then
// checked until it is ready. A person waiting at the screen is told plainly if it takes too long.

export type RenderCheck =
  | { readonly status: 'rendering' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'failed' };

export class RenderTimeout extends Error {
  constructor() {
    super('The PDF is taking longer than usual to prepare. Try again in a minute.');
    this.name = 'RenderTimeout';
  }
}

export class RenderFailed extends Error {
  constructor() {
    super('The PDF could not be prepared. Try again, and tell support if it keeps failing.');
    this.name = 'RenderFailed';
  }
}

/**
 * Checks a render until it is ready, waiting between checks, and gives its short-lived link. It
 * gives up after `attempts` checks (about half a minute by default) rather than wait for ever.
 */
export async function waitForRender(
  check: () => Promise<RenderCheck>,
  options: {
    readonly attempts?: number;
    readonly wait?: (ms: number) => Promise<void>;
    readonly intervalMs?: number;
  } = {},
): Promise<string> {
  const attempts = options.attempts ?? 30;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await check();
    if (result.status === 'ready') return result.url;
    if (result.status === 'failed') throw new RenderFailed();
    await wait(options.intervalMs ?? 1_000);
  }
  throw new RenderTimeout();
}
