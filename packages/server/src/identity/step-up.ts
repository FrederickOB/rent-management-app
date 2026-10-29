import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, withSystem, type Database } from '@rent/db';
import { symmetricDecrypt } from 'better-auth/crypto';
import { verify } from 'otplib';
import type { AppConfig } from '../core/config';
import { CONFIG, DATABASE } from '../core/tokens';

/**
 * Step-up confirmation with the person's own TOTP code, for sensitive actions such as a
 * single-user landlord self-confirming an approval after cooling off (OQ-29).
 */
@Injectable()
export class StepUpVerifier {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async verifyTotp(personId: string, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const [row] = await withSystem(this.database, { personId }, (tx) =>
      tx
        .select({ secret: schema.twoFactor.secret, verified: schema.twoFactor.verified })
        .from(schema.twoFactor)
        .where(eq(schema.twoFactor.userId, personId)),
    );
    if (!row || row.verified === false) return false;
    const raw = await symmetricDecrypt({ key: this.config.BETTER_AUTH_SECRET, data: row.secret });
    const result = await verify({ secret: base32(raw), token: code, epochTolerance: 30 });
    return result.valid;
  }
}

/** Better Auth stores the raw secret; authenticators (and otplib) use its RFC 4648 base32 form. */
function base32(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text, 'utf8')) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
