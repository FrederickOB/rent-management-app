import { and, asc, eq, inArray, schema, sql, type Tx } from '@rent/db';
import { formatNoticeNumber } from '@rent/domain/notices';
import {
  NOTICE_EVENT_KINDS,
  NOTICE_TYPE_RULES,
  noticeChannelPlan,
  noticeProgress,
  servedElectronicallyBy,
  type NoticeChannelPlan,
  type NoticeCompletion,
  type NoticeConsentState,
  type NoticeEventFact,
  type NoticeEventKind,
  type NoticeProgress,
  type NoticeRecipientKind,
  type NoticeRecordKind,
  type NoticeStatus,
  type NoticeType,
} from '@rent/domain/notices';
import { parseCompanySettings, type CompanySettings } from '@rent/domain/settings';
import { notFound } from '../core/errors';
import type { TenantsService } from '../tenancy/tenants.service';

/** The notices module's rows, read and written only here (CLAUDE.md section 3). */
export type NoticeRow = typeof schema.notice.$inferSelect;
export type RecipientRow = typeof schema.noticeRecipient.$inferSelect;
export type NoticeEventRow = typeof schema.noticeEvent.$inferSelect;
export type ServiceRecordRow = typeof schema.serviceRecord.$inferSelect;
export type LeaseRow = typeof schema.lease.$inferSelect;

/** Jobs of the notices module (plan 4.12). */
export const NOTICE_LADDER_JOB = 'notices.ladder';
export const NOTICE_ESCALATE_JOB = 'notices.escalate';

export const numberOf = (row: Pick<NoticeRow, 'number'>): string | null =>
  row.number === null ? null : formatNoticeNumber(row.number);

export async function noticeRow(tx: Tx, id: string, lock = false): Promise<NoticeRow> {
  const query = tx.select().from(schema.notice).where(eq(schema.notice.id, id));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound('Notice');
  return row;
}

export async function recipientsOf(tx: Tx, noticeId: string): Promise<RecipientRow[]> {
  return tx
    .select()
    .from(schema.noticeRecipient)
    .where(eq(schema.noticeRecipient.noticeId, noticeId))
    .orderBy(asc(schema.noticeRecipient.position));
}

export async function eventsOf(tx: Tx, noticeId: string): Promise<NoticeEventRow[]> {
  return tx
    .select()
    .from(schema.noticeEvent)
    .where(eq(schema.noticeEvent.noticeId, noticeId))
    .orderBy(asc(schema.noticeEvent.occurredAt), asc(schema.noticeEvent.id));
}

/**
 * Records one event on the notice's timeline, server-timestamped. With a dedupe key it lands once:
 * returns false when it was already there (a retried job).
 */
