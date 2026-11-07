import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  isNull,
  ne,
  or,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  consentText,
  CURRENT_CONSENT_TEXT,
  MESSAGE_CHANNELS,
  type MessageChannel,
} from '@rent/domain/messaging';
import { normalisePhone } from '@rent/domain/phone';
import type { Actor } from '@rent/domain/policy';
import {
  checkIdNumber,
  checkTin,
  maskIdNumber,
  type IdType,
  type LeaseStatus,
} from '@rent/domain/tenancy';
import { v7 as uuidv7 } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { staffActor, type StaffActor } from '../companies/companies.service';
import type { FieldCipher } from '../core/crypto/field-cipher';
import { sqlStateOf } from '../core/db-errors';
import { conflict, invalid, notFound } from '../core/errors';
import { DATABASE, FIELD_CIPHER } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';
import type {
  ConsentState,
  ContactInput,
  ContactKind,
  ContactView,
  DuplicateWarning,
  IdCheckView,
  IdStatus,
  LeaseSummary,
  TenantDetail,
  TenantInput,
  TenantKind,
  TenantLimitedView,
  TenantPatch,
  TenantView,
  TimelineEvent,
} from './tenancy.types';

type TenantRow = typeof schema.tenant.$inferSelect;

/** Events another module adds to a tenant's timeline, read in the caller's transaction. */
export type TimelineSource = (
  tx: Tx,
  tenantId: string,
  /** M7: the reader too, so a source can show its data only to those allowed to read it. */
  options: { readonly detailed: boolean; readonly actor?: Actor },
) => Promise<TimelineEvent[]>;
type ContactRow = typeof schema.tenantContact.$inferSelect;

/** A person's addresses and consent, for the messaging core (CM-09). */
export interface ContactPoint {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly consented: ReadonlySet<MessageChannel>;
  readonly isTestContact: boolean;
  readonly propertyId: string | null;
}

/** M6: the same, on every channel, with each channel's latest consent event. */
export interface MessagingPoint extends ContactPoint {
  readonly whatsappPhone: string | null;
  /** The tenant's person, for push and the app; null for a contact. */
  readonly personId: string | null;
  /** The contact's kind (signatory, finance, guarantor…); null for the tenant. */
  readonly contactKind: string | null;
  readonly consent: Readonly<
    Record<
      string,
      {
        readonly action: 'grant' | 'withdraw';
        readonly at: Date;
        readonly source: string;
        /** The consent text's version: `address_changed.v1` for the decision 8 reset. */
        readonly textVersion: string;
      }
    >
  >;
}

/** Leases in these states put the tenant in a unit (the units shown with a tenant). */
const HOLDING: readonly LeaseStatus[] = ['signed', 'active', 'ending', 'holding_over'];
export const REVEAL_REASON_MIN_LENGTH = 10;

const text = (value: string | null | undefined, max: number, what = 'text'): string | null => {
  const v = value?.trim();
  if (!v) return null;
  if (v.length > max) throw invalid(`${what}_too_long`, `Use at most ${max} characters`);
  return v;
};

const phoneOf = (value: string | null | undefined): string | null =>
  value?.trim() ? normalisePhone(value) : null;

function emailOf(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    throw invalid('email_invalid', 'Enter a valid email address');
  return v;
}

