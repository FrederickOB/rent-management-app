import type { IncomingMessage, Server } from 'node:http';

/**
 * The address of whoever opened the connection, as this server's socket saw it (M11 security
 * review F8). Next.js copies the socket's address into X-Forwarded-For only when a request has
 * none, so that header is the client's own word. Every request this server receives gets this
 * header instead, set here from the socket and overwriting anything the client sent under the
 * name.
 */
export const PEER_ADDRESS_HEADER = 'x-rent-links-peer';

const STAMPED = Symbol.for('rent.links.peer-address');

/** Sets PEER_ADDRESS_HEADER on every request a Node HTTP server emits. Installed once, at start. */
export function installPeerAddress(prototype: Server): void {
  const marked = prototype as Server & { [STAMPED]?: true };
  if (marked[STAMPED]) return;
  const emit = prototype.emit as (
    this: Server,
    event: string | symbol,
    ...args: unknown[]
  ) => boolean;
  prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]) {
    if (event === 'request') {
      const request = args[0] as IncomingMessage;
      request.headers[PEER_ADDRESS_HEADER] = request.socket?.remoteAddress ?? 'unknown';
    }
    return emit.apply(this, [event, ...args]);
  } as Server['emit'];
  marked[STAMPED] = true;
}

/**
 * Whether a deployment is missing the edge's client-address header: a real deployment sets its own
 * LINKS_API_KEY (CI and local stacks use the shared development key) and must then name the header
 * its edge overwrites, CLIENT_IP_HEADER (M12 sets the edge).
 */
export function missingClientIpHeader(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NODE_ENV === 'production' && Boolean(env.LINKS_API_KEY) && !env.CLIENT_IP_HEADER;
}
