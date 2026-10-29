/** Runs once when the server starts, before it handles any request. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ ServerResponse }, { installSetCookieGuard }] = await Promise.all([
      import('node:http'),
      import('./lib/set-cookie-guard'),
    ]);
    installSetCookieGuard(ServerResponse.prototype);
  }
}
