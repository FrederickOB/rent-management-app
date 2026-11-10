import { and, eq, isNull, lt, or, schema, withSystem, type Database } from '@rent/db';
import { symmetricDecrypt } from 'better-auth/crypto';
import { verify } from 'otplib';

/**
 * TOTP checks outside Better Auth's own endpoints, and the replay guard both share (M11 review R1
 * F4 and F9; ASVS 6.5.1: a time-based code is accepted once).
 */

const BASE32_PREFIX = 'base32:';

/** The person's TOTP secret as an authenticator holds it (RFC 4648 base32), or null. */
export async function totpSecretOf(
  database: Database,
  secretKey: string,
  personId: string,
): Promise<string | null> {
  const [row] = await withSystem(database, { personId }, (tx) =>
    tx
      .select({ secret: schema.twoFactor.secret, verified: schema.twoFactor.verified })
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, personId)),
  );
  if (!row || row.verified === false) return null;
  const raw = await symmetricDecrypt({ key: secretKey, data: row.secret });
  // Better Auth stores generated secrets raw and imported ones as `base32:<secret>`.
  return raw.startsWith(BASE32_PREFIX)
    ? raw.slice(BASE32_PREFIX.length).toUpperCase()
    : base32(raw);
}

/**
 * The time step a code belongs to, one step either side of now as Better Auth allows, or null when
 * it matches none.
 */
export async function totpStepOf(secret: string, code: string): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const result = await verify({ secret, token: code, epochTolerance: 30 });
  if (!result.valid) return null;
  // otplib's TOTP result carries the step it matched (its functional type is shared with HOTP).
  const matched = result as { timeStep?: number; epoch?: number };
  return matched.timeStep ?? Math.floor((matched.epoch ?? 0) / 30);
}

/**
 * Records `step` as the person's last accepted TOTP step, only if it is later than the last one.
 * Concurrent claims of the same step take turns on the row, so exactly one succeeds: a code is
 * never accepted twice, and a code from an earlier step never after a later one.
 */
export async function claimTotpStep(
  database: Database,
  personId: string,
  step: number,
): Promise<boolean> {
  const rows = await withSystem(database, { personId }, (tx) =>
    tx
      .update(schema.twoFactor)
      .set({ lastTotpStep: step })
      .where(
        and(
          eq(schema.twoFactor.userId, personId),
          or(isNull(schema.twoFactor.lastTotpStep), lt(schema.twoFactor.lastTotpStep, step)),
        ),
      )
      .returning({ id: schema.twoFactor.id }),
  );
  return rows.length > 0;
}

/** Better Auth stores the raw secret; authenticators (and otplib) use its RFC 4648 base32 form. */
export function base32(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text, 'utf8')) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
