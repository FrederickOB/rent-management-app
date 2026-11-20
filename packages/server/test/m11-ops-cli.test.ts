import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { databaseNameOf, refusalFor, resolveDatabase } from '../src/ops/cli-guard';

/**
 * M11 decision 9: the incident commands (`pnpm ops:replay-webhooks`, `pnpm ops:redrive`) refuse a
 * database named `rent` unless --allow-rent-database is given, before anything reads the
 * configuration or connects. The commands are run for real here, against a `rent` URL on a port
 * nothing listens on, so a command that got past its guard would fail differently.
 */
const SERVER = path.resolve(import.meta.dirname, '..');
const TSX = path.resolve(SERVER, 'node_modules/.bin/tsx');
const RENT_URL = 'postgres://rent_app:nothing@127.0.0.1:1/rent';

function run(script: string, args: string[], databaseUrl: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (databaseUrl === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = databaseUrl;
  return spawnSync(TSX, ['--tsconfig', 'tsconfig.runtime.json', `scripts/${script}`, ...args], {
    cwd: SERVER,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

const ARGS = ['--operator', 'ops@example.invalid', '--reason', 'Incident 812, replaying the day'];

describe('NFR-AVAIL the incident commands never run against rent by accident (M11 decision 9)', () => {
  it('reads the database name from the URL', () => {
    expect(databaseNameOf(RENT_URL)).toBe('rent');
    expect(databaseNameOf('postgres://u@h:5432/rent_scratch_ops?sslmode=disable')).toBe(
      'rent_scratch_ops',
    );
    expect(databaseNameOf('not a url')).toBe('');
  });

  it('refuses rent without the flag, a missing URL and a URL without a database; allows the rest', () => {
    expect(refusalFor(RENT_URL, false)).toMatch(/named rent.*--allow-rent-database/);
    expect(refusalFor(RENT_URL, true)).toBeNull();
    expect(refusalFor(undefined, false)).toMatch(/not set/);
    expect(refusalFor('postgres://u@h:5432/', false)).toMatch(/names no database/);
    expect(refusalFor('postgres://u@h:5432/rent_scratch_ops', false)).toBeNull();
    expect(refusalFor('postgres://u@h:5432/rent_copy', false)).toBeNull();
  });

  it.each([
    ['ops-replay-webhooks.ts', [...ARGS, '--id', '01a1c53a-5f51-751a-8837-94f325d10099']],
    ['ops-redrive.ts', [...ARGS, '--queue', 'billing.accrue.company']],
  ])(
    '%s exits before connecting when the database is rent',
    (script, args) => {
      const refused = run(script, args, RENT_URL);
      expect(refused.status, refused.stderr).toBe(2);
      expect(refused.stderr).toMatch(/refused: This database is named rent/);
      // The operator's email is never printed.
      expect(`${refused.stdout}${refused.stderr}`).not.toContain('ops@example.invalid');
      const unset = run(script, args, undefined);
      expect(unset.status).toBe(2);
      expect(unset.stderr).toMatch(/DATABASE_URL is not set/);
    },
    60_000,
  );

  it('asks for a reason and an operator before anything else', () => {
    const scratch = 'postgres://rent_app:nothing@127.0.0.1:1/rent_scratch_ops';
    const noReason = run(
      'ops-redrive.ts',
      ['--operator', 'ops@example.invalid', '--queue', 'x'],
      scratch,
    );
    expect(noReason.status).toBe(2);
    expect(noReason.stderr).toMatch(/--reason is required/);
    const noOperator = run(
      'ops-replay-webhooks.ts',
      ['--reason', 'Incident 812 replay', '--id', 'x'],
      scratch,
    );
    expect(noOperator.status).toBe(2);
    expect(noOperator.stderr).toMatch(/--operator is required/);
  }, 60_000);
});

describe('NFR-AVAIL ops:reconcile has the same guard (M11 follow-up)', () => {
  it('refuses rent before connecting, and asks for a day, a reason and an operator', () => {
    const args = [...ARGS, '--day', '2026-11-09'];
    const refused = run('ops-reconcile.ts', args, RENT_URL);
    expect(refused.status, refused.stderr).toBe(2);
    expect(refused.stderr).toMatch(/ops:reconcile refused: This database is named rent/);
    expect(`${refused.stdout}${refused.stderr}`).not.toContain('ops@example.invalid');
    const scratch = 'postgres://rent_app:nothing@127.0.0.1:1/rent_scratch_ops';
    const noDay = run('ops-reconcile.ts', ARGS, scratch);
    expect(noDay.status).toBe(2);
    expect(noDay.stderr).toMatch(/--day is required/);
    const noReason = run(
      'ops-reconcile.ts',
      ['--operator', 'ops@example.invalid', '--day', '2026-11-09'],
      scratch,
    );
    expect(noReason.status).toBe(2);
    expect(noReason.stderr).toMatch(/--reason is required/);
  }, 60_000);
});

describe('NFR-AVAIL the rent guard reads the database as node-postgres does (M11 review B, hardening)', () => {
  const env = {};
  it.each([
    ['a socket host in the query', 'postgres:///rent?host=/var/run/postgresql'],
    ['an encoded socket host', 'postgresql://%2Fvar%2Frun%2Fpostgresql/rent'],
    ['a socket: URL', 'socket:/var/run/postgresql?db=rent'],
    ['a bare socket path', '/var/run/postgresql rent'],
    ['a percent-encoded name', 'postgres://u@h:5432/%72ent'],
    ['an empty host', 'postgres://u@/rent'],
    ['another case', 'postgres://u@h/Rent'],
  ])('refuses rent named through %s', (_label, url) => {
    expect(resolveDatabase(url, env)).toMatchObject({ database: expect.stringMatching(/^rent$/i) });
    expect(refusalFor(url, false, env)).toMatch(/named rent/);
    expect(refusalFor(url, true, env)).toBeNull();
  });

  it('refuses a database chosen in the query string, whatever the path says', () => {
    for (const url of [
      'postgres://u@h/scratch?dbname=rent',
      'postgres://u@h/rent_scratch_ops?database=rent',
      'postgres://u@h/?database=rent',
      'postgres://u@h/rent_scratch_ops?service=prod',
    ])
      expect(refusalFor(url, true, env), url).toMatch(/query string/);
  });

  it('refuses a URL that names no database, which would fall back to PGDATABASE or the user', () => {
    expect(resolveDatabase('postgres://rent@h/', {})).toMatchObject({
      database: 'rent',
      source: 'user',
    });
    expect(resolveDatabase('postgres://u@h/', { PGDATABASE: 'rent' })).toMatchObject({
      database: 'rent',
      source: 'PGDATABASE',
    });
    expect(refusalFor('postgres://u@h/', false, { PGDATABASE: 'rent' })).toMatch(
      /fall back to PGDATABASE/,
    );
    expect(refusalFor('postgres://rent@h/', true, {})).toMatch(/fall back to user/);
    expect(refusalFor('mysql://u@h/rent_scratch', false, {})).toMatch(/names no database/);
    // PGDATABASE never overrides a database named in the path, as in pg.
    expect(refusalFor('postgres://u@h/rent_scratch_ops', false, { PGDATABASE: 'rent' })).toBeNull();
  });

  it('refuses before anything loads, in well under a second of the command’s own time', () => {
    const started = Date.now();
    const refused = run(
      'ops-redrive.ts',
      [...ARGS, '--queue', 'q'],
      'postgres://u@/%72ent?host=/tmp',
    );
    expect(refused.status, refused.stderr).toBe(2);
    expect(refused.stderr).toMatch(/named rent/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});