export async function recordEvent(
  tx: Tx,
  notice: Pick<NoticeRow, 'companyId' | 'propertyId' | 'id' | 'tenantId'>,
  event: {
    readonly kind: NoticeRecordKind;
    readonly at: Date;
    readonly recipient?: Pick<RecipientRow, 'id' | 'tenantId'> | null;
    readonly channel?: string | null;
    readonly messageId?: string | null;
    readonly data?: Record<string, unknown> | null;
    readonly actorPersonId?: string | null;
    readonly dedupeKey?: string | null;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(schema.noticeEvent)
    .values({
      companyId: notice.companyId,
      propertyId: notice.propertyId,
      noticeId: notice.id,
      recipientId: event.recipient?.id ?? null,
      tenantId: event.recipient?.tenantId ?? notice.tenantId,
      kind: event.kind,
      channel: event.channel ?? null,
      messageId: event.messageId ?? null,
      data: event.data ?? null,
      actorPersonId: event.actorPersonId ?? null,
      occurredAt: event.at,
      dedupeKey: event.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.noticeEvent.id });
  return inserted.length > 0;
}

const STATE_KINDS: ReadonlySet<string> = new Set(NOTICE_EVENT_KINDS);

/** The state machine's facts from the timeline (plan 4.4). */
export const factsOf = (events: readonly NoticeEventRow[]): NoticeEventFact[] =>
  events
    .filter((e) => STATE_KINDS.has(e.kind))
    .map((e) => ({ kind: e.kind as NoticeEventKind, recipientId: e.recipientId }));

export const recipientRefs = (recipients: readonly RecipientRow[]) =>
  recipients.map((r) => ({ recipientId: r.id, party: r.tenantId }));

export function progressOf(
  notice: NoticeRow,
  recipients: readonly RecipientRow[],
  events: readonly NoticeEventRow[],
): NoticeProgress {
  return noticeProgress(
    factsOf(events),
    recipientRefs(recipients),
    notice.completion as NoticeCompletion,
  );
}

/**
 * Moves an issued notice's status to the furthest point its events reached (plan 4.4). Before
 * issue, after close and for a tenant's own notice the status is set by its transitions instead.
 */
export async function syncStatus(tx: Tx, notice: NoticeRow, now: Date): Promise<NoticeStatus> {
  const live = new Set([
    'sent',
    'delivered',
    'reminded',
    'opened',
    'escalated',
    'served',
    'signed',
  ]);
  if (!live.has(notice.status)) return notice.status as NoticeStatus;
  const progress = progressOf(
    notice,
    await recipientsOf(tx, notice.id),
    await eventsOf(tx, notice.id),
  );
  if (progress.status !== notice.status && live.has(progress.status))
    await tx
      .update(schema.notice)
      .set({ status: progress.status, updatedAt: now })
      .where(eq(schema.notice.id, notice.id));
  return progress.status;
}

export interface CompanyFacts {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly senderName: string;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly settings: CompanySettings;
}

export async function companyFacts(tx: Tx, companyId: string): Promise<CompanyFacts> {
  const [row] = await tx.select().from(schema.company).where(eq(schema.company.id, companyId));
  if (!row) throw notFound('Company');
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    senderName: row.senderName,
    countryCode: row.countryCode,
    timeZone: row.timeZone,
    settings: parseCompanySettings(row.settings),
  };
}

/** The lease names at least one phone or email for electronic service (prd-issues 25). */
export const hasServiceClause = (
  lease: Pick<LeaseRow, 'servicePhones' | 'serviceEmails'>,
): boolean => lease.servicePhones.length + lease.serviceEmails.length > 0;

/** A recipient as planned before issue: who, where, and each channel (decisions 4, 5 and 7). */
export interface PlannedRecipient {
  readonly kind: NoticeRecipientKind;
  readonly tenantId: string;
  readonly tenantContactId: string | null;
  readonly leaseId: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly name: string;
  readonly phone: string | null;
  readonly whatsappPhone: string | null;
  readonly email: string | null;
  readonly isTestContact: boolean;
  readonly channels: NoticeChannelPlan[];
  readonly physicalServicePlanned: boolean;
}

/** Leases a notice may go under: signed and not cancelled (a draft or a cancelled one, no). */
export const NOTICE_LEASE_STATUSES = [
  'signed',
  'active',
  'ending',
  'holding_over',
  'ended',
  'terminated',
];
/** Building-wide notices go to the current tenants (plan 4.2). */
const CURRENT_LEASE_STATUSES = ['signed', 'active', 'ending', 'holding_over'];

/**
 * The recipients a notice would go to now (decision 7): each residential tenant; every
 * authorised signatory of a company tenant (or the company itself, with none on record); and for a
 * building-wide notice, the current tenants of the property or blocks chosen. Each channel is
 * planned from the lease's electronic-service clause, the addresses and consent (decisions 4, 5).
 */
