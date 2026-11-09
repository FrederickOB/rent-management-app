import { and, eq, schema, withSystem, type Database } from '@rent/db';
import type { Auth } from '../identity/auth';
import type { PersonAccounts } from '../identity/person-accounts';

/**
 * The first admin of a new company, and of the platform (M10 decision 14), invited as staff are
 * invited (M1): the person with that email, or a new one (sign-up is off, so PersonAccounts is the
 * only way a person comes to exist), and the set-password email Better Auth's reset flow sends,
 * which links to the web's accept-invite page. Emails are never logged.
 */
export async function personForEmail(
  database: Database,
  accounts: Pick<PersonAccounts, 'create'>,
  input: { readonly name: string; readonly email: string },
): Promise<{ readonly personId: string; readonly created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const found = await withSystem(database, {}, (tx) =>
    tx.select({ id: schema.person.id }).from(schema.person).where(eq(schema.person.email, email)),
  );
  if (found[0]) return { personId: found[0].id, created: false };
  const { personId } = await accounts.create({ name: input.name.trim(), email });
  return { personId, created: true };
}

/** Whether the person has set a password yet (an invitation still waiting otherwise). */
export async function hasPassword(database: Database, personId: string): Promise<boolean> {
  const rows = await withSystem(database, {}, (tx) =>
    tx
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, personId), eq(schema.account.providerId, 'credential'))),
  );
  return rows.length > 0;
}

/** Sends the set-password invitation staff invitations use (MembershipsService.invite). */
export function invitationSender(auth: Auth, webOrigin: string) {
  return async (email: string): Promise<void> => {
    await auth.api.requestPasswordReset({
      body: { email: email.trim().toLowerCase(), redirectTo: `${webOrigin}/accept-invite` },
    });
  };
}
