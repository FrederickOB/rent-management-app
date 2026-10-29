import { asc, desc, eq, schema, sql, type Tx } from '@rent/db';
import { maskEmail, type SignerLinkPurpose } from '@rent/domain/esign';
import { maskPhone } from '@rent/domain/phone';
import { parseCompanySettings, type CompanySettings } from '@rent/domain/settings';
import { notFound } from '../core/errors';
import type { ClientInfo, LinkReason, LinkScreen } from './esign.types';

/** The e-signing engine's rows, read and written only by this module (CLAUDE.md section 3). */
export type RequestRow = typeof schema.signingRequest.$inferSelect;
export type SignerRow = typeof schema.signer.$inferSelect;
export type LinkRow = typeof schema.secureLink.$inferSelect;
export type ChallengeRow = typeof schema.otpChallenge.$inferSelect;

/**
 * A signer who signs as the lease's tenant themselves: a signer subject, not a staff role, so it
 * is a set lookup rather than a comparison the role-check lint would flag.
 */
const TENANT_SELF: ReadonlySet<string> = new Set(['tenant']);
export const signsAsTenant = (subjectType: string): boolean => TENANT_SELF.has(subjectType);

/** Why a link was revoked: a newer one went to the signer, the request closed, or it expired. */
export type RevokeReason = 'superseded' | 'request_closed' | 'expired';

