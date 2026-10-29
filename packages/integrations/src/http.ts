/** A provider call failed. `retryable` tells the job runner whether to try again. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
  }
}

export interface JsonRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

/** JSON over HTTP with a timeout. 5xx, 429 and network errors are retryable; other 4xx are not. */
export async function requestJson<T>(
  provider: string,
  url: string,
  init: JsonRequest = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new ProviderError(provider, `request failed (${(error as Error).name})`, true);
  }
  if (!response.ok) {
    throw new ProviderError(
      provider,
      `HTTP ${response.status}`,
      response.status >= 500 || response.status === 429,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    // A 2xx that is not JSON (a proxy's error page, a truncated body) is worth retrying.
    throw new ProviderError(provider, 'response was not JSON', true, response.status);
  }
}
