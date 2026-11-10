import { sql, withSystem, type Database, type Tx } from '@rent/db';
import {
  addMonths,
  businessDateOf,
  compareDates,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { RETENTION_CATEGORIES, type RetentionCategory } from '@rent/domain/data-protection';
import { DomainError } from '@rent/domain/errors';
import type { ResolvedRule, RulesService } from '../rules/rules.service';

/**
 * Retention by category (M11 decision 5; CLAUDE.md sections 7 and 10). Each category of a
 * tenant's personal records has its own rules row; a record is anonymised only once that row is
 * verified and its period has passed. Until then it is held, with the date it is held until
 * (null while the rule has no verified value) and why. Nothing is deleted on a timer.
 *
 * When a period starts is this module's reading, for counsel to confirm (OQ-14, OQ-65):
 * - the tenancy (identity data, the profile): from the end of the tenant's last lease (its
 *   `ended_on`, else its end date; a cancelled lease from its cancellation), or from when the
 *   record was made if the tenant never had one; not at all while a lease is still running;
 * - financial and notice records: from the latest of the tenancy's end and the tenant's last
 *   invoice due date, payment, receipt or notice;
 * - messages: from the last message to or from the tenant;
 * - webhook bodies: from the last provider payment the tenant made;
 * - photos and recordings: from the latest of the tenancy's end and the last one the tenant sent;
 *   not at all while a lease is still running (repair photos can be evidence about the unit).
 *
 * Photos and recordings are the tenant's own: media attached to messages they (or their contacts)
 * sent in, and media they added to a repair report in the tenant app. Inspection photos taken by
 * staff at move-in or move-out are the landlord's record of the unit, held with the financial
 * and notice records, so they are not counted here.
 */

export const RETENTION_RULE_KEYS: Readonly<Record<RetentionCategory, string>> = {
  financial_and_notices: 'data_retention.financial_and_notices',
  messages: 'data_retention.other.messages',
  identity: 'data_retention.other.identity_data',
  webhook_bodies: 'data_retention.other.webhook_bodies',
  tenant_profile: 'data_retention.other.tenant_profile',
  photos_and_recordings: 'data_retention.other.photos_and_recordings',
};

const CATEGORY_WORDS: Readonly<Record<RetentionCategory, string>> = {
  financial_and_notices: 'Leases, invoices, payments, receipts and notices',
  messages: 'Messages',
  identity: 'ID and TIN numbers',
  webhook_bodies: 'Payment providers’ notifications',
  tenant_profile: 'Name, phone, email and contacts',
  photos_and_recordings: 'Photos, videos and voice notes they sent',
};

/** Lease states in which the tenancy is still running (or about to). */
export const LIVE_LEASE_STATUSES = [
  'pending_signatures',
  'signed',
  'active',
  'ending',
  'holding_over',
] as const;

/** A category's rule as of a day: its row, whether it is verified, and its period. */
export interface RetentionRule {
  readonly category: RetentionCategory;
  readonly ruleKey: string;
  readonly ruleId: string | null;
  readonly verified: boolean;
  /** The period in years, when the row has a value. */
  readonly years: number | null;
}

function ruleOf(category: RetentionCategory, resolved: ResolvedRule | null): RetentionRule {
  const value = resolved?.value as { years?: unknown } | null | undefined;
  const years =
    value && typeof value.years === 'number' && Number.isSafeInteger(value.years)
      ? value.years
      : null;
  return {
    category,
    ruleKey: RETENTION_RULE_KEYS[category],
    ruleId: resolved?.ruleId ?? null,
    verified: resolved?.verificationStatus === 'verified',
    years,
  };
}

/** Every category's rule for a country on a day, read in the caller's transaction (TX-08). */
export async function retentionRulesIn(
  tx: Tx,
  rules: RulesService,
  countryCode: string,
  asOf: string,
): Promise<Record<RetentionCategory, RetentionRule>> {
  const out = {} as Record<RetentionCategory, RetentionRule>;
  for (const category of RETENTION_CATEGORIES) {
    let resolved: ResolvedRule | null = null;
    try {
      resolved = await rules.resolveIn(
        tx,
        countryCode,
        RETENTION_RULE_KEYS[category],
        parseBusinessDate(asOf),
      );
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'rule.missing')) throw error;
    }
    out[category] = ruleOf(category, resolved);
  }
  return out;
}