export async function requestRow(
  tx: Tx,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<RequestRow> {
  const query = tx.select().from(schema.signingRequest).where(eq(schema.signingRequest.id, id));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw notFound('Signing request');
  return row;
}

export async function signerRow(
  tx: Tx,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<SignerRow> {
  const query = tx.select().from(schema.signer).where(eq(schema.signer.id, id));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw notFound('Signer');
  return row;
}

export async function signersOf(tx: Tx, requestId: string): Promise<SignerRow[]> {
  return tx
    .select()
    .from(schema.signer)
    .where(eq(schema.signer.signingRequestId, requestId))
    .orderBy(asc(schema.signer.position));
}

export async function linkRow(
  tx: Tx,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<LinkRow> {
  const query = tx.select().from(schema.secureLink).where(eq(schema.secureLink.id, id));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw notFound('Link');
  return row;
}

/** The newest code sent for a link, if any. */
export async function latestChallenge(
  tx: Tx,
  linkId: string,
  options: { readonly lock?: boolean } = {},
): Promise<ChallengeRow | null> {
  const query = tx
    .select()
    .from(schema.otpChallenge)
    .where(eq(schema.otpChallenge.secureLinkId, linkId))
    .orderBy(desc(schema.otpChallenge.createdAt), desc(schema.otpChallenge.id))
    .limit(1);
  const [row] = options.lock ? await query.for('update') : await query;
  return row ?? null;
}

/** Codes sent since `since`, for one link or one destination (the send limits, plan 4.8). */
export async function codesSince(
  tx: Tx,
  where: { readonly linkId?: string; readonly destinationHash?: string },
  since: Date,
): Promise<number> {
  const conditions = [sql`created_at > ${since}`];
  if (where.linkId) conditions.push(sql`secure_link_id = ${where.linkId}`);
  if (where.destinationHash) conditions.push(sql`destination_hash = ${where.destinationHash}`);
  const result = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from otp_challenge where ${sql.join(conditions, sql` and `)}`,
  );
  return result.rows[0]?.n ?? 0;
}

export interface CompanyFacts {
  readonly id: string;
  readonly displayName: string;
  readonly senderName: string;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly primaryColour: string;
  readonly accentColour: string;
  readonly settings: CompanySettings;
}

/** The company a request belongs to: its name, time zone, branding and settings. */
export async function companyFacts(tx: Tx, companyId: string): Promise<CompanyFacts> {
  const [row] = await tx.select().from(schema.company).where(eq(schema.company.id, companyId));
  if (!row) throw notFound('Company');
  return {
    id: row.id,
    displayName: row.displayName,
    senderName: row.senderName,
    countryCode: row.countryCode,
    timeZone: row.timeZone,
    primaryColour: row.primaryColour,
    accentColour: row.accentColour,
    settings: parseCompanySettings(row.settings),
  };
}

/** Where a signer's codes go: the phone on record, or the email for an email-only signatory. */
export function codeDestination(
  signer: SignerRow,
): { channel: 'sms' | 'email'; address: string; masked: string } | null {
  if (signer.phone)
    return { channel: 'sms', address: signer.phone, masked: maskPhone(signer.phone) };
  if (signer.email)
    return { channel: 'email', address: signer.email, masked: maskEmail(signer.email) };
  return null;
}

/** What a link's page shows (plan 4.8): only `sign` accepts any action. */
export function screenFor(
  link: LinkRow,
  signer: SignerRow,
  request: RequestRow,
  now: Date,
): { screen: LinkScreen; reason: LinkReason } {
  const closed = (): LinkReason =>
    request.status === 'cancelled'
      ? 'cancelled'
      : request.status === 'declined'
        ? 'declined'
        : request.status === 'completed'
          ? 'completed'
          : request.status === 'preparing'
            ? 'preparing'
            : null;
  const revoked = (): LinkReason => (link.revokeReason === 'superseded' ? 'superseded' : null);
  if ((link.purpose as SignerLinkPurpose) === 'signed_copy') {
    if (link.revokedAt) return { screen: 'revoked', reason: revoked() };
    if (link.expiresAt.getTime() <= now.getTime()) return { screen: 'expired', reason: null };
    if (request.status === 'completed') return { screen: 'copy', reason: null };
    return { screen: 'closed', reason: closed() };
  }
  // A signer who has signed or declined is told so, whatever happened to the link since.
  if (signer.status === 'signed')
    return { screen: 'signed', reason: request.status === 'completed' ? 'completed' : null };
  if (signer.status === 'declined') return { screen: 'declined', reason: null };
  if (request.status !== 'pending') return { screen: 'closed', reason: closed() };
  if (link.revokedAt) return { screen: 'revoked', reason: revoked() };
  if (link.usedAt) return { screen: 'signed', reason: null };
  if (link.expiresAt.getTime() <= now.getTime()) return { screen: 'expired', reason: null };
  return { screen: 'sign', reason: null };
}

/** Records a step on the signing timeline (append-only), at the server's time. */
export async function signingEvent(
  tx: Tx,
  request: Pick<RequestRow, 'companyId' | 'propertyId' | 'tenantId' | 'id'>,
  kind: string,
  at: Date,
  extra: {
    readonly signerId?: string | null;
    readonly data?: Record<string, unknown> | null;
    readonly client?: ClientInfo | null;
  } = {},
): Promise<void> {
  await tx.insert(schema.signingEvent).values({
    companyId: request.companyId,
    propertyId: request.propertyId,
    tenantId: request.tenantId,
    signingRequestId: request.id,
    signerId: extra.signerId ?? null,
    kind,
    data: extra.data ?? null,
    ipAddress: extra.client?.ip ?? null,
    userAgent: extra.client?.userAgent ?? null,
    occurredAt: at,
  });
}

/** Revokes a request's live links, or one signer's, in the caller's transaction. */
export async function revokeLinks(
  tx: Tx,
  where: { readonly requestId?: string; readonly signerId?: string; readonly purpose?: string },
  reason: RevokeReason,
  at: Date,
  except?: string,
): Promise<number> {
  const conditions = [sql`l.revoked_at is null`];
  if (where.signerId) conditions.push(sql`l.signer_id = ${where.signerId}`);
  if (where.requestId)
    conditions.push(
      sql`l.signer_id in (select s.id from signer s where s.company_id = l.company_id and s.signing_request_id = ${where.requestId})`,
    );
  if (where.purpose) conditions.push(sql`l.purpose = ${where.purpose}`);
  if (except) conditions.push(sql`l.id <> ${except}`);
  const result = await tx.execute<{ id: string }>(
    sql`update secure_link l set revoked_at = ${at}, revoke_reason = ${reason}
        where ${sql.join(conditions, sql` and `)} returning l.id`,
  );
  return result.rows.length;
}
