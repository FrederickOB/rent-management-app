/** Runs once when the server starts, before it handles any request. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ ServerResponse }, { installSetCookieGuard }, { installLogRedaction }] =
      await Promise.all([
        import('node:http'),
        import('./lib/set-cookie-guard'),
        import('./lib/log-redaction'),
      ]);
    installSetCookieGuard(ServerResponse.prototype);
    // No line this server writes, its own or Next.js's, carries a link token (CLAUDE.md
    // section 9; M8 review LT 1).
    installLogRedaction(console);
  }
}
