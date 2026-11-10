/** How a typed client reaches the API (shared by the full client and the tenant app's). */
export interface ApiClientOptions {
  /** API origin, for example http://localhost:3000. */
  readonly baseUrl: string;
  /** Extra headers per request (the Expo app sends its session cookie this way). */
  readonly headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Browser clients send cookies. */
  readonly credentials?: RequestCredentials;
  readonly fetch?: typeof fetch;
}
