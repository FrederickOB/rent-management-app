import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database, type Tx } from '@rent/db';
import {
  addDays,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { tierOf, type SubscriptionTier } from '@rent/domain/settings';
import {
  readOnlyUntil,
  subscriptionAccess,
  subscriptionStatus,
  trialEndsOn as trialLastDay,
  type CompanyAccess,
  type SubscriptionStatus,
} from '@rent/domain/subscription';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import { CLOCK, DATABASE } from '../core/tokens';
import { termsAsOf, type TermsVersion } from './catalogue';
import { lockSubscription } from './platform';

/** A landlord or agency company, as the platform sees it (`app.subscriber_companies()`). */
export interface SubscriberCompany {
  readonly id: string;
  readonly kind: 'landlord' | 'agency';
  readonly displayName: string;
  readonly legalName: string;
  readonly timeZone: string;
  readonly status: string;
  readonly plan: SubscriptionTier;
  readonly access: CompanyAccess;
  readonly createdAt: Date;
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly subscriberCompanyId: string;
  readonly tier: SubscriptionTier;
  readonly status: SubscriptionStatus;
  readonly startedOn: string;
  readonly trialEndsOn: string | null;
  readonly pendingTier: SubscriptionTier | null;
  readonly pendingTierFrom: string | null;
  readonly cancelsOn: string | null;
  readonly cancelReason: string | null;
  readonly cancelledOn: string | null;
  readonly readOnlyUntil: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenInvoice {
  readonly id: string;
  readonly number: string;
  readonly month: string;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly totalMinor: number;
  readonly settledMinor: number;
  readonly outstandingMinor: number;
}

export const SUBSCRIPTION_EVENT_KINDS = [
  'started',
  'status_changed',
  'tier_changed',
  'downgrade_scheduled',
  'downgrade_withdrawn',
  'trial_extended',
  'discount_applied',
  'annual_started',
  'cancel_scheduled',
  'cancel_withdrawn',
  'reminder_sent',
] as const;
export type SubscriptionEventKind = (typeof SUBSCRIPTION_EVENT_KINDS)[number];

interface SubscriptionRow extends Record<string, unknown> {
  id: string;
  subscriber_company_id: string;
  tier: string;
  status: SubscriptionStatus;
  started_on: string;
  trial_ends_on: string | null;
  pending_tier: string | null;
  pending_tier_from: string | null;
  cancels_on: string | null;
  cancel_reason: string | null;
  cancelled_on: string | null;
  read_only_until: string | null;
  created_at: Date;
  updated_at: Date;
}

const SUBSCRIPTION_COLUMNS = sql`id, subscriber_company_id, tier, status, started_on::text,
  trial_ends_on::text, pending_tier, pending_tier_from::text, cancels_on::text, cancel_reason,
  cancelled_on::text, read_only_until::text, created_at, updated_at`;

const toRecord = (r: SubscriptionRow): SubscriptionRecord => ({
  id: r.id,
  subscriberCompanyId: r.subscriber_company_id,
  tier: tierOf(r.tier),
  status: r.status,
  startedOn: r.started_on,
  trialEndsOn: r.trial_ends_on,
  pendingTier: r.pending_tier === null ? null : tierOf(r.pending_tier),
  pendingTierFrom: r.pending_tier_from,
  cancelsOn: r.cancels_on,
  cancelReason: r.cancel_reason,
  cancelledOn: r.cancelled_on,
  readOnlyUntil: r.read_only_until,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

/**
 * The subscription engine's core (M10 plan 4.5): finding or starting a company's subscription,
 * its tier history, open invoices and prepaid credit, and the status and access derived from them
 * (`subscriptionStatus`, `subscriptionAccess` in the domain). Status changes only here, recorded as
 * append-only events, with the company's plan and access set through
 * `app.apply_subscription_state` and an event in the subscriber's own audit chain.
 *
 * Every method that takes a `tx` expects the platform company's context (`withPlatform`), except
 * where it says otherwise.
 */
@Injectable()
export class SubscriptionCoreService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Today in a time zone (subscriber months are calendar months there, decision 2). */
  todayIn(timeZone: string): string {
    return toIsoDate(businessDateOf(instantFrom(this.clock.now()), timeZone));
  }

  dayOf(at: Date, timeZone: string): string {
    return toIsoDate(businessDateOf(instantFrom(at), timeZone));
  }

  async subscriberCompanies(tx: Tx): Promise<SubscriberCompany[]> {
    const rows = await tx.execute<{
      company_id: string;
      kind: 'landlord' | 'agency';
      display_name: string;
      legal_name: string;
      time_zone: string;
      status: string;
      plan: string;
      access: string;
      created_at: Date;
    }>(sql`select * from app.subscriber_companies()`);
    return rows.rows.map((r) => ({
      id: r.company_id,
      kind: r.kind,
      displayName: r.display_name,
      legalName: r.legal_name,
      timeZone: r.time_zone,
      status: r.status,
      plan: tierOf(r.plan),
      access: r.access === 'read_only' ? 'read_only' : 'full',
      createdAt: new Date(r.created_at),
    }));
  }

  async subscriberCompany(tx: Tx, companyId: string): Promise<SubscriberCompany | null> {
    return (await this.subscriberCompanies(tx)).find((c) => c.id === companyId) ?? null;
  }

  async find(tx: Tx, subscriberCompanyId: string): Promise<SubscriptionRecord | null> {
    const rows = await tx.execute<SubscriptionRow>(
      sql`select ${SUBSCRIPTION_COLUMNS} from subscription
          where subscriber_company_id = ${subscriberCompanyId}::uuid`,
    );
    return rows.rows[0] ? toRecord(rows.rows[0]) : null;
  }

  async byId(tx: Tx, subscriptionId: string): Promise<SubscriptionRecord | null> {
    const rows = await tx.execute<SubscriptionRow>(
      sql`select ${SUBSCRIPTION_COLUMNS} from subscription where id = ${subscriptionId}::uuid`,
    );
    return rows.rows[0] ? toRecord(rows.rows[0]) : null;
  }

  /**
   * The company's subscription, started if it has none (decision 5): from the day the company was
   * created, on its plan, with the trial the terms then in force give. Takes the subscription
   * lock, so concurrent callers start one.
   */
  async ensure(
    tx: Tx,
    platformId: string,
    company: SubscriberCompany,
    options: { readonly trialDays?: number | null; readonly personId?: string | null } = {},
  ): Promise<SubscriptionRecord> {
    await lockSubscription(tx, company.id);
    const existing = await this.find(tx, company.id);
    if (existing) return existing;
    const startedOn = this.dayOf(company.createdAt, company.timeZone);
    const terms = await termsAsOf(tx, startedOn);
    const trialDays = options.trialDays ?? terms.trialDays;
    const trialEndsOn = trialDays > 0 ? trialLastDay(startedOn, trialDays) : null;
    const today = this.todayIn(company.timeZone);
    const status = subscriptionStatus({
      today,
      trialEndsOn,
      cancelsOn: null,
      oldestUnpaidDueOn: null,
      graceDays: terms.graceDays,
      readOnlyEnabled: terms.readOnlyEnabled,
    });
    const inserted = await tx.execute<SubscriptionRow>(
      sql`insert into subscription (company_id, subscriber_company_id, tier, status, started_on, trial_ends_on)
          values (${platformId}::uuid, ${company.id}::uuid, ${company.plan}, ${status}, ${startedOn}::date,
                  ${trialEndsOn}::date)
          returning ${SUBSCRIPTION_COLUMNS}`,
    );
    const record = toRecord(inserted.rows[0]!);
    await this.event(tx, platformId, record, 'started', {
      statusTo: status,
      tier: company.plan,
      effectiveOn: startedOn,
      data: { trialDays, termsId: terms.id },
      actorPersonId: options.personId ?? null,
    });
    return record;
  }

  /** Appends an event to the subscription's history (append-only). */
  async event(
    tx: Tx,
    platformId: string,
    sub: Pick<SubscriptionRecord, 'id' | 'subscriberCompanyId'>,
    kind: SubscriptionEventKind,
    fields: {
      readonly statusFrom?: SubscriptionStatus | null;
      readonly statusTo?: SubscriptionStatus | null;
      readonly tier?: SubscriptionTier | null;
      readonly effectiveOn?: string | null;
      readonly reason?: string | null;
      readonly data?: Record<string, unknown> | null;
      readonly actorPersonId?: string | null;
    } = {},
  ): Promise<string> {
    const rows = await tx.execute<{ id: string }>(
      sql`insert into subscription_event (company_id, subscription_id, subscriber_company_id, kind,
            status_from, status_to, tier, effective_on, reason, data, actor_person_id)
          values (${platformId}::uuid, ${sub.id}::uuid, ${sub.subscriberCompanyId}::uuid, ${kind},
            ${fields.statusFrom ?? null}, ${fields.statusTo ?? null}, ${fields.tier ?? null},
            ${fields.effectiveOn ?? null}::date, ${fields.reason ?? null},
            ${fields.data ? JSON.stringify(fields.data) : null}::jsonb, ${fields.actorPersonId ?? null}::uuid)
          returning id`,
    );
    return rows.rows[0]!.id;
  }

  /** The tier history that prices a month: each tier from the day it took effect, in order. */
  async tierHistory(
    tx: Tx,
    subscriptionId: string,
  ): Promise<{ readonly tier: SubscriptionTier; readonly from: string }[]> {
    const rows = await tx.execute<{ tier: string; effective_on: string }>(
      sql`select tier, effective_on::text from subscription_event
          where subscription_id = ${subscriptionId}::uuid and kind in ('started', 'tier_changed')
          order by effective_on, occurred_at, id`,
    );
    return rows.rows.map((r) => ({ tier: tierOf(r.tier), from: r.effective_on }));
  }

  /** Open invoices, oldest first, with what is settled (payments and prepaid draws). */
  async openInvoices(tx: Tx, subscriberCompanyId: string): Promise<OpenInvoice[]> {
    const rows = await tx.execute<{
      id: string;
      number: string;
      month: string;
      issued_on: string;
      due_on: string;
      total_minor: string | number;
      settled_minor: string | number;
    }>(
      sql`select i.id, i.number, i.month, i.issued_on::text, i.due_on::text, i.total_minor,
            coalesce((select sum(a.amount_minor) from subscription_allocation a
                      left join subscription_payment p on p.company_id = a.company_id and p.id = a.payment_id
                      where a.company_id = i.company_id and a.invoice_id = i.id
                        and (a.payment_id is null or p.status = 'succeeded')), 0) as settled_minor
          from subscription_invoice i
          where i.subscriber_company_id = ${subscriberCompanyId}::uuid and i.status = 'open'
          order by i.issued_on, i.number`,
    );
    return rows.rows.map((r) => ({
      id: r.id,
      number: r.number,
      month: r.month,
      issuedOn: r.issued_on,
      dueOn: r.due_on,
      totalMinor: Number(r.total_minor),
      settledMinor: Number(r.settled_minor),
      outstandingMinor: Number(r.total_minor) - Number(r.settled_minor),
    }));
  }

  /**
   * Prepaid credit (2020): what succeeded payments left unallocated, less the monthly draws on it.
   * The ledger holds the same figure; the nightly check compares them.
   */
  async creditMinor(tx: Tx, subscriberCompanyId: string): Promise<number> {
    const rows = await tx.execute<{ credit: string | number }>(
      sql`select
            coalesce((select sum(p.amount_minor) from subscription_payment p
                      where p.subscriber_company_id = ${subscriberCompanyId}::uuid and p.status = 'succeeded'), 0)
          - coalesce((select sum(a.amount_minor) from subscription_allocation a
                      left join subscription_payment p on p.company_id = a.company_id and p.id = a.payment_id
                      where a.subscriber_company_id = ${subscriberCompanyId}::uuid
                        and (a.payment_id is null or p.status = 'succeeded')), 0) as credit`,
    );
    return Number(rows.rows[0]?.credit ?? 0);
  }

  /**
   * Derives the status and access from the facts (decisions 5, 11 and 12) and records any change:
   * the subscription row, a `status_changed` event, the company's plan and access, and an event in
   * the subscriber's chain. Returns what holds now. Call it after anything that changes the facts:
   * an invoice, a payment, a cancellation, a day passing.
   */
  async refresh(
    tx: Tx,
    platformId: string,
    sub: SubscriptionRecord,
    company: SubscriberCompany,
    options: { readonly personId?: string | null; readonly today?: string } = {},
  ): Promise<{
    readonly status: SubscriptionStatus;
    readonly access: CompanyAccess;
    readonly readOnlyFrom: string | null;
    readonly changed: boolean;
    readonly accessChanged: boolean;
  }> {
    const today = options.today ?? this.todayIn(company.timeZone);
    const terms = await termsAsOf(tx, today);
    const facts = await this.factsFor(tx, sub, terms, today);
    const status = subscriptionStatus(facts);
    const derived = subscriptionAccess(facts);
    let changed = false;
    if (status !== sub.status) {
      const cancelledOn = status === 'cancelled' && sub.cancelsOn ? dayAfter(sub.cancelsOn) : null;
      const until =
        status === 'cancelled' && sub.cancelsOn
          ? readOnlyUntil(sub.cancelsOn, terms.retentionDaysAfterCancel)
          : sub.readOnlyUntil;
      await tx.execute(
        sql`update subscription set status = ${status}, cancelled_on = ${cancelledOn}::date,
              read_only_until = ${until}::date, updated_at = now()
            where id = ${sub.id}::uuid`,
      );
      await this.event(tx, platformId, sub, 'status_changed', {
        statusFrom: sub.status,
        statusTo: status,
        actorPersonId: options.personId ?? null,
      });
      changed = true;
    }
    const tier = sub.tier;
    const accessChanged = derived.access !== company.access || tier !== company.plan;
    if (accessChanged)
      await tx.execute(
        sql`select app.apply_subscription_state(${company.id}::uuid, ${tier}, ${derived.access})`,
      );
    return {
      status,
      access: derived.access,
      readOnlyFrom: derived.readOnlyFrom,
      changed,
      accessChanged: derived.access !== company.access,
    };
  }

  /** The facts the status is derived from (the oldest open invoice's due date). */
  async factsFor(tx: Tx, sub: SubscriptionRecord, terms: TermsVersion, today: string) {
    const open = await this.openInvoices(tx, sub.subscriberCompanyId);
    const oldest = open.find((i) => i.outstandingMinor > 0) ?? null;
    return {
      today,
      trialEndsOn: sub.trialEndsOn,
      cancelsOn: sub.cancelsOn,
      oldestUnpaidDueOn: oldest?.dueOn ?? null,
      graceDays: terms.graceDays,
      readOnlyEnabled: terms.readOnlyEnabled,
    };
  }

  /**
   * An event in the subscriber's own audit chain (plan 4.5: each transition audited in both
   * companies' chains), written through the platform's system path in a transaction of its own,
   * after the platform-side change has committed.
   */
  async auditSubscriber(
    subscriberCompanyId: string,
    action: string,
    recordId: string | null,
    data: Record<string, unknown>,
    personId?: string | null,
  ): Promise<void> {
    await withCompany(
      this.database,
      { companyId: subscriberCompanyId, personId: personId ?? null, actorKind: 'system' },
      (tx) =>
        this.audit.append(tx, {
          companyId: subscriberCompanyId,
          action,
          recordType: 'subscription',
          recordId,
          data,
        }),
    );
  }
}

const dayAfter = (day: string): string => toIsoDate(addDays(parseBusinessDate(day), 1));
