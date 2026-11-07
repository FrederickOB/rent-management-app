import { sql, type Tx } from '@rent/db';
import { instantFrom } from '@rent/domain/dates';
import type { ConsentFacts } from '@rent/domain/messaging';

/**
 * Owners and email (M9 review; CLAUDE.md section 8, CM-09). Owners have no consent register: as
 * for M4b's settlement alerts, the address in the owner's register is the consent for messages
 * about their own money, including the monthly statement (`owner_statement`). An opt-out is
 * always honoured. The one an owner can make today is a spam complaint against an email we sent
 * them, which the email provider reports (Postmark's SpamComplaint, recorded as a failed email
 * with reason `spam_complaint`); the provider also refuses to send to an address it has marked
 * inactive. Owner emails carry no unsubscribe link yet: unsubscribe links belong to tenants.
 */

/** When the owner last opted out of email, or null: never. Read in the caller's transaction. */
export async function ownerEmailOptOutAt(tx: Tx, ownerId: string): Promise<Date | null> {
  const rows = await tx.execute<{ at: Date | string | null }>(
    sql`select max(e.occurred_at) as at
        from message m
        join message_event e on e.company_id = m.company_id and e.message_id = m.id
        where m.owner_id = ${ownerId}::uuid and e.status = 'failed' and e.channel = 'email'
          and e.reason = 'spam_complaint'`,
  );
  const at = rows.rows[0]?.at ?? null;
  return at === null ? null : at instanceof Date ? at : new Date(at);
}

/**
 * The owner's email consent as the send job reads it: withdrawn from an opt-out on; otherwise
 * undefined, so the address on record counts as consent (the recipient's `consented` set).
 */
export async function ownerEmailConsent(
  tx: Tx,
  ownerId: string,
): Promise<{ readonly email?: ConsentFacts }> {
  const optedOut = await ownerEmailOptOutAt(tx, ownerId);
  return optedOut ? { email: { latest: { action: 'withdraw', at: instantFrom(optedOut) } } } : {};
}
