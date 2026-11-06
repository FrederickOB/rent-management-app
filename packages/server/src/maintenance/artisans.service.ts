import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import {
  MAINTENANCE_CATEGORIES,
  OPEN_MAINTENANCE_STATUSES,
  type MaintenanceCategory,
} from '@rent/domain/maintenance';
import { CONSENT_TEXTS } from '@rent/domain/messaging';
import { maskPhone, tryNormalisePhone } from '@rent/domain/phone';
import type { Actor } from '@rent/domain/policy';
import { staffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';

type ArtisanRow = typeof schema.artisan.$inferSelect;
type Channel = 'sms' | 'whatsapp';

export interface ArtisanView {
  readonly id: string;
  readonly name: string;
  readonly phoneMasked: string;
  readonly trades: MaintenanceCategory[];
  readonly consent: { readonly whatsapp: boolean; readonly sms: boolean };
  readonly archivedAt: Date | null;
  readonly openJobs: number;
  readonly createdAt: Date;
}

/** What messaging needs to reach a staff member or an artisan (CM-09). */
export interface ContactReach {
  readonly name: string;
  readonly phone: string | null;
  readonly consented: ReadonlySet<Channel>;
  readonly consentAt: Partial<Record<Channel, { action: 'grant' | 'withdraw'; at: Date }>>;
  readonly isTestContact: boolean;
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const textOf = (version: string, channel: Channel) =>
  (CONSENT_TEXTS[version] ?? version).replace('{channel}', channel === 'sms' ? 'SMS' : 'WhatsApp');

/**
 * Artisans (MI-04; decision 6) and the consent of people who are neither tenants nor their
 * contacts (CM-09; decision 5): a staff member's WhatsApp opt-in for emergency alerts, and an
 * artisan's channels. Each consent change is a new contact_consent_event row. Artisans are
 * archived, never deleted, and carry no rates, ratings or payment details (MI-09).
 */
@Injectable()
export class ArtisansService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(
    actor: Actor | null,
    filter: { archived?: boolean; trade?: MaintenanceCategory },
  ): Promise<ArtisanView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'maintenance.read');
    await this.entitlements.assert(staff.companyId, 'maintenance');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.artisan)
        .where(
          and(
            filter.archived === true
              ? sql`${schema.artisan.archivedAt} is not null`
              : filter.archived === false || filter.archived === undefined
                ? sql`${schema.artisan.archivedAt} is null`
                : undefined,
            filter.trade ? sql`${filter.trade} = any(${schema.artisan.trades})` : undefined,
          ),
        )
        .orderBy(asc(schema.artisan.name));
      return this.views(tx, rows);
    });
  }

  async create(
    actor: Actor | null,
    input: {
      name: string;
      phone: string;
      trades: readonly MaintenanceCategory[];
      consent: { whatsapp: boolean; sms: boolean };
    },
  ): Promise<ArtisanView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'artisan.manage');
    await this.entitlements.assert(staff.companyId, 'maintenance');
    const phone = tryNormalisePhone(input.phone);
    if (!phone) throw invalid('phone', 'Enter the phone number with its country code, as +233…');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [taken] = await tx
        .select({ id: schema.artisan.id })
        .from(schema.artisan)
        .where(eq(schema.artisan.phone, phone));
      if (taken) throw conflict('artisan_exists', 'An artisan with this phone is already listed');
      const [row] = await tx
        .insert(schema.artisan)
        .values({
          companyId: staff.companyId,
          name: input.name.trim(),
          phone,
          trades: [...new Set(input.trades)],
          createdBy: staff.personId,
        })
        .returning();
      for (const channel of ['whatsapp', 'sms'] as const)
        if (input.consent[channel])
          await this.recordArtisanConsent(tx, row!, channel, true, staff.personId);
      return (await this.views(tx, [row!]))[0]!;
    });
  }

  async update(
    actor: Actor | null,
    artisanId: string,
    input: {
      name?: string;
      trades?: readonly MaintenanceCategory[];
      consent?: { whatsapp: boolean; sms: boolean };
    },
  ): Promise<ArtisanView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'artisan.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await this.row(tx, artisanId);
      if (row.archivedAt) throw conflict('artisan_archived', 'This artisan is archived');
      if (input.name !== undefined || input.trades !== undefined)
        await tx
          .update(schema.artisan)
          .set({
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.trades !== undefined ? { trades: [...new Set(input.trades)] } : {}),
            updatedAt: this.clock.now(),
          })
          .where(eq(schema.artisan.id, artisanId));
      if (input.consent) {
        const current = await this.consentOf(tx, 'artisan', [artisanId]);
        for (const channel of ['whatsapp', 'sms'] as const) {
          const was = current.get(artisanId)?.[channel]?.action === 'grant';
          if (was !== input.consent[channel])
            await this.recordArtisanConsent(
              tx,
              row,
              channel,
              input.consent[channel],
              staff.personId,
            );
        }
      }
      return (await this.views(tx, [await this.row(tx, artisanId)]))[0]!;
    });
  }

  async archive(actor: Actor | null, artisanId: string): Promise<ArtisanView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'artisan.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await this.row(tx, artisanId);
      if (!row.archivedAt)
        await tx
          .update(schema.artisan)
          .set({ archivedAt: this.clock.now(), updatedAt: this.clock.now() })
          .where(eq(schema.artisan.id, artisanId));
      return (await this.views(tx, [await this.row(tx, artisanId)]))[0]!;
    });
  }

  // Consent (CM-09; decisions 5 and 6) ----------------------------------------------------------

  /** Staff record a team member's WhatsApp opt-in or withdrawal (when invited, or later). */
  async setStaffWhatsApp(actor: Actor | null, membershipId: string, granted: boolean) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'membership.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const [m] = await tx
        .select({ id: schema.membership.id })
        .from(schema.membership)
        .where(eq(schema.membership.id, membershipId));
      if (!m) throw notFound('Member');
      await this.recordStaffWhatsApp(tx, {
        companyId: staff.companyId,
        membershipId,
        granted,
        source: 'staff',
        recordedBy: staff.personId,
      });
    });
  }

  /** The signed-in staff member's own opt-in, from their profile. */
  async ownWhatsApp(actor: Actor | null, granted?: boolean) {
    const staff = staffActor(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      if (granted !== undefined)
        await this.recordStaffWhatsApp(tx, {
          companyId: staff.companyId,
          membershipId: staff.membershipId,
          granted,
          source: 'self',
          recordedBy: staff.personId,
        });
      const [person] = await tx
        .select({ phone: schema.person.phoneNumber })
        .from(schema.person)
        .where(eq(schema.person.id, staff.personId));
      return {
        granted:
          (await this.staffWhatsApp(tx, [staff.membershipId])).get(staff.membershipId) ?? false,
        phoneMasked: person?.phone ? maskPhone(person.phone) : null,
      };
    });
  }

  /** Each membership's opt-in, for the members list. */
  async staffWhatsAppFor(actor: Actor | null, membershipIds: readonly string[]) {
    const staff = staffActor(actor);
    return withCompany(this.database, staffContext(staff), (tx) =>
      this.staffWhatsApp(tx, membershipIds),
    );
  }

  /** A staff member's WhatsApp opt-in for emergency alerts, in the caller's transaction. */
  async recordStaffWhatsApp(
    tx: Tx,
    input: {
      readonly companyId: string;
      readonly membershipId: string;
      readonly granted: boolean;
      readonly source: 'staff' | 'self' | 'stop_keyword';
      readonly recordedBy: string | null;
    },
  ): Promise<void> {
    const current = await this.consentOf(tx, 'staff', [input.membershipId]);
    if ((current.get(input.membershipId)?.whatsapp?.action === 'grant') === input.granted) return;
    const version = input.granted ? 'staff_alerts.v1' : 'staff_alerts_off.v1';
    await tx.insert(schema.contactConsentEvent).values({
      companyId: input.companyId,
      subjectType: 'staff',
      membershipId: input.membershipId,
      channel: 'whatsapp',
      action: input.granted ? 'grant' : 'withdraw',
      textVersion: version,
      textSha256: sha(textOf(version, 'whatsapp')),
      source: input.source,
      recordedBy: input.recordedBy,
      recordedAt: this.clock.now(),
    });
  }

  /** Whether each membership has opted in to WhatsApp alerts. */
  async staffWhatsApp(tx: Tx, membershipIds: readonly string[]): Promise<Map<string, boolean>> {
    const latest = await this.consentOf(tx, 'staff', membershipIds);
    return new Map(membershipIds.map((id) => [id, latest.get(id)?.whatsapp?.action === 'grant']));
  }

  /** An artisan's STOP (or staff's) on a channel, honoured on every channel it names. */
  async withdrawArtisan(tx: Tx, artisanId: string, channel: Channel): Promise<void> {
    const row = await this.row(tx, artisanId);
    const current = await this.consentOf(tx, 'artisan', [artisanId]);
    if (current.get(artisanId)?.[channel]?.action === 'grant')
      await this.recordArtisanConsent(tx, row, channel, false, null, 'stop_keyword');
  }

  /**
   * STOP, STOP ALL and START from a phone the company knows as an artisan or a staff member (CM-09;
   * M8 review), on the channels the keyword names: each such contact's consent there changes. A
   * staff member's SMS needs no consent, but a STOP on it is honoured and a START undoes it.
   * Returns whether the phone was known.
   */
  async honourKeyword(
    tx: Tx,
    companyId: string,
    phone: string,
    effect: { readonly action: 'grant' | 'withdraw'; readonly channels: readonly string[] },
  ): Promise<boolean> {
    const channels = effect.channels.filter((c): c is Channel => c === 'sms' || c === 'whatsapp');
    const artisans = await tx.select().from(schema.artisan).where(eq(schema.artisan.phone, phone));
    const members = await tx
      .select({ id: schema.membership.id })
      .from(schema.membership)
      .innerJoin(schema.person, eq(schema.person.id, schema.membership.personId))
      .where(
        and(
          eq(schema.membership.companyId, companyId),
          eq(schema.membership.status, 'active'),
          eq(schema.person.phoneNumber, phone),
        ),
      );
    if (artisans.length === 0 && members.length === 0) return false;
    const granted = effect.action === 'grant';
    const version = granted ? 'start.v1' : 'stop.v1';
    const source = granted ? ('self' as const) : ('stop_keyword' as const);
    const artisanNow = await this.consentOf(
      tx,
      'artisan',
      artisans.map((a) => a.id),
    );
    const staffNow = await this.consentOf(
      tx,
      'staff',
      members.map((m) => m.id),
    );
    const now = this.clock.now();
    for (const channel of channels) {
      for (const a of artisans) {
        const latest = artisanNow.get(a.id)?.[channel]?.action;
        // A START restores only what a STOP withdrew; staff record an artisan's first consent.
        if (granted ? latest !== 'withdraw' : latest !== 'grant') continue;
        await tx.insert(schema.contactConsentEvent).values({
          companyId,
          subjectType: 'artisan',
          artisanId: a.id,
          channel,
          action: effect.action,
          textVersion: version,
          textSha256: sha(textOf(version, channel)),
          source,
          recordedBy: null,
          recordedAt: now,
        });
      }
      for (const m of members) {
        const latest = staffNow.get(m.id)?.[channel]?.action;
        // Staff SMS goes out without consent: only a STOP is recorded, and a START after it.
        if (granted ? latest !== 'withdraw' : latest === 'withdraw') continue;
        if (!granted && channel === 'whatsapp' && latest !== 'grant') continue;
        await tx.insert(schema.contactConsentEvent).values({
          companyId,
          subjectType: 'staff',
          membershipId: m.id,
          channel,
          action: effect.action,
          textVersion: version,
          textSha256: sha(textOf(version, channel)),
          source,
          recordedBy: null,
          recordedAt: now,
        });
      }
    }
    return true;
  }

  /** How messaging reaches an artisan (decision 6): their phone, on the channels they agreed to. */
  async artisanReach(tx: Tx, artisanId: string): Promise<ContactReach | null> {
    const [row] = await tx.select().from(schema.artisan).where(eq(schema.artisan.id, artisanId));
    if (!row) return null;
    const latest = (await this.consentOf(tx, 'artisan', [artisanId])).get(artisanId) ?? {};
    return {
      name: row.name,
      phone: row.phone,
      consented: new Set(
        (['sms', 'whatsapp'] as const).filter((c) => latest[c]?.action === 'grant'),
      ),
      consentAt: latest,
      isTestContact: row.isTestContact,
    };
  }

  /** A staff member's WhatsApp consent in a company, for the emergency alert (decision 5). */
  async staffReach(
    tx: Tx,
    personId: string,
  ): Promise<{
    whatsapp: { action: 'grant' | 'withdraw'; at: Date } | null;
    /** M8 review: a STOP by SMS; staff SMS otherwise needs no consent. */
    sms: { action: 'grant' | 'withdraw'; at: Date } | null;
  }> {
    const [membership] = await tx
      .select({ id: schema.membership.id })
      .from(schema.membership)
      .where(and(eq(schema.membership.personId, personId), eq(schema.membership.status, 'active')));
    if (!membership) return { whatsapp: null, sms: null };
    const latest = (await this.consentOf(tx, 'staff', [membership.id])).get(membership.id);
    return { whatsapp: latest?.whatsapp ?? null, sms: latest?.sms ?? null };
  }

  private async recordArtisanConsent(
    tx: Tx,
    artisan: ArtisanRow,
    channel: Channel,
    granted: boolean,
    recordedBy: string | null,
    source: 'staff' | 'stop_keyword' = 'staff',
  ) {
    const version = granted ? 'artisan_contact.v1' : 'artisan_contact_off.v1';
    await tx.insert(schema.contactConsentEvent).values({
      companyId: artisan.companyId,
      subjectType: 'artisan',
      artisanId: artisan.id,
      channel,
      action: granted ? 'grant' : 'withdraw',
      textVersion: version,
      textSha256: sha(textOf(version, channel)),
      source,
      recordedBy,
      recordedAt: this.clock.now(),
    });
  }

  private async consentOf(
    tx: Tx,
    subject: 'staff' | 'artisan',
    ids: readonly string[],
  ): Promise<Map<string, Partial<Record<Channel, { action: 'grant' | 'withdraw'; at: Date }>>>> {
    const out = new Map<
      string,
      Partial<Record<Channel, { action: 'grant' | 'withdraw'; at: Date }>>
    >();
    if (ids.length === 0) return out;
    const column =
      subject === 'staff'
        ? schema.contactConsentEvent.membershipId
        : schema.contactConsentEvent.artisanId;
    const rows = await tx
      .select({
        id: column,
        channel: schema.contactConsentEvent.channel,
        action: schema.contactConsentEvent.action,
        at: schema.contactConsentEvent.recordedAt,
      })
      .from(schema.contactConsentEvent)
      .where(inArray(column, [...ids]))
      .orderBy(asc(schema.contactConsentEvent.recordedAt), asc(schema.contactConsentEvent.id));
    for (const r of rows) {
      if (!r.id) continue;
      const entry = out.get(r.id) ?? {};
      entry[r.channel as Channel] = { action: r.action as 'grant' | 'withdraw', at: r.at };
      out.set(r.id, entry);
    }
    return out;
  }

  private async row(tx: Tx, artisanId: string): Promise<ArtisanRow> {
    const [row] = await tx.select().from(schema.artisan).where(eq(schema.artisan.id, artisanId));
    if (!row) throw notFound('Artisan');
    return row;
  }

  private async views(tx: Tx, rows: readonly ArtisanRow[]): Promise<ArtisanView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const consent = await this.consentOf(tx, 'artisan', ids);
    const open = await tx
      .select({ id: schema.maintenanceJob.assigneeArtisanId, n: sql<number>`count(*)::int` })
      .from(schema.maintenanceJob)
      .where(
        and(
          inArray(schema.maintenanceJob.assigneeArtisanId, ids),
          inArray(schema.maintenanceJob.status, [...OPEN_MAINTENANCE_STATUSES]),
        ),
      )
      .groupBy(schema.maintenanceJob.assigneeArtisanId);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      phoneMasked: maskPhone(r.phone),
      trades: r.trades.filter((t): t is MaintenanceCategory =>
        (MAINTENANCE_CATEGORIES as readonly string[]).includes(t),
      ),
      consent: {
        whatsapp: consent.get(r.id)?.whatsapp?.action === 'grant',
        sms: consent.get(r.id)?.sms?.action === 'grant',
      },
      archivedAt: r.archivedAt,
      openJobs: Number(open.find((o) => o.id === r.id)?.n ?? 0),
      createdAt: r.createdAt,
    }));
  }
}
