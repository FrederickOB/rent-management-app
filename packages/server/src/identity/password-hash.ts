import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { verifyPassword as verifyLegacyPassword } from 'better-auth/crypto';

/**
 * Password hashing (M11 review R1 F12; ASVS 11.4.2). scrypt from `node:crypto`, at OWASP's
 * minimum for scrypt: N=2^14, r=8, p=5. That row of OWASP's table (Password Storage Cheat Sheet)
 * needs 16 MiB per hash (128 × N × r), the least memory of the equivalent rows; the p lanes run one
 * after another in the same block. node:crypto runs scrypt on libuv's thread pool (4 threads by
 * default), so at most four hashes run at once: about 64 MiB at peak, whatever the sign-in load.
 * About 150 ms per hash on a laptop.
 *
 * Better Auth's default (N=2^14, r=16, p=1, below the minimum) is still verified, and a person's
 * hash is rewritten in the new form at their next successful sign-in (see `needsRehash`).
 */
export interface ScryptCost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const OWASP_SCRYPT: ScryptCost = { N: 2 ** 14, r: 8, p: 5 };
/**
 * Unit and integration tests only (NODE_ENV=test), so the hundreds of people the suites create stay
 * fast; the format and the code path are the same. Never used in development or production.
 */
export const TEST_SCRYPT: ScryptCost = { N: 2 ** 14, r: 8, p: 1 };

const KEY_LENGTH = 64;
const PREFIX = '$scrypt$';

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: cost.N, r: cost.r, p: cost.p, maxmem: 256 * cost.N * cost.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** `$scrypt$n=16384,r=8,p=5$<salt>$<key>`, base64 without padding (PHC string style). */
export async function hashPassword(password: string, cost: ScryptCost): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost);
  return `${PREFIX}n=${cost.N},r=${cost.r},p=${cost.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

interface Parsed {
  readonly cost: ScryptCost;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(hash: string): Parsed | null {
  if (!hash.startsWith(PREFIX)) return null;
  const [params = '', salt = '', key = ''] = hash.slice(PREFIX.length).split('$');
  const match = /^n=(\d+),r=(\d+),p=(\d+)$/.exec(params);
  if (!match || !salt || !key) return null;
  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Bounds keep a corrupted row from asking for gigabytes.
  if (!(
    N >= 2 ** 10 &&
    N <= 2 ** 20 &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= 32 &&
    p >= 1 &&
    p <= 16
  ))
    return null;
  return {
    cost: { N, r, p },
    salt: Buffer.from(salt, 'base64url'),
    key: Buffer.from(key, 'base64url'),
  };
}

/** Checks a password against a stored hash, in our form or Better Auth's older default. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const parsed = parse(hash);
  if (!parsed) {
    if (hash.startsWith(PREFIX)) return false;
    try {
      return await verifyLegacyPassword({ hash, password });
    } catch {
      return false;
    }
  }
  const key = await derive(password, parsed.salt, parsed.cost);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/** Whether a stored hash should be rewritten at the current cost: older form, or other parameters. */
export function needsRehash(hash: string, cost: ScryptCost): boolean {
  const parsed = parse(hash);
  return (
    !parsed || parsed.cost.N !== cost.N || parsed.cost.r !== cost.r || parsed.cost.p !== cost.p
  );
}