function nameOf(value: string, what = 'tenant'): string {
  const v = value.trim();
  if (v.length < 2 || v.length > 160) throw invalid(`${what}_name`, 'Enter the full name');
  return v;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const noConsent = (): ConsentState => ({ sms: false, email: false });

/**
 * Tenants (TL-01 to TL-04; M3 plan 4.3 and 4.4). One record per company, linked by phone to a
 * global person so the tenant app shows every tenancy. ID numbers and TINs are encrypted with the
 * field cipher, blind-indexed for duplicate checks and masked; revealing one needs a permission
 * and a reason and is audited. A caretaker sees only a tenant's name, phone and units.
 */
@Injectable()
export class TenantsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // Reading ------------------------------------------------------------------------------------

  async list(
    actor: Actor | null,
    filters: {
      readonly search?: string;
      readonly kind?: TenantKind;
      readonly withActiveLease?: boolean;
      readonly idStatus?: IdStatus;
      readonly includeArchived?: boolean;
    } = {},
  ): Promise<(TenantView | TenantLimitedView)[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.view');
    const detailed = this.policy.can(staff, 'tenant.view_details').allowed;
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const t = schema.tenant;
      const where = [
        filters.includeArchived ? undefined : isNull(t.archivedAt),
        filters.kind ? eq(t.kind, filters.kind) : undefined,
        filters.idStatus && detailed ? eq(t.idStatus, filters.idStatus) : undefined,
        filters.withActiveLease
          ? sql`exists (select 1 from lease l where l.company_id = tenant.company_id and l.tenant_id = tenant.id
              and l.status in ('active', 'ending', 'holding_over'))`
          : undefined,
        filters.search?.trim()
          ? or(
              sql`${t.displayName} ilike ${like(filters.search.trim())}`,
              sql`${t.phone} like ${like(filters.search.replace(/\s/g, ''))}`,
              sql`exists (select 1 from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
                where l.company_id = tenant.company_id and l.tenant_id = tenant.id and u.code ilike ${like(filters.search.trim())})`,
            )
          : undefined,
      ].filter((c) => c !== undefined);
      const rows = await tx
        .select({ tenant: t, units: unitsOf() })
        .from(t)
        .where(and(...where))
        .orderBy(asc(t.displayName))
        .limit(500);
      if (!detailed) return rows.map((r) => limitedView(r.tenant, r.units));
      const consent = await this.consentFor(
        tx,
        rows.map((r) => r.tenant.id),
      );
      return rows.map((r) =>
        fullView(r.tenant, r.units, consent.get(key(r.tenant.id)) ?? noConsent()),
      );
    });
  }

  async get(actor: Actor | null, tenantId: string): Promise<TenantDetail | TenantLimitedView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.view');
    const detailed = this.policy.can(staff, 'tenant.view_details').allowed;
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select({ tenant: schema.tenant, units: unitsOf() })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, tenantId));
      if (!row) throw notFound('Tenant');
      if (!detailed) return limitedView(row.tenant, row.units);
      const contacts = await tx
        .select()
        .from(schema.tenantContact)
        .where(eq(schema.tenantContact.tenantId, tenantId))
        .orderBy(asc(schema.tenantContact.createdAt));
      const consent = await this.consentFor(tx, [tenantId]);
      const leases = await tx.execute<{
        id: string;
        status: LeaseStatus;
        unit_code: string;
        start_date: string;
        end_date: string;
      }>(
        sql`select l.id, l.status, u.code as unit_code, l.start_date, l.end_date from lease l
            join unit u on u.company_id = l.company_id and u.id = l.unit_id
            where l.tenant_id = ${tenantId} order by l.start_date desc`,
      );
      const checks = await tx
        .select()
        .from(schema.idCheck)
        .where(eq(schema.idCheck.tenantId, tenantId))
        .orderBy(desc(schema.idCheck.createdAt))
        .limit(10);
      return {
        ...fullView(row.tenant, row.units, consent.get(key(tenantId)) ?? noConsent()),
        contacts: contacts.map((c) => contactView(c, consent.get(key(tenantId, c.id)))),
        leases: leases.rows.map((l): LeaseSummary => ({
          id: l.id,
          status: l.status,
          unitCode: l.unit_code,
          startDate: l.start_date,
          endDate: l.end_date,
        })),
        idChecks: checks.map(idCheckView),
      };
    });
  }

  /**
   * Other tenants in the company with the same phone, ID number (by blind index) or TIN (plan
   * 4.3). Only tenants the actor may see are compared, so nothing outside their scope leaks.
   */
  async findDuplicates(
    actor: Actor | null,
    input: {
      readonly phone?: string | null;
      readonly idType?: IdType | null;
      readonly idNumber?: string | null;
      readonly idCountry?: string | null;
      readonly tin?: string | null;
      readonly excludeTenantId?: string | null;
    },
  ): Promise<DuplicateWarning[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    const phone = phoneOf(input.phone);
    const idIndex =
      input.idType && input.idNumber
        ? this.idIndex(staff.companyId, input.idType, input.idNumber, input.idCountry)
        : null;
    const tinIndex = input.tin ? this.tinIndex(staff.companyId, checkTin(input.tin)) : null;
    return withCompany(this.database, staffContext(staff), (tx) =>
      this.duplicatesIn(tx, { phone, idIndex, tinIndex, excludeTenantId: input.excludeTenantId }),
    );
  }

  // Writing ------------------------------------------------------------------------------------

  async create(
    actor: Actor | null,
    input: TenantInput,
    options: { readonly isTestContact?: boolean } = {},
  ): Promise<{ tenant: TenantDetail; duplicates: DuplicateWarning[] }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    const id = uuidv7();
    const values = checkTenant(input);
    const sealed = await this.seal(staff.companyId, id, input);
    const contacts = (input.contacts ?? []).map((c) => ({
      id: uuidv7(),
      ...checkContact(c),
      consent: c.consent,
    }));
    const isTest = options.isTestContact ?? false;
    const duplicates = await withCompany(this.database, staffContext(staff), async (tx) => {
      const found = await this.duplicatesIn(tx, {
        phone: values.phone,
        idIndex: sealed.idNumberIndex ?? null,
        tinIndex: sealed.tinIndex ?? null,
      });
      await tx.insert(schema.tenant).values({
        id,
        companyId: staff.companyId,
        kind: input.kind,
        ...values,
        ...sealed,
        personId:
          input.kind === 'individual' && values.phone
            ? await this.personFor(tx, values.phone, values.displayName, isTest)
            : null,
        isTestContact: isTest,
        createdBy: staff.personId,
      });
      for (const c of contacts) {
        const { consent, ...contact } = c;
        await tx.insert(schema.tenantContact).values({
          ...contact,
          companyId: staff.companyId,
          tenantId: id,
          isTestContact: isTest,
        });
        await this.writeConsent(tx, staff, id, c.id, consent);
      }
      await this.writeConsent(tx, staff, id, null, input.consent);
      return found;
    });
    return { tenant: (await this.get(staff, id)) as TenantDetail, duplicates };
  }

  async update(
    actor: Actor | null,
    tenantId: string,
    patch: TenantPatch,
  ): Promise<{ tenant: TenantDetail; duplicates: DuplicateWarning[] }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    const current = await this.visibleRow(staff, tenantId);
    const values = checkTenant(
      { ...rowAsInput(current), ...patch, kind: current.kind as TenantKind },
      patch,
    );
    const idChanged = patch.idType !== undefined || patch.idNumber !== undefined;
    const sealed = await this.seal(
      staff.companyId,
      tenantId,
      {
        kind: current.kind as TenantKind,
        idType: idChanged ? (patch.idType ?? null) : undefined,
        idNumber: idChanged ? (patch.idNumber ?? null) : undefined,
        idCountry: patch.idCountry,
        tin: patch.tin,
      },
      { partial: true },
    );
    const duplicates = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.tenant)
        .where(and(eq(schema.tenant.id, tenantId), isNull(schema.tenant.archivedAt)))
        .for('update');
      if (!row) throw notFound('Tenant');
      const phoneChanged = values.phone !== undefined && values.phone !== row.phone;
      // A new phone re-links this company's record to that phone's person; the global person
      // itself is never edited (plan 4.3).
      const personId =
        phoneChanged && row.kind === 'individual'
          ? values.phone
            ? await this.personFor(
                tx,
                values.phone,
                values.displayName ?? row.displayName,
                row.isTestContact,
              )
            : null
          : undefined;
      // Decision 8 (OQ-54): a changed phone or email starts with no consent on its channels.
      const whatsappChanged =
        values.whatsappPhone !== undefined && (values.whatsappPhone ?? null) !== row.whatsappPhone;
      const emailChanged = values.email !== undefined && (values.email ?? null) !== row.email;
      const phoneServesWhatsApp = !row.whatsappPhone && values.whatsappPhone === undefined;
      await this.withdrawForChangedAddress(tx, staff, tenantId, null, [
        ...(phoneChanged ? (['sms'] as const) : []),
        ...(whatsappChanged || (phoneChanged && phoneServesWhatsApp)
          ? (['whatsapp'] as const)
          : []),
        ...(emailChanged ? (['email'] as const) : []),
      ]);
      if (idChanged)
        await tx
          .update(schema.idCheck)
          .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.idCheck.tenantId, tenantId), eq(schema.idCheck.status, 'pending')));
      await tx
        .update(schema.tenant)
        .set({
          ...values,
          ...sealed,
          ...(personId !== undefined ? { personId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.tenant.id, tenantId));
      return this.duplicatesIn(tx, {
        phone: phoneChanged ? (values.phone ?? null) : null,
        idIndex: idChanged ? (sealed.idNumberIndex ?? null) : null,
        tinIndex: patch.tin !== undefined ? (sealed.tinIndex ?? null) : null,
        excludeTenantId: tenantId,
      });
    });
    return { tenant: (await this.get(staff, tenantId)) as TenantDetail, duplicates };
  }

  /**
   * Archives a tenant who holds no lease; the record and its history stay. The database checks
   * every lease of the tenant, including those outside a scoped person's view (review finding 8).
   */
  async archive(actor: Actor | null, tenantId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    const held = () =>
      conflict('tenant_has_lease', 'This tenant has a lease, so the record stays open');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const leases = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from lease where tenant_id = ${tenantId}
            and status in ('pending_signatures', 'signed', 'active', 'ending', 'holding_over')`,
      );
      if ((leases.rows[0]?.n ?? 0) > 0) throw held();
      let rows: { id: string }[];
      try {
        rows = await tx
          .update(schema.tenant)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.tenant.id, tenantId), isNull(schema.tenant.archivedAt)))
          .returning({ id: schema.tenant.id });
      } catch (error) {
        if (sqlStateOf(error) === 'RA033') throw held();
        throw error;
      }
      if (rows.length === 0) throw notFound('Tenant');
    });
  }

  async addContact(
    actor: Actor | null,
    tenantId: string,
    input: ContactInput,
  ): Promise<ContactView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    const tenant = await this.visibleRow(staff, tenantId);
    const id = uuidv7();
    await withCompany(this.database, staffContext(staff), async (tx) => {
      await tx.insert(schema.tenantContact).values({
        id,
        companyId: staff.companyId,
        tenantId,
        ...checkContact(input),
        isTestContact: tenant.isTestContact,
      });
      await this.writeConsent(tx, staff, tenantId, id, input.consent);
    });
    return this.contact(staff, tenantId, id);
  }

  async updateContact(
    actor: Actor | null,
    tenantId: string,
    contactId: string,
    patch: Partial<Omit<ContactInput, 'kind' | 'consent'>>,
  ): Promise<ContactView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const values = checkContact(
        { kind: 'guarantor', name: patch.name ?? 'unchanged', ...patch },
        patch,
      );
      // Decision 8 (OQ-54): a contact's changed phone or email starts with no consent there.
      const [before] = await tx
        .select({ phone: schema.tenantContact.phone, email: schema.tenantContact.email })
        .from(schema.tenantContact)
        .where(
          and(eq(schema.tenantContact.id, contactId), eq(schema.tenantContact.tenantId, tenantId)),
        );
      if (before) {
        const changed = values as { phone?: string | null; email?: string | null };
        const phoneChanged =
          changed.phone !== undefined && (changed.phone ?? null) !== before.phone;
        const emailChanged =
          changed.email !== undefined && (changed.email ?? null) !== before.email;
        await this.withdrawForChangedAddress(tx, staff, tenantId, contactId, [
          ...(phoneChanged ? (['sms', 'whatsapp'] as const) : []),
          ...(emailChanged ? (['email'] as const) : []),
        ]);
      }
      const rows = await tx
        .update(schema.tenantContact)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(schema.tenantContact.id, contactId),
            eq(schema.tenantContact.tenantId, tenantId),
            isNull(schema.tenantContact.archivedAt),
          ),
        )
        .returning({ id: schema.tenantContact.id });
      if (rows.length === 0) throw notFound('Contact');
    });
    return this.contact(staff, tenantId, contactId);
  }

  async archiveContact(actor: Actor | null, tenantId: string, contactId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .update(schema.tenantContact)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.tenantContact.id, contactId),
            eq(schema.tenantContact.tenantId, tenantId),
            isNull(schema.tenantContact.archivedAt),
          ),
        )
        .returning({ id: schema.tenantContact.id });
      if (rows.length === 0) throw notFound('Contact');
    });
  }

  /**
   * Records that the tenant or one of their contacts granted or withdrew consent to messages on
   * a channel (CM-09; decision 2). Each event is kept, with the consent text's version and hash.
   */
  async recordConsent(
    actor: Actor | null,
    tenantId: string,
    input: {
      readonly contactId?: string | null;
      readonly channel: MessageChannel;
      readonly action: 'grant' | 'withdraw';
    },
  ): Promise<ConsentState> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    await this.visibleRow(staff, tenantId);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      if (input.contactId) {
        const [contact] = await tx
          .select({ id: schema.tenantContact.id })
          .from(schema.tenantContact)
          .where(
            and(
              eq(schema.tenantContact.id, input.contactId),
              eq(schema.tenantContact.tenantId, tenantId),
            ),
          );
        if (!contact) throw notFound('Contact');
      }
      await this.insertConsent(
        tx,
        staff,
        tenantId,
        input.contactId ?? null,
        input.channel,
        input.action,
      );
      const state = await this.consentFor(tx, [tenantId]);
      return state.get(key(tenantId, input.contactId ?? null)) ?? noConsent();
    });
  }

  /**
   * Shows an ID number (TL-02): needs tenant.id.reveal and a reason, and writes the audit event
   * `id_number.revealed` with who, when, why and which tenant, never the number itself.
   */
  async revealIdNumber(
    actor: Actor | null,
    tenantId: string,
    reason: string,
  ): Promise<{ idType: IdType; idNumber: string; country: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.id.reveal');
    const why = checkReason(reason);
    const row = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [found] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
      if (!found) throw notFound('Tenant');
      if (!found.idNumberEncrypted || !found.idType) throw notFound('ID number');
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'id_number.revealed',
        recordType: 'tenant',
        recordId: tenantId,
        data: { reason: why, idType: found.idType },
      });
      return found;
    });
    const sealed = JSON.parse(
      await this.cipher.decrypt(
        this.field(staff.companyId, tenantId, 'id_number'),
        row.idNumberEncrypted!,
      ),
    ) as { number: string; country: string };
    return { idType: row.idType as IdType, idNumber: sealed.number, country: sealed.country };
  }

  /** Shows a company tenant's TIN, with the same rules as an ID number (plan 4.4). */
  async revealTin(actor: Actor | null, tenantId: string, reason: string): Promise<{ tin: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.id.reveal');
    const why = checkReason(reason);
    const row = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [found] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
      if (!found) throw notFound('Tenant');
      if (!found.tinEncrypted) throw notFound('TIN');
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'tin.revealed',
        recordType: 'tenant',
        recordId: tenantId,
        data: { reason: why },
      });
      return found;
    });
    return {
      tin: await this.cipher.decrypt(
        this.field(staff.companyId, tenantId, 'tin'),
        row.tinEncrypted!,
      ),
    };
  }

  private readonly timelineSources: TimelineSource[] = [];

  /**
   * M6: another module adds its events to the timeline (messaging adds the tenant's messages, on
   * every plan, decision 9). It reads in the staff member's own transaction, so their scope holds.
   */
  useTimelineSource(source: TimelineSource): void {
    this.timelineSources.push(source);
  }

  /**
   * The tenant's timeline from the audit log: the record, its contacts, ID checks, consent and
   * leases, and from M6 the tenant's messages. Without tenant.view_details, actions only.
   */
  async timeline(actor: Actor | null, tenantId: string): Promise<TimelineEvent[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.view');
    const detailed = this.policy.can(staff, 'tenant.view_details').allowed;
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [tenant] = await tx
        .select({ id: schema.tenant.id })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, tenantId));
      if (!tenant) throw notFound('Tenant');
      const related = await tx.execute<{ record_type: string; id: string }>(
        sql`select 'tenant_contact' as record_type, id from tenant_contact where tenant_id = ${tenantId}
            union all select 'id_check', id from id_check where tenant_id = ${tenantId}
            union all select 'consent_event', id from consent_event where tenant_id = ${tenantId}
            union all select 'lease', id from lease where tenant_id = ${tenantId}`,
      );
      const records = [
        { type: 'tenant', id: tenantId },
        ...related.rows.map((r) => ({ type: r.record_type, id: r.id })),
      ];
      const events = await this.audit.forRecords(tx, records, 200);
      const timeline: TimelineEvent[] = events.map((e) => ({
        at: e.occurredAt,
        action: e.action,
        recordType: e.recordType,
        recordId: e.recordId,
        actorName: e.actorName,
        data: detailed ? e.data : null,
      }));
      if (this.timelineSources.length === 0) return timeline;
      for (const source of this.timelineSources)
        timeline.push(...(await source(tx, tenantId, { detailed, actor: staff })));
      // Review note: each source keeps its own cap, so messages never crowd out the record's
      // own history (the audit events above, at most 200).
      return timeline.sort((a, b) => b.at.getTime() - a.at.getTime());
    });
  }

  // For other modules (no actor: they run inside a company transaction already) -----------------

  /** A tenant's or contact's addresses and consent, for the messaging core (CM-09). */
  async reach(
    tx: Tx,
    subject: { readonly tenantId: string; readonly contactId?: string | null },
  ): Promise<ContactPoint | null> {
    const [tenant] = await tx
      .select()
      .from(schema.tenant)
      .where(eq(schema.tenant.id, subject.tenantId));
    if (!tenant) return null;
    const consent = (await this.consentFor(tx, [tenant.id])).get(
      key(tenant.id, subject.contactId ?? null),
    );
    const consented = new Set(
      MESSAGE_CHANNELS.filter((c) => consent?.[c] === true),
    ) as ReadonlySet<MessageChannel>;
    // M6 review MF-2: a tenant between leases keeps the property of their latest issued one.
    const property = await tx.execute<{ property_id: string }>(
      sql`select property_id from lease where tenant_id = ${tenant.id} and status <> 'draft'
          order by (status in ('pending_signatures', 'signed', 'active', 'ending', 'holding_over')) desc,
            start_date desc limit 1`,
    );
    const propertyId = property.rows[0]?.property_id ?? null;
    if (!subject.contactId)
      return {
        name: tenant.displayName,
        phone: tenant.phone,
        email: tenant.email,
        consented,
        isTestContact: tenant.isTestContact,
        propertyId,
      };
    const [contact] = await tx
      .select()
      .from(schema.tenantContact)
      .where(
        and(
          eq(schema.tenantContact.id, subject.contactId),
          eq(schema.tenantContact.tenantId, tenant.id),
          isNull(schema.tenantContact.archivedAt),
        ),
      );
    if (!contact) return null;
    return {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      consented,
      isTestContact: contact.isTestContact,
      propertyId,
    };
  }

  /**
   * M6 (CM-09; plan 4.3): a tenant's or contact's addresses on every channel, and the latest
   * consent event on each, with its time and source, for the send job, the bot and the inbox.
   */
  async messagingPoint(
    tx: Tx,
    subject: { readonly tenantId: string; readonly contactId?: string | null },
  ): Promise<MessagingPoint | null> {
    const point = await this.reach(tx, subject);
    if (!point) return null;
    const [tenant] = await tx
      .select({
        whatsappPhone: schema.tenant.whatsappPhone,
        personId: schema.tenant.personId,
        archivedAt: schema.tenant.archivedAt,
      })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, subject.tenantId));
    const contactKind = subject.contactId
      ? ((
          await tx
            .select({ kind: schema.tenantContact.kind })
            .from(schema.tenantContact)
            .where(eq(schema.tenantContact.id, subject.contactId))
        )[0]?.kind ?? null)
      : null;
    const rows = await tx.execute<{
      channel: string;
      action: 'grant' | 'withdraw';
      source: string;
      recorded_at: Date;
      text_version: string;
    }>(
      sql`select distinct on (channel) channel, action, source, recorded_at, text_version from consent_event
          where tenant_id = ${subject.tenantId}
            and tenant_contact_id is not distinct from ${subject.contactId ?? null}::uuid
          order by channel, recorded_at desc, id desc`,
    );
    const consent: Record<
      string,
      { action: 'grant' | 'withdraw'; at: Date; source: string; textVersion: string }
    > = {};
    for (const r of rows.rows)
      consent[r.channel] = {
        action: r.action,
        at: new Date(r.recorded_at),
        source: r.source,
        textVersion: r.text_version,
      };
    return {
      ...point,
      whatsappPhone: subject.contactId ? point.phone : (tenant?.whatsappPhone ?? point.phone),
      personId: subject.contactId ? null : (tenant?.personId ?? null),
      contactKind,
      consent,
    };
  }

  /**
   * Records consent in the system's name: a tenant's own STOP, START or YES, the app toggle, the
   * unsubscribe link, or an address that changed (M6 plan 4.8; decisions 7 and 8).
   */
  async recordSystemConsent(
    tx: Tx,
    companyId: string,
    input: {
      readonly tenantId: string;
      readonly contactId: string | null;
      readonly channel: 'sms' | 'email' | 'whatsapp' | 'push';
      readonly action: 'grant' | 'withdraw';
      readonly source:
        | 'tenant_reply'
        | 'stop_keyword'
        | 'start_keyword'
        | 'tenant_app'
        | 'email_unsubscribe'
        | 'staff';
      readonly textVersion: string;
      readonly recordedBy?: string | null;
      /** M6 review S3: the pipeline's clock, so consent and the reply window compare alike. */
      readonly recordedAt?: Date;
    },
  ): Promise<void> {
    await tx.insert(schema.consentEvent).values({
      // A keyword's time is the message's (the pipeline's clock, as the reply window is), and
      // never before an event already on record for the channel, so the newest stays newest.
      ...(input.recordedAt
        ? {
            recordedAt: sql`greatest(${input.recordedAt}::timestamptz, coalesce((
              select max(e.recorded_at) + interval '1 millisecond' from consent_event e
              where e.tenant_id = ${input.tenantId}::uuid
                and e.tenant_contact_id is not distinct from ${input.contactId}::uuid
                and e.channel = ${input.channel}), ${input.recordedAt}::timestamptz))`,
          }
        : {}),
      companyId,
      tenantId: input.tenantId,
      tenantContactId: input.contactId,
      channel: input.channel,
      action: input.action,
      textVersion: input.textVersion,
      textSha256: sha256(consentText(input.textVersion, input.channel)),
      source: input.source,
      recordedBy: input.recordedBy ?? null,
    });
  }

  /**
   * Decision 8 (OQ-54): consent belongs to the address it was given for. When a phone or email
   * changes, consent granted on the channels it serves is withdrawn, so staff record the person's
   * agreement for the new one.
   */
  private async withdrawForChangedAddress(
    tx: Tx,
    staff: StaffActor,
    tenantId: string,
    contactId: string | null,
    channels: readonly ('sms' | 'email' | 'whatsapp')[],
  ): Promise<void> {
    if (channels.length === 0) return;
    const state = await this.consentFor(tx, [tenantId]);
    const current = state.get(key(tenantId, contactId));
    const granted = await tx.execute<{ channel: string; action: string }>(
      sql`select distinct on (channel) channel, action from consent_event
          where tenant_id = ${tenantId} and tenant_contact_id is not distinct from ${contactId}::uuid
          order by channel, recorded_at desc, id desc`,
    );
    for (const channel of channels) {
      const isGranted =
        granted.rows.find((r) => r.channel === channel)?.action === 'grant' ||
        (channel !== 'whatsapp' && current?.[channel] === true);
      if (!isGranted) continue;
      await this.recordSystemConsent(tx, staff.companyId, {
        tenantId,
        contactId,
        channel,
        action: 'withdraw',
        source: 'staff',
        textVersion: 'address_changed.v1',
        recordedBy: staff.personId,
      });
    }
  }

  /** The decrypted ID number of a tenant, for the identity check job only (never logged). */
  async idNumberFor(
    tx: Tx,
    companyId: string,
    tenantId: string,
  ): Promise<{ idType: IdType; idNumber: string } | null> {
    const [row] = await tx
      .select({ idType: schema.tenant.idType, encrypted: schema.tenant.idNumberEncrypted })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenantId));
    if (!row?.idType || !row.encrypted) return null;
    const sealed = JSON.parse(
      await this.cipher.decrypt(this.field(companyId, tenantId, 'id_number'), row.encrypted),
    ) as { number: string };
    return { idType: row.idType as IdType, idNumber: sealed.number };
  }

  // Internals ----------------------------------------------------------------------------------

  private async visibleRow(staff: StaffActor, tenantId: string): Promise<TenantRow> {
    const [row] = await withCompany(this.database, staffContext(staff), (tx) =>
      tx
        .select()
        .from(schema.tenant)
        .where(and(eq(schema.tenant.id, tenantId), isNull(schema.tenant.archivedAt))),
    );
    if (!row) throw notFound('Tenant');
    return row;
  }

  private async contact(
    staff: StaffActor,
    tenantId: string,
    contactId: string,
  ): Promise<ContactView> {
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.tenantContact)
        .where(
          and(eq(schema.tenantContact.id, contactId), eq(schema.tenantContact.tenantId, tenantId)),
        );
      if (!row) throw notFound('Contact');
      const consent = await this.consentFor(tx, [tenantId]);
      return contactView(row, consent.get(key(tenantId, contactId)));
    });
  }

  /** The global person for a phone, created if needed; an id either way (plan 4.3). */
  private async personFor(tx: Tx, phone: string, name: string, isTest: boolean): Promise<string> {
    const result = await tx.execute<{ id: string }>(
      sql`select app.ensure_tenant_person(${phone}, ${name}, ${isTest}) as id`,
    );
    return result.rows[0]!.id;
  }

  private field(companyId: string, rowId: string, column: 'id_number' | 'tin') {
    return { companyId, table: 'tenant', column, rowId };
  }

  private idIndex(
    companyId: string,
    type: IdType,
    number: string,
    country?: string | null,
  ): string {
    const checked = checkIdNumber(type, number, country);
    return this.cipher.blindIndex(companyId, `${type}:${checked.country}:${checked.number}`);
  }

  private tinIndex(companyId: string, tin: string): string {
    return this.cipher.blindIndex(companyId, `tin:${tin}`);
  }

  /** Encrypts, indexes and masks the ID number and TIN a create or update carries. */
  private async seal(
    companyId: string,
    tenantId: string,
    input: Pick<TenantInput, 'kind' | 'idType' | 'idNumber' | 'idCountry' | 'tin'>,
    options: { readonly partial?: boolean } = {},
  ): Promise<Partial<TenantRow>> {
    const out: Partial<TenantRow> = {};
    const idGiven = input.idType !== undefined || input.idNumber !== undefined;
    if (idGiven || !options.partial) {
      if (input.idType && input.idNumber) {
        if (input.kind !== 'individual')
          throw invalid('id_individual_only', 'ID numbers are for individual tenants');
        const checked = checkIdNumber(input.idType, input.idNumber, input.idCountry);
        out.idType = input.idType;
        out.idNumberEncrypted = await this.cipher.encrypt(
          this.field(companyId, tenantId, 'id_number'),
          JSON.stringify({ number: checked.number, country: checked.country }),
        );
        out.idNumberIndex = this.idIndex(companyId, input.idType, checked.number, checked.country);
        out.idNumberMasked = maskIdNumber(checked.number);
        out.idStatus = input.idType === 'ghana_card' ? 'not_started' : 'recorded';
        out.idVerifiedAt = null;
      } else if (input.idType || input.idNumber) {
        throw invalid('id_incomplete', 'Give both the ID type and the number');
      } else {
        out.idType = null;
        out.idNumberEncrypted = null;
        out.idNumberIndex = null;
        out.idNumberMasked = null;
        out.idStatus = 'none';
        out.idVerifiedAt = null;
      }
    }
    if (input.tin !== undefined || !options.partial) {
      if (input.tin) {
        if (input.kind !== 'company')
          throw invalid('tin_company_only', 'An individual’s TIN is their Ghana Card number');
        const tin = checkTin(input.tin);
        out.tinEncrypted = await this.cipher.encrypt(this.field(companyId, tenantId, 'tin'), tin);
        out.tinIndex = this.tinIndex(companyId, tin);
        out.tinMasked = maskIdNumber(tin);
      } else {
        out.tinEncrypted = null;
        out.tinIndex = null;
        out.tinMasked = null;
      }
    }
    return out;
  }

  private async duplicatesIn(
    tx: Tx,
    match: {
      readonly phone: string | null | undefined;
      readonly idIndex: string | null;
      readonly tinIndex: string | null;
      readonly excludeTenantId?: string | null;
    },
  ): Promise<DuplicateWarning[]> {
    const t = schema.tenant;
    const found: DuplicateWarning[] = [];
    const others = (condition: ReturnType<typeof eq>) =>
      tx
        .select({ id: t.id, displayName: t.displayName })
        .from(t)
        .where(
          and(
            condition,
            isNull(t.archivedAt),
            match.excludeTenantId ? ne(t.id, match.excludeTenantId) : undefined,
          ),
        )
        .limit(10);
    if (match.phone)
      for (const r of await others(eq(t.phone, match.phone)))
        found.push({ tenantId: r.id, displayName: r.displayName, matchedOn: 'phone' });
    if (match.idIndex)
      for (const r of await others(eq(t.idNumberIndex, match.idIndex)))
        found.push({ tenantId: r.id, displayName: r.displayName, matchedOn: 'id_number' });
    if (match.tinIndex)
      for (const r of await others(eq(t.tinIndex, match.tinIndex)))
        found.push({ tenantId: r.id, displayName: r.displayName, matchedOn: 'tin' });
    return found;
  }

  /** The latest consent by tenant or contact and channel, from the append-only events. */
  private async consentFor(
    tx: Tx,
    tenantIds: readonly string[],
  ): Promise<Map<string, ConsentState>> {
    const out = new Map<string, ConsentState>();
    if (tenantIds.length === 0) return out;
    const rows = await tx.execute<{
      tenant_id: string;
      tenant_contact_id: string | null;
      channel: MessageChannel;
      action: 'grant' | 'withdraw';
    }>(
      sql`select distinct on (tenant_id, tenant_contact_id, channel) tenant_id, tenant_contact_id, channel, action
          from consent_event where tenant_id = any(${uuidArray(tenantIds)}::uuid[])
          order by tenant_id, tenant_contact_id, channel, recorded_at desc, id desc`,
    );
    for (const r of rows.rows) {
      if (!(MESSAGE_CHANNELS as readonly string[]).includes(r.channel)) continue;
      const k = key(r.tenant_id, r.tenant_contact_id);
      const state = out.get(k) ?? noConsent();
      state[r.channel] = r.action === 'grant';
      out.set(k, state);
    }
    return out;
  }

  private async writeConsent(
    tx: Tx,
    staff: StaffActor,
    tenantId: string,
    contactId: string | null,
    consent: Partial<ConsentState> | undefined,
  ): Promise<void> {
    for (const channel of MESSAGE_CHANNELS)
      if (consent?.[channel] === true)
        await this.insertConsent(tx, staff, tenantId, contactId, channel, 'grant');
  }

  private async insertConsent(
    tx: Tx,
    staff: StaffActor,
    tenantId: string,
    contactId: string | null,
    channel: MessageChannel,
    action: 'grant' | 'withdraw',
  ): Promise<void> {
    await tx.insert(schema.consentEvent).values({
      companyId: staff.companyId,
      tenantId,
      tenantContactId: contactId,
      channel,
      action,
      textVersion: CURRENT_CONSENT_TEXT,
      textSha256: sha256(consentText(CURRENT_CONSENT_TEXT, channel)),
      source: 'staff',
      recordedBy: staff.personId,
    });
  }
}

// Helpers --------------------------------------------------------------------------------------

const key = (tenantId: string, contactId: string | null = null) => `${tenantId}:${contactId ?? ''}`;

/** A uuid[] parameter, as a PostgreSQL array literal (the ids come from the database). */
export const uuidArray = (ids: readonly string[]) => `{${ids.join(',')}}`;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The codes of the units a tenant holds (the outer table is named, as drizzle leaves it bare). */
const unitsOf = () =>
  sql<
    string[]
  >`array(select u.code from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
    where l.company_id = tenant.company_id and l.tenant_id = tenant.id
      and l.status in (${sql.join(
        HOLDING.map((s) => sql`${s}`),
        sql`, `,
      )}) order by u.code)`.as('units');

function checkReason(reason: string): string {
  const why = reason.trim();
  if (why.length < REVEAL_REASON_MIN_LENGTH)
    throw invalid(
      'reason_required',
      `Give a reason of at least ${REVEAL_REASON_MIN_LENGTH} characters`,
    );
  return why.slice(0, 300);
}

/** The editable fields of a tenant, checked. With `patch`, only the fields it names. */
function checkTenant(input: TenantInput, patch?: TenantPatch) {
  const has = (field: keyof TenantPatch) => !patch || patch[field] !== undefined;
  const company = input.kind === 'company';
  const out: Partial<
    Pick<
      TenantRow,
      | 'displayName'
      | 'legalName'
      | 'phone'
      | 'whatsappPhone'
      | 'email'
      | 'occupation'
      | 'businessType'
      | 'registrationNumber'
      | 'notes'
    >
  > = {};
  if (has('displayName')) out.displayName = nameOf(input.displayName);
  if (has('legalName')) out.legalName = company ? text(input.legalName, 200) : null;
  if (has('phone')) out.phone = phoneOf(input.phone);
  if (has('whatsappPhone')) out.whatsappPhone = phoneOf(input.whatsappPhone);
  if (has('email')) out.email = emailOf(input.email);
  if (has('occupation')) out.occupation = text(input.occupation, 120);
  if (has('businessType')) out.businessType = company ? text(input.businessType, 120) : null;
  if (has('registrationNumber'))
    out.registrationNumber = company ? text(input.registrationNumber, 40) : null;
  if (has('notes')) out.notes = text(input.notes, 2000);
  if (
    !company &&
    patch === undefined &&
    (input.legalName || input.businessType || input.registrationNumber)
  )
    throw invalid('company_fields', 'Registration details are for company tenants');
  return out as {
    displayName: string;
    legalName?: string | null;
    phone: string | null;
    whatsappPhone?: string | null;
    email?: string | null;
    occupation?: string | null;
    businessType?: string | null;
    registrationNumber?: string | null;
    notes?: string | null;
  };
}

function checkContact(input: ContactInput, patch?: Partial<ContactInput>) {
  const has = (field: keyof ContactInput) => !patch || patch[field] !== undefined;
  const out: Partial<
    Pick<
      ContactRow,
      'kind' | 'name' | 'phone' | 'email' | 'relationship' | 'organisation' | 'position' | 'notes'
    >
  > = {};
  if (!patch) out.kind = input.kind;
  if (has('name')) out.name = nameOf(input.name, 'contact');
  if (has('phone')) out.phone = phoneOf(input.phone);
  if (has('email')) out.email = emailOf(input.email);
  if (has('relationship')) out.relationship = text(input.relationship, 80);
  if (has('organisation')) out.organisation = text(input.organisation, 160);
  if (has('position')) out.position = text(input.position, 120);
  if (has('notes')) out.notes = text(input.notes, 1000);
  return out as { kind: ContactKind; name: string };
}

function rowAsInput(row: TenantRow): TenantInput {
  return {
    kind: row.kind as TenantKind,
    displayName: row.displayName,
    legalName: row.legalName,
    phone: row.phone,
    whatsappPhone: row.whatsappPhone,
    email: row.email,
    occupation: row.occupation,
    businessType: row.businessType,
    registrationNumber: row.registrationNumber,
    notes: row.notes,
  };
}

function limitedView(row: TenantRow, units: string[]): TenantLimitedView {
  return {
    access: 'limited',
    id: row.id,
    kind: row.kind as TenantKind,
    displayName: row.displayName,
    phone: row.phone,
    units,
  };
}

function fullView(row: TenantRow, units: string[], consent: ConsentState): TenantView {
  return {
    access: 'full',
    id: row.id,
    kind: row.kind as TenantKind,
    displayName: row.displayName,
    legalName: row.legalName,
    phone: row.phone,
    whatsappPhone: row.whatsappPhone,
    email: row.email,
    occupation: row.occupation,
    businessType: row.businessType,
    registrationNumber: row.registrationNumber,
    tinMasked: row.tinMasked,
    identity: {
      type: (row.idType as IdType | null) ?? null,
      masked: row.idNumberMasked,
      status: row.idStatus as IdStatus,
      verifiedAt: row.idVerifiedAt,
    },
    notes: row.notes,
    units,
    consent,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt,
  };
}

function contactView(row: ContactRow, consent: ConsentState | undefined): ContactView {
  return {
    id: row.id,
    kind: row.kind as ContactKind,
    name: row.name,
    phone: row.phone,
    email: row.email,
    relationship: row.relationship,
    organisation: row.organisation,
    position: row.position,
    notes: row.notes,
    consent: consent ?? noConsent(),
    archived: row.archivedAt !== null,
  };
}

export function idCheckView(row: typeof schema.idCheck.$inferSelect): IdCheckView {
  return {
    id: row.id,
    idType: row.idType as IdType,
    status: row.status as IdCheckView['status'],
    lastResult: row.lastResult,
    polls: row.polls,
    lastPolledAt: row.lastPolledAt,
    checkedAt: row.checkedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}
