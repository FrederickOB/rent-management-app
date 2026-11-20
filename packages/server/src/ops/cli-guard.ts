/**
 * The incident commands' guard (M11 decision 9): `pnpm ops:replay-webhooks`, `pnpm ops:redrive`
 * and `pnpm ops:reconcile` refuse a database named `rent` (the local development database, and the
 * usual name in a deployment) unless the operator says so with `--allow-rent-database`. A typo'd
 * or forgotten DATABASE_URL then cannot replay, retry or reconcile anything by accident.
 *
 * M11 review (reviewer B): the name is worked out as node-postgres works it out, so no spelling
 * slips past: pg-connection-string's parse (a Unix-socket path, `socket:` URLs and their `db`
 * parameter, `%2F` socket hosts, the path decoded with decodeURI, so `%72ent` is `rent`), then
 * pg's fallbacks when the URL names none (PGDATABASE, then the user: the URL's, PGUSER, the OS
 * user's). A URL that names no database, or that carries a database in its query string (libpq's
 * `dbname`, `database`, `service`, which other tools honour), is refused outright: the database
 * must be named in the path, where everyone reads it the same way. This module imports nothing,
 * so the commands can run it before they load anything else.
 */
export const ALLOW_RENT_FLAG = 'allow-rent-database';

/** Query parameters that name or choose a database somewhere (libpq, pg, psql). */
const DATABASE_PARAMETERS = ['dbname', 'database', 'db', 'service'];

export interface ResolvedDatabase {
  /** The database the connection would open, as node-postgres decides it; null if none. */
  readonly database: string | null;
  /** How it was decided: the URL itself, or a fallback that is not in the URL. */
  readonly source: 'url' | 'PGDATABASE' | 'user' | 'none';
  /** A query parameter that names a database, which the guard refuses. */
  readonly queryOverride: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

const decode = (value: string, fn: (v: string) => string): string => {
  try {
    return fn(value);
  } catch {
    return value;
  }
};

/** The database a connection string opens, as node-postgres (pg-connection-string, then pg) does. */
export function resolveDatabase(url: string, env: Env = process.env): ResolvedDatabase {
  let database: string | null;
  let user: string | null = null;
  let queryOverride: string | null = null;
  if (url.startsWith('/')) {
    // "/var/run/postgresql rent": a socket directory, then the database.
    database = url.split(' ')[1] || null;
  } else {
    let text = url;
    if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(text))
      text = encodeURI(text).replace(/%25(\d\d)/g, '%$1');
    let parsed: URL | null;
    let dummyHost = false;
    // As pg-connection-string, but never relative to a made-up base: a string that is not a
    // postgres URL (pg would read it as a path on a host called "base") names nothing here.
    try {
      parsed = new URL(text);
    } catch {
      try {
        parsed = new URL(text.replace('@/', '@___DUMMY___/'));
        dummyHost = true;
      } catch {
        parsed = null;
      }
    }
    if (!parsed || !['postgres:', 'postgresql:', 'socket:'].includes(parsed.protocol))
      return { database: null, source: 'none', queryOverride: null };
    for (const name of DATABASE_PARAMETERS) {
      const value = parsed.searchParams.get(name);
      if (value !== null && parsed.protocol !== 'socket:') queryOverride ??= `${name}=${value}`;
    }
    user = parsed.searchParams.get('user') || decode(parsed.username, decodeURIComponent) || null;
    if (parsed.protocol === 'socket:') {
      database = parsed.searchParams.get('db');
    } else {
      let pathname = parsed.pathname;
      const hostname = (dummyHost ? '' : parsed.hostname).replace(/^\[(.+)\]$/, '$1');
      if (parsed.searchParams.get('host') && hostname && /^%2f/i.test(hostname))
        pathname = hostname + pathname;
      const path = pathname.slice(1) || null;
      database = path ? decode(path, decodeURI) : null;
    }
  }
  if (database) return { database, source: 'url', queryOverride };
  if (env.PGDATABASE) return { database: env.PGDATABASE, source: 'PGDATABASE', queryOverride };
  const fallbackUser = user || env.PGUSER || env.USER || env.USERNAME || null;
  return fallbackUser
    ? { database: fallbackUser, source: 'user', queryOverride }
    : { database: null, source: 'none', queryOverride };
}

/** The name the URL's path gives (decoded as pg decodes it), or '' when it gives none. */
export function databaseNameOf(url: string): string {
  const resolved = resolveDatabase(url, {});
  return resolved.source === 'url' ? (resolved.database ?? '') : '';
}

/** Why the command must not run, or null. */
export function refusalFor(
  url: string | undefined,
  allowRent: boolean,
  env: Env = process.env,
): string | null {
  if (!url) return 'DATABASE_URL is not set.';
  const resolved = resolveDatabase(url, env);
  if (resolved.queryOverride)
    return 'DATABASE_URL chooses its database in the query string; name it in the path only.';
  if (resolved.source !== 'url')
    return `DATABASE_URL names no database${
      resolved.source === 'none' ? '' : ` (it would fall back to ${resolved.source})`
    }; name one in the path.`;
  if (resolved.database!.trim().toLowerCase() === 'rent' && !allowRent)
    return `This database is named rent. Run against a copy or a scratch database, or, during an incident on rent itself, add --${ALLOW_RENT_FLAG}.`;
  return null;
}
