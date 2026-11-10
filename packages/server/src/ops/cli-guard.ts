/**
 * The incident commands' guard (M11 decision 9): `pnpm ops:replay-webhooks` and `pnpm ops:redrive`
 * refuse a database named `rent` (the local development database, and the usual name in a
 * deployment) unless the operator says so with `--allow-rent-database`. A typo'd or forgotten
 * DATABASE_URL then cannot replay or retry anything by accident.
 */
export const ALLOW_RENT_FLAG = 'allow-rent-database';

export function databaseNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/** Why the command must not run, or null. */
export function refusalFor(url: string | undefined, allowRent: boolean): string | null {
  if (!url) return 'DATABASE_URL is not set.';
  const name = databaseNameOf(url);
  if (!name) return 'DATABASE_URL names no database.';
  if (name === 'rent' && !allowRent)
    return `This database is named rent. Run against a copy or a scratch database, or, during an incident on rent itself, add --${ALLOW_RENT_FLAG}.`;
  return null;
}
