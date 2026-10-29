import { Inject, Injectable } from '@nestjs/common';
import { normalisePhone } from '@rent/domain/phone';
import { v7 as uuidv7 } from 'uuid';
import { conflict } from '../core/errors';
import { AUTH } from '../core/tokens';
import type { Auth } from './auth';

/** Phone-only people get an address on the reserved `.invalid` domain, which is never sent to. */
export const placeholderEmail = (personId: string) => `phone-${personId}@users.invalid`;
export const isPlaceholderEmail = (email: string) => email.endsWith('@users.invalid');

export interface NewPerson {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  /** Staff who sign in with email and password. Never set for tenants or caretakers. */
  readonly password?: string;
  readonly isTestContact?: boolean;
}

/**
 * Creates people in Better Auth's tables. Sign-up is disabled (landlords and agencies add
 * people), so this is the only way a person comes to exist: the seed, invites (M1) and tenant
 * records (M3) all go through it.
 */
@Injectable()
export class PersonAccounts {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async create(input: NewPerson): Promise<{ personId: string }> {
    const ctx = await this.auth.$context;
    const id = uuidv7();
    const phone = input.phone ? normalisePhone(input.phone) : undefined;
    const email = (input.email ?? placeholderEmail(id)).toLowerCase();
    if (await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: false }))
      throw conflict('person_exists', 'Someone with that email already exists');
    const user = await ctx.internalAdapter.createUser(
      {
        id,
        name: input.name,
        email,
        emailVerified: false,
        ...(phone ? { phoneNumber: phone, phoneNumberVerified: false } : {}),
        isTestContact: input.isTestContact ?? false,
      },
      { method: 'admin' },
    );
    if (input.password) {
      await ctx.internalAdapter.linkAccount({
        userId: user.id,
        providerId: 'credential',
        accountId: user.id,
        password: await ctx.password.hash(input.password),
      });
    }
    return { personId: user.id };
  }
}
