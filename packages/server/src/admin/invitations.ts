import { and, eq, schema, withSystem, type Database } from '@rent/db';
import type { EmailPort } from '@rent/integrations';
import type { AppConfig } from '../core/config';
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

/**
 * M11 founder D2 (security review R2 F3): a first admin who was already on the platform, found by
 * email, is `invited` until they accept from a session that proved that email (their password and
 * authenticator: /me/invitations); a person made for this invitation is `active` at once, and
 * proves the address by using the set-password link.
 */
export const firstAdminStatus = (person: { readonly created: boolean }): 'active' | 'invited' =>
  person.created ? 'active' : 'invited';

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

/**
 * M11 founder D2: tells someone who can already sign in that a new company's first-admin role is
 * waiting for them to accept (they need no set-password link). The email is never logged.
 */
export function acceptanceNotice(
  email: EmailPort,
  config: Pick<AppConfig, 'APP_NAME' | 'WEB_ORIGIN'>,
) {
  return async (to: string, companyName: string): Promise<void> => {
    await email.send({
      to: to.trim().toLowerCase(),
      subject: `${config.APP_NAME}: an invitation to run ${companyName}`,
      text: `You were made the first admin of ${companyName} on ${config.APP_NAME}. Sign in at ${config.WEB_ORIGIN} with your password and authenticator app, and accept the invitation to start.\n\nIf you did not expect this email, you can ignore it.`,
    });
  };
}