export async function planRecipients(
  tx: Tx,
  tenants: TenantsService,
  target:
    | { readonly kind: 'lease'; readonly lease: LeaseRow }
    | {
        readonly kind: 'property';
        readonly propertyId: string;
        readonly blockIds: readonly string[];
      },
): Promise<PlannedRecipient[]> {
  let leases: LeaseRow[];
  if (target.kind === 'lease') leases = [target.lease];
  else {
    leases = await tx
      .select()
      .from(schema.lease)
      .where(
        and(
          eq(schema.lease.propertyId, target.propertyId),
          inArray(schema.lease.status, CURRENT_LEASE_STATUSES),
          target.blockIds.length
            ? sql`${schema.lease.unitId} in (select u.id from unit u where u.company_id = ${schema.lease.companyId} and u.block_id = any(${`{${target.blockIds.join(',')}}`}::uuid[]))`
            : undefined,
        ),
      )
      .orderBy(asc(schema.lease.startDate));
  }
  const out: PlannedRecipient[] = [];
  const seenTenants = new Set<string>();
  for (const lease of leases) {
    if (seenTenants.has(lease.tenantId)) continue;
    seenTenants.add(lease.tenantId);
    const [tenant] = await tx
      .select()
      .from(schema.tenant)
      .where(eq(schema.tenant.id, lease.tenantId));
    if (!tenant) continue;
    const [unit] = await tx
      .select({ code: schema.unit.code })
      .from(schema.unit)
      .where(eq(schema.unit.id, lease.unitId));
    const signatories =
      tenant.kind === 'company'
        ? await tx
            .select()
            .from(schema.tenantContact)
            .where(
              and(
                eq(schema.tenantContact.tenantId, tenant.id),
                eq(schema.tenantContact.kind, 'signatory'),
                sql`${schema.tenantContact.archivedAt} is null`,
              ),
            )
            .orderBy(asc(schema.tenantContact.createdAt))
        : [];
    const people =
      signatories.length > 0
        ? signatories.map((c) => ({ kind: 'signatory' as const, contactId: c.id }))
        : [{ kind: 'tenant' as const, contactId: null }];
    for (const person of people) {
      const point = await tenants.messagingPoint(tx, {
        tenantId: tenant.id,
        contactId: person.contactId,
      });
      if (!point) continue;
      const consentOf = (channel: string): NoticeConsentState => {
        const latest = point.consent[channel];
        return latest ? (latest.action === 'grant' ? 'granted' : 'withdrawn') : 'none';
      };
      const whatsapp = point.whatsappPhone ?? point.phone;
      const channels = noticeChannelPlan({
        addresses: { whatsapp, sms: point.phone, email: point.email },
        namedInClause: {
          whatsapp: !!whatsapp && lease.servicePhones.includes(whatsapp),
          sms: !!point.phone && lease.servicePhones.includes(point.phone),
          email: !!point.email && lease.serviceEmails.includes(point.email),
        },
        consent: {
          whatsapp: consentOf('whatsapp'),
          sms: consentOf('sms'),
          email: consentOf('email'),
        },
      });
      out.push({
        kind: person.kind,
        tenantId: tenant.id,
        tenantContactId: person.contactId,
        leaseId: lease.id,
        unitId: lease.unitId,
        unitCode: unit?.code ?? '',
        name: point.name,
        phone: point.phone,
        whatsappPhone: whatsapp,
        email: point.email,
        isTestContact: point.isTestContact,
        channels,
        physicalServicePlanned: !servedElectronicallyBy(channels),
      });
    }
  }
  return out;
}

/**
 * Whether the notice is served electronically as a whole (decisions 4 and 5): the lease has the
 * clause and every party has a member with a channel it names (one is enough for a company tenant).
 */
export function servedElectronically(
  clause: boolean,
  recipients: readonly Pick<PlannedRecipient, 'tenantId' | 'physicalServicePlanned'>[],
): boolean {
  if (!clause || recipients.length === 0) return false;
  const parties = new Map<string, boolean>();
  for (const r of recipients)
    parties.set(r.tenantId, (parties.get(r.tenantId) ?? false) || !r.physicalServicePlanned);
  return [...parties.values()].every(Boolean);
}

/** Types whose fields set the notice's effective date column (the period types). */
export const effectiveDateOf = (
  type: NoticeType,
  fields: Record<string, unknown>,
): string | null =>
  NOTICE_TYPE_RULES[type].hasPeriod && typeof fields.effectiveDate === 'string'
    ? fields.effectiveDate
    : null;