/** What a tenant holds in each category, and when each period starts (see the module comment). */
export interface TenantRetentionFacts {
  readonly tenantId: string;
  readonly anonymisedAt: Date | null;
  /** A lease is still running: periods that run from the tenancy's end have not started. */
  readonly live: boolean;
  readonly tenancyEnd: string | null;
  readonly records: Readonly<Record<RetentionCategory, number>>;
  /** The day each category's period runs from; null while it has not started (or no records). */
  readonly from: Readonly<Record<RetentionCategory, string | null>>;
  /** The tenant's provider payment references, for their webhook bodies (system table). */
  readonly providerReferences: readonly string[];
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const dayOf = (v: Date | string | null, timeZone: string): string | null =>
  v === null ? null : toIsoDate(businessDateOf(instantFrom(asDate(v)), timeZone));
const latest = (...days: (string | null)[]): string | null =>
  days.reduce<string | null>(
    (best, d) =>
      d === null
        ? best
        : best === null || compareDates(parseBusinessDate(d), parseBusinessDate(best)) > 0
          ? d
          : best,
    null,
  );

type FactsRow = {
  tenant_id: string;
  created_at: Date | string;
  anonymised_at: Date | string | null;
  identity_values: number;
  contacts: number;
  live: boolean | null;
  leases: number | null;
  lease_ended_on: string | null;
  lease_cancelled_at: Date | string | null;
  invoices: number;
  last_due: string | null;
  payments: number;
  last_received: string | null;
  receipts: number;
  last_receipt_at: Date | string | null;
  notices: number;
  last_notice_on: string | null;
  messages: number;
  last_message_at: Date | string | null;
  provider_payments: number;
  last_provider_received: string | null;
  provider_references: string[] | null;
  media: number;
  last_media_at: Date | string | null;
};

/**
 * The retention facts of a company's tenants, or of one, in the caller's transaction (the
 * company's context). One query, so the nightly review costs one round trip per company.
 */
export async function tenantRetentionFactsIn(
  tx: Tx,
  timeZone: string,
  tenantId: string | null = null,
): Promise<TenantRetentionFacts[]> {
  const live = `{${LIVE_LEASE_STATUSES.join(',')}}`;
  const rows = await tx.execute<FactsRow>(
    sql`select t.id as tenant_id, t.created_at, t.anonymised_at,
          ((t.id_number_encrypted is not null)::int + (t.tin_encrypted is not null)::int) as identity_values,
          (select count(*) from tenant_contact c where c.tenant_id = t.id and c.anonymised_at is null)::int as contacts,
          l.live, l.leases, l.ended_on::text as lease_ended_on, l.cancelled_at as lease_cancelled_at,
          (select count(*) from invoice i where i.tenant_id = t.id)::int as invoices,
          (select max(i.due_date)::text from invoice i where i.tenant_id = t.id) as last_due,
          (select count(*) from payment p where p.tenant_id = t.id)::int as payments,
          (select max(p.received_on)::text from payment p where p.tenant_id = t.id) as last_received,
          (select count(*) from receipt r where r.tenant_id = t.id)::int as receipts,
          (select max(r.issued_at) from receipt r where r.tenant_id = t.id) as last_receipt_at,
          (select count(distinct n.id) from notice n
             where n.issued_at is not null
               and (n.tenant_id = t.id or exists (select 1 from notice_recipient nr
                                                  where nr.notice_id = n.id and nr.tenant_id = t.id)))::int as notices,
          (select max(n.issue_date)::text from notice n
             where n.issued_at is not null
               and (n.tenant_id = t.id or exists (select 1 from notice_recipient nr
                                                  where nr.notice_id = n.id and nr.tenant_id = t.id))) as last_notice_on,
          (select count(*) from message m where m.tenant_id = t.id)::int as messages,
          (select max(m.created_at) from message m where m.tenant_id = t.id) as last_message_at,
          (select count(*) from payment p where p.tenant_id = t.id and p.provider_reference is not null)::int as provider_payments,
          (select max(p.received_on)::text from payment p where p.tenant_id = t.id and p.provider_reference is not null) as last_provider_received,
          (select array_agg(distinct p.provider_reference) from payment p
             where p.tenant_id = t.id and p.provider_reference is not null) as provider_references,
          coalesce(media.n, 0)::int as media, media.last_at as last_media_at
        from tenant t
        left join lateral (
          select count(distinct x.document_id) as n, max(x.at) as last_at from (
            select a.document_id, a.created_at as at from message_attachment a
            join message m on m.company_id = a.company_id and m.id = a.message_id
            where m.tenant_id = t.id and m.direction = 'inbound' and a.document_id is not null
            union all
            select j.document_id, j.created_at as at from maintenance_job_attachment j
            join maintenance_job mj on mj.company_id = j.company_id and mj.id = j.job_id
            where mj.tenant_id = t.id and j.added_by_kind = 'tenant') x) media on true
        left join lateral (
          select bool_or(x.status = any(${live}::text[])) as live,
                 count(*) filter (where x.status <> 'draft')::int as leases,
                 max(coalesce(x.ended_on, x.end_date)) filter (where x.status in ('ended', 'terminated')) as ended_on,
                 max(x.cancelled_at) filter (where x.status = 'cancelled') as cancelled_at
          from lease x where x.tenant_id = t.id) l on true
        where ${tenantId}::uuid is null or t.id = ${tenantId}::uuid
        order by t.id`,
  );
  return rows.rows.map((r) => {
    const isLive = r.live === true;
    const tenancyEnd = isLive
      ? null
      : (latest(r.lease_ended_on, dayOf(r.lease_cancelled_at, timeZone)) ??
        dayOf(r.created_at, timeZone));
    const records: Record<RetentionCategory, number> = {
      financial_and_notices:
        Number(r.leases ?? 0) +
        Number(r.invoices) +
        Number(r.payments) +
        Number(r.receipts) +
        Number(r.notices),
      messages: Number(r.messages),
      identity: Number(r.identity_values),
      webhook_bodies: Number(r.provider_payments),
      tenant_profile: r.anonymised_at === null ? 1 + Number(r.contacts) : 0,
      photos_and_recordings: Number(r.media),
    };
    const lastFinancial = latest(
      r.last_due,
      r.last_received,
      dayOf(r.last_receipt_at, timeZone),
      r.last_notice_on,
    );
    return {
      tenantId: r.tenant_id,
      anonymisedAt: r.anonymised_at === null ? null : asDate(r.anonymised_at),
      live: isLive,
      tenancyEnd,
      records,
      from: {
        financial_and_notices: isLive ? null : latest(tenancyEnd, lastFinancial),
        messages: dayOf(r.last_message_at, timeZone),
        identity: tenancyEnd,
        webhook_bodies: r.last_provider_received,
        tenant_profile: tenancyEnd,
        photos_and_recordings: isLive ? null : latest(tenancyEnd, dayOf(r.last_media_at, timeZone)),
      },
      providerReferences: r.provider_references ?? [],
    };
  });
}

/** The webhook bodies still stored for a tenant's provider payments (a system table, ADR-002). */
export async function webhookBodiesFor(
  database: Database,
  references: readonly string[],
): Promise<number> {
  if (references.length === 0) return 0;
  const list = sql.join(
    references.map((r) => sql`${r}`),
    sql`, `,
  );
  const rows = await withSystem(database, {}, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from webhook_inbox
          where raw_body is not null and reference in (${list})`,
    ),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

/** What happens to a category of a tenant's records under its rule (decision 5). */
export type CategoryDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'anonymise'; readonly records: number }
  | {
      readonly kind: 'held';
      readonly records: number;
      readonly until: string | null;
      readonly reason: string;
    };

/** The day a period ends: `from` plus whole years (the rule's unit). */
export const retainedUntil = (from: string, years: number): string =>
  toIsoDate(addMonths(parseBusinessDate(from), years * 12));

/**
 * Whether a category may be anonymised today: only with records, a verified rule with a value,
 * a period that has started, and has passed. Everything else is held, saying why.
 */
export function decide(
  rule: RetentionRule,
  records: number,
  from: string | null,
  today: string,
  live: boolean,
): CategoryDecision {
  if (records === 0) return { kind: 'none' };
  const what = CATEGORY_WORDS[rule.category];
  if (!rule.verified || rule.years === null)
    return {
      kind: 'held',
      records,
      until: null,
      reason:
        rule.years === null
          ? `${what} are kept: the retention period (${rule.ruleKey}) has no value yet and counsel has not confirmed one (OQ-14).`
          : `${what} are kept: the retention period (${rule.ruleKey}) is not verified by counsel yet (OQ-14).`,
    };
  if (from === null)
    return {
      kind: 'held',
      records,
      until: null,
      reason: live
        ? `${what} are kept while a lease is running; the ${rule.years}-year period (${rule.ruleKey}) runs from the tenancy's end.`
        : `${what} are kept: the start of their ${rule.years}-year period (${rule.ruleKey}) is not known.`,
    };
  const until = retainedUntil(from, rule.years);
  if (compareDates(parseBusinessDate(today), parseBusinessDate(until)) < 0)
    return {
      kind: 'held',
      records,
      until,
      reason: `${what} are kept for ${rule.years} years from ${from} (${rule.ruleKey}).`,
    };
  return { kind: 'anonymise', records };
}

/**
 * Categories whose records cannot change in place (CLAUDE.md section 6: messages, payments,
 * receipts, issued notices and their snapshots are immutable; webhook bodies are written only by
 * the intake; photos and recordings are documents, stored write-once). Past their period they
 * stay held until a database path exists (M11 section 9).
 */
export const NO_DATABASE_PATH: Readonly<Partial<Record<RetentionCategory, string>>> = {
  financial_and_notices:
    'Past their retention period, but leases, invoices, payments, receipts and notices are never changed in place; anonymising the names and contacts copied onto them needs a database change that does not exist yet.',
  messages:
    'Past their retention period, but messages are never edited; anonymising their text needs a database change that does not exist yet.',
  webhook_bodies:
    'Past their retention period, but payment providers’ notifications are kept as received; clearing their bodies needs a database change that does not exist yet.',
  photos_and_recordings:
    'Past their retention period, but photos, videos and voice notes are stored write-once; removing them needs a database and storage change that does not exist yet.',
};

/**
 * Anonymises the tenant's profile in place (decision 5): name, phone, WhatsApp, email,
 * occupation, company details, notes and the tenant app link, and every contact's name and
 * details. The rows stay, so leases, money and notices still refer to them; `anonymised_at` is set
 * once (RA126). Returns the records changed.
 */
export async function anonymiseProfileIn(tx: Tx, tenantId: string): Promise<number> {
  const contacts = await tx.execute<{ id: string }>(
    sql`update tenant_contact set name = 'Anonymised contact', phone = null, email = null,
          relationship = null, organisation = null, position = null, notes = null,
          anonymised_at = now(), updated_at = now()
        where tenant_id = ${tenantId}::uuid and anonymised_at is null
        returning id`,
  );
  const tenant = await tx.execute<{ id: string }>(
    sql`update tenant set display_name = 'Anonymised tenant', legal_name = null, phone = null,
          whatsapp_phone = null, email = null, occupation = null, business_type = null,
          registration_number = null, notes = null, person_id = null,
          anonymised_at = now(), updated_at = now()
        where id = ${tenantId}::uuid and anonymised_at is null
        returning id`,
  );
  return tenant.rows.length + contacts.rows.length;
}

/**
 * Clears the tenant's identity data (decision 5): the encrypted ID and TIN numbers, their blind
 * indexes and masks. The identity checks keep only their status and the provider's check id.
 */
export async function anonymiseIdentityIn(tx: Tx, tenantId: string): Promise<number> {
  const before = await tx.execute<{ n: number }>(
    sql`select ((id_number_encrypted is not null)::int + (tin_encrypted is not null)::int) as n
        from tenant where id = ${tenantId}::uuid`,
  );
  await tx.execute(
    sql`update tenant set id_type = null, id_number_encrypted = null, id_number_index = null,
          id_number_masked = null, id_status = 'none', id_verified_at = null,
          tin_encrypted = null, tin_index = null, tin_masked = null, updated_at = now()
        where id = ${tenantId}::uuid
          and (id_number_encrypted is not null or tin_encrypted is not null)`,
  );
  return Number(before.rows[0]?.n ?? 0);
}

/** The categories in the order they are worked through and shown. */
export const CATEGORY_ORDER: readonly RetentionCategory[] = RETENTION_CATEGORIES;
