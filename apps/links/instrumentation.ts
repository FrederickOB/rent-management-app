/** Runs once when the server starts, before it handles any request. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ Server, ServerResponse }, { installSetCookieGuard }, { installLogRedaction }, peer] =
      await Promise.all([
        import('node:http'),
        import('./lib/set-cookie-guard'),
        import('./lib/log-redaction'),
        import('./lib/peer-address'),
      ]);
    // M11 security review F8: behind the edge, the client's address comes only from the header
    // the edge overwrites; a deployment without it refuses to start.
    if (peer.missingClientIpHeader(process.env)) {
      console.error(
        '[links] CLIENT_IP_HEADER is not set: name the header the edge overwrites with the client address',
      );
      process.exit(1);
    }
    installSetCookieGuard(ServerResponse.prototype);
    // No line this server writes, its own or Next.js's, carries a link token (CLAUDE.md
    // section 9; M8 review LT 1).
    installLogRedaction(console);
    // With no edge in front, the connection's own address (lib/peer-address.ts).
    peer.installPeerAddress(Server.prototype);
  }
}
