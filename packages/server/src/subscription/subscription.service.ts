import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database, type Tx } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { format, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import {
  COMING_SOON_FEATURES,
  PLAN_FEATURE_NAMES,
  planHas,
  SUBSCRIPTION_TIERS,
  TIER_FEATURES,
  tierOf,
  tierUnlocking,
  type SubscriptionTier,
} from '@rent/domain/settings';
import {
  annualTerm,
  assertRedeemable,
  billableUnits,
  billingStartsOn,
  cancelEffectiveOn,
  compareMonths,
  countsByBand,
  lastCoveredMonth,
  monthBounds,
  monthlyBill,
  monthOf,
  monthsLeft,
  nextMonth,
  normalizeCode,
  percentText,
  subscriptionAccess,
  tierSpans,
  type BandCounts,
  type CompanyAccess,
  type SubscriptionLineKind,
  type SubscriptionStatus,
} from '@rent/domain/subscription';
import type { BillingBand } from '@rent/domain/portfolio';
import writeXlsxFile from 'write-excel-file/node';
import { staffActor } from '../companies/companies.service';
import { AppError, conflict, forbidden, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { formatInvoiceNumber, formatReceiptNumber } from '../billing/records';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { SubscriptionBillingService, unitsWithLeases } from './billing.service';
import { priceListsAsOf, subscriptionVatAsOf, termsAsOf } from './catalogue';
import { SubscriptionCoreService, type SubscriberCompany } from './core.service';
import { lockSubscription, withPlatform } from './platform';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

const TIER_ORDER: Record<SubscriptionTier, number> = { starter: 0, growth: 1, portfolio: 2 };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOWNLOAD_MS = 5 * 60_000;

/** The contract's `subscriptionSchema`. */
export interface SubscriptionView {
  readonly company: { readonly id: string; readonly name: string };
  readonly tier: SubscriptionTier;
  readonly status: SubscriptionStatus;
  readonly access: CompanyAccess;
  readonly trialEndsOn: string | null;
  readonly pendingTier: { readonly tier: SubscriptionTier; readonly from: string } | null;
  readonly cancelsOn: string | null;
  readonly readOnlyUntil: string | null;
  readonly readOnlyFrom: string | null;
  readonly annual: {
    readonly startsOn: string;
    readonly endsOn: string;
    readonly creditMinor: number;
    readonly discountBps: number;
  } | null;
  readonly creditMinor: number;
  readonly discount: {
    readonly code: string;
    readonly description: string;
    readonly monthsLeft: number;
  } | null;
  readonly estimate: {
    readonly month: string;
    readonly billableUnits: BandCounts;
    readonly unitsMinor: number;
    readonly minimumMinor: number;
    readonly totalMinor: number;
  };
  readonly arrears: { readonly pastDueMinor: number; readonly oldestDueOn: string } | null;
  readonly features: {
    readonly feature: (typeof TIER_FEATURES)[number];
    readonly name: string;
    readonly included: boolean;
    readonly unlockTier: SubscriptionTier;
    readonly comingSoon: boolean;
  }[];
  readonly tiers: {
    readonly tier: SubscriptionTier;
    readonly ratesMinor: BandCounts;
    readonly minimumMinor: number;
    readonly placeholder: boolean;
  }[];
  readonly actions: {
    readonly pay: boolean;
    readonly payAnnual: boolean;
    readonly changeTier: boolean;
    readonly applyCode: boolean;
    readonly cancel: boolean;
    readonly withdrawCancel: boolean;
    readonly export: boolean;
    readonly grantSupport: boolean;
  };
}

/** The contract's `subscriptionInvoiceSchema`. */
export interface SubscriptionInvoiceView {
  readonly id: string;
  readonly number: string;
  readonly month: string;
  readonly status: 'open' | 'paid' | 'void';
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly totalMinor: number;
  readonly prepaidMinor: number;
  readonly paidMinor: number;
  readonly outstandingMinor: number;
  readonly pastDue: boolean;
  readonly snapshotId: string;
  readonly hasDocument: boolean;
}

export interface SubscriptionExportView {
  readonly id: string;
  readonly status: 'preparing' | 'ready' | 'failed';
  readonly url: string | null;
  readonly expiresAt: Date | null;
}

/** Turns the domain's refusals into the contract's 409s. */
function refusal(error: unknown): never {
  if (error instanceof DomainError) {
    const code = error.code.replace(/^discount\./, 'discount_').replace(/^subscription\./, '');
    throw conflict(code, error.message);
  }
  throw error;
}

/**
 * The subscription from the subscriber's side and the platform admin's (M10 plan 4.8; decisions
 * 5 to 8 and 12): its view with this month's estimate, invoices, snapshots, tier changes, codes,
 * cancellation and the export; and the console's onboarding, tier, trial and code operations.
 * Subscriber reads run in the subscriber's own context (the select-only policy on its rows);
 * changes run in the platform company's, under the subscription lock, then go in the subscriber's
 * own audit chain.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SubscriptionCoreService) private readonly core: SubscriptionCoreService,
    @Inject(SubscriptionBillingService) private readonly billing: SubscriptionBillingService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  private reader(staff: StaffActor) {
    this.policy.assert(staff, 'subscription.read');
    return staff;
  }

  private manager(actor: Actor | null): StaffActor {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'subscription.manage');
    return staff;
  }

  private async subscriber(companyId: string): Promise<SubscriberCompany> {
    const company = await withPlatform(this.database, {}, (tx) =>
      this.core.subscriberCompany(tx, companyId),
    );
    if (!company) throw notFound('Company');
    return company;
  }

  // Reading -------------------------------------------------------------------------------------

  async view(actor: Actor | null): Promise<SubscriptionView> {
    const staff = this.reader(staffActor(actor));
    return this.viewFor(staff.companyId, staff);
  }

  /** The view for a company; `viewer` decides the actions (a platform admin when absent). */
  async viewFor(companyId: string, viewer?: StaffActor): Promise<SubscriptionView> {
    const company = await this.subscriber(companyId);
    const today = this.core.todayIn(company.timeZone);
    const month = monthOf(today);
    const units = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      (tx) => unitsWithLeases(tx),
      { accessMode: 'read only' },
    );
    return withPlatform(this.database, {}, async (tx, platformId) => {
      const sub = await this.core.ensure(tx, platformId, company);
      const terms = await termsAsOf(tx, today);
      const prices = await priceListsAsOf(tx, today);
      const monthPrices = await priceListsAsOf(tx, monthBounds(month).first);
      const history = await this.core.tierHistory(tx, sub.id);
      const vat = await subscriptionVatAsOf(tx, this.rules, terms, today);
      const discount = await this.billing.discountFor(tx, companyId, month);
      const annual = await this.billing.annualFor(tx, companyId, month);
      const spans = tierSpans({
        month,
        changes: history.length > 0 ? history : [{ tier: sub.tier, from: sub.startedOn }],
        billFrom: billingStartsOn(sub.trialEndsOn),
        billTo: sub.cancelsOn,
        pricesFor: (tier) => monthPrices[tier],
      });
      const counts = countsByBand(billableUnits(month, units, today));
      const bill =
        spans.length > 0
          ? monthlyBill({ month, counts, spans, annual, discount, vat: vat.rates })
          : null;
      const facts = await this.core.factsFor(tx, sub, terms, today);
      const access = subscriptionAccess(facts);
      const open = await this.core.openInvoices(tx, companyId);
      const pastDue = open.filter((i) => i.outstandingMinor > 0 && i.dueOn < today);
      const outstanding = open.reduce((s, i) => s + Math.max(0, i.outstandingMinor), 0);
      const credit = Math.max(0, await this.core.creditMinor(tx, companyId));
      const annualTermRow = await tx.execute<{ first: string; last: string; bps: number }>(
        sql`select annual_first_month as first, annual_last_month as last, annual_discount_bps as bps
            from subscription_payment where subscriber_company_id = ${companyId}::uuid
              and purpose = 'annual' and status = 'succeeded' and annual_last_month >= ${month}
            order by annual_first_month desc limit 1`,
      );
      const term = annualTermRow.rows[0];
      const redemption = await tx.execute<{
        code: string;
        kind: 'percentage' | 'fixed';
        percent_bps: number | null;
        amount_minor: string | null;
        first_month: string;
        months: number;
      }>(
        sql`select c.code, c.kind, c.percent_bps, c.amount_minor, r.first_month, r.months
            from discount_redemption r join discount_code c on c.company_id = r.company_id and c.id = r.discount_code_id
            where r.subscriber_company_id = ${companyId}::uuid order by r.applied_at desc, r.id desc`,
      );
      const running = redemption.rows.find(
        (r) => compareMonths(lastCoveredMonth(r.first_month, Number(r.months)), month) >= 0,
      );
      const can = (action: 'subscription.manage' | 'support.grant') =>
        viewer ? this.policy.can(viewer, action).allowed : action === 'subscription.manage';
      const manage = can('subscription.manage');
      const ending = sub.status === 'cancel_scheduled' || sub.status === 'cancelled';
      return {
        company: { id: company.id, name: company.displayName },
        tier: sub.tier,
        status: sub.status,
        access: company.access,
        trialEndsOn: sub.status === 'trialing' ? sub.trialEndsOn : null,
        pendingTier:
          sub.pendingTier && sub.pendingTierFrom
            ? { tier: sub.pendingTier, from: sub.pendingTierFrom }
            : null,
        cancelsOn: sub.cancelsOn,
        readOnlyUntil: sub.readOnlyUntil,
        readOnlyFrom: access.readOnlyFrom,
        annual: term
          ? {
              startsOn: annualTerm(term.first).startsOn,
              endsOn: annualTerm(term.first).endsOn,
              creditMinor: credit,
              discountBps: Number(term.bps),
            }
          : null,
        creditMinor: term ? 0 : credit,
        discount: running
          ? {
              code: running.code,
              description:
                running.kind === 'percentage'
                  ? `${percentText(Number(running.percent_bps))} off for ${running.months} month${Number(running.months) === 1 ? '' : 's'}`
                  : `${format(money(Number(running.amount_minor)))} off each month for ${running.months} month${Number(running.months) === 1 ? '' : 's'}`,
              monthsLeft: monthsLeft(running.first_month, Number(running.months), month),
            }
          : null,
        estimate: {
          month,
          billableUnits: counts,
          unitsMinor: bill
            ? bill.lines.filter((l) => l.kind === 'units').reduce((s, l) => s + l.amountMinor, 0)
            : 0,
          minimumMinor: bill
            ? bill.lines.filter((l) => l.kind === 'minimum').reduce((s, l) => s + l.amountMinor, 0)
            : 0,
          totalMinor: bill?.totalMinor ?? 0,
        },
        arrears:
          pastDue.length > 0
            ? {
                pastDueMinor: pastDue.reduce((s, i) => s + i.outstandingMinor, 0),
                oldestDueOn: pastDue[0]!.dueOn,
              }
            : null,
        features: TIER_FEATURES.map((feature) => ({
          feature,
          name: PLAN_FEATURE_NAMES[feature],
          included: planHas(sub.tier, feature),
          unlockTier: tierUnlocking(feature),
          comingSoon: COMING_SOON_FEATURES.includes(feature),
        })),
        tiers: SUBSCRIPTION_TIERS.map((tier) => ({
          tier,
          ratesMinor: prices[tier].ratesMinor,
          minimumMinor: prices[tier].minimumMinor,
          placeholder: prices[tier].placeholder,
        })),
        actions: {
          pay: manage && outstanding > 0,
          payAnnual: manage && !term && !ending,
          changeTier: manage && !ending,
          applyCode: manage && !running && !ending,
          cancel: manage && !ending,
          withdrawCancel: manage && sub.status === 'cancel_scheduled',
          export: manage,
          grantSupport: viewer ? can('support.grant') : false,
        },
      };
    });
  }

  async invoices(actor: Actor | null): Promise<SubscriptionInvoiceView[]> {
    const staff = this.reader(staffActor(actor));
    return withCompany(this.database, staffContext(staff), (tx) =>
      this.invoiceRows(tx, staff.companyId),
    );
  }

  /** The console's list of a company's invoices (the caller checked the platform admin). */
  async invoiceViewsFor(companyId: string): Promise<SubscriptionInvoiceView[]> {
    return withPlatform(this.database, {}, (tx) => this.invoiceRows(tx, companyId), {
      accessMode: 'read only',
    });
  }

  private async invoiceRows(
    tx: Tx,
    companyId: string,
    invoiceId?: string,
  ): Promise<SubscriptionInvoiceView[]> {
    const rows = await tx.execute<{
      id: string;
      number: string;
      month: string;
      status: 'open' | 'paid' | 'void';
      issued_on: string;
      due_on: string;
      total_minor: string;
      prepaid_minor: string;
      paid_minor: string;
      snapshot_id: string;
      render_request_id: string | null;
      document_id: string | null;
      today: string;
    }>(
      sql`select i.id, i.number, i.month, i.status, i.issued_on::text, i.due_on::text, i.total_minor,
            coalesce((select sum(a.amount_minor) from subscription_allocation a
                      where a.company_id = i.company_id and a.invoice_id = i.id and a.source = 'prepaid'), 0) as prepaid_minor,
            coalesce((select sum(a.amount_minor) from subscription_allocation a
                      join subscription_payment p on p.company_id = a.company_id and p.id = a.payment_id
                      where a.company_id = i.company_id and a.invoice_id = i.id and a.source = 'payment'
                        and p.status = 'succeeded'), 0) as paid_minor,
            i.snapshot_id, i.render_request_id, i.document_id
          from subscription_invoice i
          where i.subscriber_company_id = ${companyId}::uuid
            ${invoiceId ? sql`and i.id = ${invoiceId}::uuid` : sql``}
          order by i.issued_on desc, i.number desc`,
    );
    const company = await this.subscriber(companyId);
    const today = this.core.todayIn(company.timeZone);
    return rows.rows.map((r) => {
      const total = Number(r.total_minor);
      const prepaid = Number(r.prepaid_minor);
      const paid = Number(r.paid_minor);
      const outstanding = r.status === 'void' ? 0 : Math.max(0, total - prepaid - paid);
      return {
        id: r.id,
        number: r.number,
        month: r.month,
        status: r.status,
        issuedOn: r.issued_on,
        dueOn: r.due_on,
        totalMinor: total,
        prepaidMinor: prepaid,
        paidMinor: paid,
        outstandingMinor: outstanding,
        pastDue: outstanding > 0 && r.due_on < today,
        snapshotId: r.snapshot_id,
        hasDocument: r.document_id !== null || r.render_request_id !== null,
      };
    });
  }

  async invoice(actor: Actor | null, invoiceId: string) {
    const staff = this.reader(staffActor(actor));
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [view] = await this.invoiceRows(tx, staff.companyId, invoiceId);
      if (!view) throw notFound('Invoice');
      const lines = await tx.execute<{
        kind: SubscriptionLineKind;
        description: string;
        tier: string | null;
        band: BillingBand | null;
        units: number | null;
        rate_minor: string | null;
        days: number | null;
        days_in_month: number | null;
        amount_minor: string;
      }>(
        sql`select kind, description, tier, band, units, rate_minor, days, days_in_month, amount_minor
            from subscription_invoice_line where invoice_id = ${invoiceId}::uuid order by line_no`,
      );
      const flags = await tx.execute<{ vat_unverified: boolean }>(
        sql`select vat_unverified from subscription_invoice where id = ${invoiceId}::uuid`,
      );
      return {
        ...view,
        lines: lines.rows.map((l) => ({
          kind: l.kind,
          description: l.description,
          tier: l.tier === null ? null : tierOf(l.tier),
          band: l.band,
          units: l.units === null ? null : Number(l.units),
          rateMinor: l.rate_minor === null ? null : Number(l.rate_minor),
          days: l.days === null ? null : Number(l.days),
          daysInMonth: l.days_in_month === null ? null : Number(l.days_in_month),
          amountMinor: Number(l.amount_minor),
        })),
        vatUnverified: flags.rows[0]?.vat_unverified ?? false,
      };
    });
  }

  async snapshot(actor: Actor | null, snapshotId: string) {
    const staff = this.reader(staffActor(actor));
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx.execute<{
        id: string;
        month: string;
        taken_at: Date;
        single_room_units: number;
        self_contained_units: number;
        commercial_units: number;
      }>(
        sql`select id, month, taken_at, single_room_units, self_contained_units, commercial_units
            from billing_snapshot where id = ${snapshotId}::uuid and subscriber_company_id = ${staff.companyId}::uuid`,
      );
      const s = rows.rows[0];
      if (!s) throw notFound('Snapshot');
      const units = await tx.execute<{
        unit_id: string;
        unit_code: string;
        band: BillingBand;
        lease_id: string;
        days_leased: number;
      }>(
        sql`select unit_id, unit_code, band, lease_id, days_leased from billing_snapshot_unit
            where snapshot_id = ${snapshotId}::uuid order by unit_code`,
      );
      return {
        id: s.id,
        month: s.month,
        takenAt: new Date(s.taken_at),
        countsByBand: {
          single_room: Number(s.single_room_units),
          self_contained: Number(s.self_contained_units),
          commercial: Number(s.commercial_units),
        },
        units: units.rows.map((u) => ({
          unitId: u.unit_id,
          unitCode: u.unit_code,
          band: u.band,
          leaseId: u.lease_id,
          daysLeased: Number(u.days_leased),
        })),
      };
    });
  }

  /** The subscription's history for the console. */
  async eventsFor(companyId: string): Promise<{ at: Date; kind: string; detail: string }[]> {
    return withPlatform(
      this.database,
      {},
      async (tx) => {
        const rows = await tx.execute<{
          occurred_at: Date;
          kind: string;
          status_from: string | null;
          status_to: string | null;
          tier: string | null;
          effective_on: string | null;
          reason: string | null;
        }>(
          sql`select occurred_at, kind, status_from, status_to, tier, effective_on::text, reason
              from subscription_event where subscriber_company_id = ${companyId}::uuid
              order by occurred_at desc, id desc limit 200`,
        );
        return rows.rows.map((r) => ({
          at: new Date(r.occurred_at),
          kind: r.kind,
          detail: [
            r.status_from || r.status_to ? `${r.status_from ?? '—'} → ${r.status_to ?? '—'}` : null,
            r.tier ? `tier ${r.tier}` : null,
            r.effective_on ? `from ${r.effective_on}` : null,
            r.reason,
          ]
            .filter((x): x is string => !!x)
            .join('; '),
        }));
      },
      { accessMode: 'read only' },
    );
  }

  // Changing ------------------------------------------------------------------------------------

  /** Changes tier (decision 6): an upgrade now, prorated by days; a downgrade on the 1st. */
  async changeTier(actor: Actor | null, tier: SubscriptionTier): Promise<SubscriptionView> {
    const staff = this.manager(actor);
    await this.applyTier(staff.companyId, tier, { personId: staff.personId, byAdmin: null });
    return this.viewFor(staff.companyId, staff);
  }

  private async applyTier(
    companyId: string,
    tier: SubscriptionTier,
    by: { readonly personId: string; readonly byAdmin: { readonly reason: string } | null },
  ): Promise<void> {
    const company = await this.subscriber(companyId);
    const today = this.core.todayIn(company.timeZone);
    const done = await withPlatform(
      this.database,
      { personId: by.personId, actorKind: by.byAdmin ? 'platform_admin' : 'system' },
      async (tx, platformId) => {
        await lockSubscription(tx, companyId);
        const sub = await this.core.ensure(tx, platformId, company);
        if (sub.status === 'cancelled' || sub.status === 'cancel_scheduled')
          throw conflict('subscription_cancelled', 'This subscription is ending; its plan stays');
        const reason = by.byAdmin?.reason ?? null;
        if (tier === sub.tier) {
          if (!sub.pendingTier)
            throw conflict('tier_unchanged', 'The subscription is already on this plan');
          await tx.execute(
            sql`update subscription set pending_tier = null, pending_tier_from = null, updated_at = now()
                where id = ${sub.id}::uuid`,
          );
          await this.core.event(tx, platformId, sub, 'downgrade_withdrawn', {
            tier: sub.pendingTier,
            reason,
            actorPersonId: by.personId,
          });
          return { sub, action: 'downgrade_withdrawn', effectiveOn: null as string | null };
        }
        // A platform admin sets the tier at once either way (decision 6, for pilots).
        if (TIER_ORDER[tier] > TIER_ORDER[sub.tier] || by.byAdmin) {
          await tx.execute(
            sql`update subscription set tier = ${tier}, pending_tier = null, pending_tier_from = null,
                  updated_at = now() where id = ${sub.id}::uuid`,
          );
          await this.core.event(tx, platformId, sub, 'tier_changed', {
            tier,
            effectiveOn: today,
            reason,
            actorPersonId: by.personId,
          });
          const updated = (await this.core.byId(tx, sub.id))!;
          await this.core.refresh(tx, platformId, updated, company, {
            today,
            personId: by.personId,
          });
          return { sub, action: 'tier_changed', effectiveOn: today };
        }
        const from = monthBounds(nextMonth(monthOf(today))).first;
        await tx.execute(
          sql`update subscription set pending_tier = ${tier}, pending_tier_from = ${from}::date, updated_at = now()
              where id = ${sub.id}::uuid`,
        );
        await this.core.event(tx, platformId, sub, 'downgrade_scheduled', {
          tier,
          effectiveOn: from,
          reason,
          actorPersonId: by.personId,
        });
        return { sub, action: 'downgrade_scheduled', effectiveOn: from };
      },
    );
    await this.core.auditSubscriber(
      companyId,
      `subscription.${done.action}`,
      done.sub.id,
      {
        from: done.sub.tier,
        to: tier,
        effectiveOn: done.effectiveOn,
        ...(by.byAdmin ? { reason: by.byAdmin.reason, byPlatformAdmin: true } : {}),
      },
      by.personId,
    );
  }

  /** Applies a discount code (decision 8): one at a time, from this month. */
  async applyCode(actor: Actor | null, code: string): Promise<SubscriptionView> {
    const staff = this.manager(actor);
    await this.redeem(staff.companyId, code, staff.personId, false);
    return this.viewFor(staff.companyId, staff);
  }

  private async redeem(
    companyId: string,
    text: string,
    personId: string,
    byAdmin: boolean,
  ): Promise<void> {
    const company = await this.subscriber(companyId);
    const today = this.core.todayIn(company.timeZone);
    const month = monthOf(today);
    const code = normalizeCode(text);
    const done = await withPlatform(
      this.database,
      { personId, actorKind: byAdmin ? 'platform_admin' : 'system' },
      async (tx, platformId) => {
        await lockSubscription(tx, companyId);
        const sub = await this.core.ensure(tx, platformId, company);
        if (sub.status === 'cancelled' || sub.status === 'cancel_scheduled')
          throw conflict('subscription_cancelled', 'This subscription is ending');
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`discount_code:${code}`}, 29))`,
        );
        const rows = await tx.execute<{
          id: string;
          kind: 'percentage' | 'fixed';
          percent_bps: number | null;
          amount_minor: string | null;
          months: number;
          expires_on: string | null;
          max_uses: number | null;
          uses: number;
        }>(
          sql`select c.id, c.kind, c.percent_bps, c.amount_minor, c.months, c.expires_on::text, c.max_uses,
                (select count(*)::int from discount_redemption r where r.company_id = c.company_id
                   and r.discount_code_id = c.id) as uses
              from discount_code c where c.code = ${code}`,
        );
        const found = rows.rows[0];
        if (!found) throw conflict('discount_unknown', 'There is no discount code like that');
        const mine = await tx.execute<{ code_id: string; first_month: string; months: number }>(
          sql`select discount_code_id as code_id, first_month, months from discount_redemption
              where subscriber_company_id = ${companyId}::uuid`,
        );
        if (mine.rows.some((r) => r.code_id === found.id))
          throw conflict(
            'discount_already_applied',
            'This code was already used on this subscription',
          );
        const active = mine.rows.some(
          (r) => compareMonths(lastCoveredMonth(r.first_month, Number(r.months)), month) >= 0,
        );
        try {
          assertRedeemable(
            {
              code,
              kind: found.kind,
              percentBps: found.percent_bps === null ? null : Number(found.percent_bps),
              amountMinor: found.amount_minor === null ? null : Number(found.amount_minor),
              months: Number(found.months),
              expiresOn: found.expires_on,
              maxUses: found.max_uses === null ? null : Number(found.max_uses),
              uses: Number(found.uses),
            },
            today,
            active,
          );
        } catch (error) {
          refusal(error);
        }
        await tx.execute(
          sql`insert into discount_redemption (company_id, discount_code_id, subscription_id, subscriber_company_id,
                first_month, months, applied_by)
              values (${platformId}::uuid, ${found.id}::uuid, ${sub.id}::uuid, ${companyId}::uuid, ${month},
                ${Number(found.months)}, ${personId}::uuid)`,
        );
        await this.core.event(tx, platformId, sub, 'discount_applied', {
          data: { code, firstMonth: month, months: Number(found.months) },
          actorPersonId: personId,
        });
        return sub;
      },
    );
    await this.core.auditSubscriber(
      companyId,
      'subscription.discount_applied',
      done.id,
      { code, firstMonth: month, ...(byAdmin ? { byPlatformAdmin: true } : {}) },
      personId,
    );
  }

  /** Cancels at the end of this month (decision 12); withdrawn until then. */
  async cancel(actor: Actor | null, reason?: string | null): Promise<SubscriptionView> {
    const staff = this.manager(actor);
    const company = await this.subscriber(staff.companyId);
    const today = this.core.todayIn(company.timeZone);
    const sub = await withPlatform(
      this.database,
      { personId: staff.personId },
      async (tx, platformId) => {
        await lockSubscription(tx, company.id);
        const sub = await this.core.ensure(tx, platformId, company);
        let cancelsOn: string;
        try {
          cancelsOn = cancelEffectiveOn({
            today,
            status: sub.status,
            trialEndsOn: sub.trialEndsOn,
          });
        } catch (error) {
          refusal(error);
        }
        await tx.execute(
          sql`update subscription set cancels_on = ${cancelsOn}::date, cancel_reason = ${reason ?? null},
                updated_at = now() where id = ${sub.id}::uuid`,
        );
        await this.core.event(tx, platformId, sub, 'cancel_scheduled', {
          effectiveOn: cancelsOn,
          reason: reason ?? null,
          actorPersonId: staff.personId,
        });
        const updated = (await this.core.byId(tx, sub.id))!;
        await this.core.refresh(tx, platformId, updated, company, {
          today,
          personId: staff.personId,
        });
        return updated;
      },
    );
    await this.core.auditSubscriber(
      company.id,
      'subscription.cancel_scheduled',
      sub.id,
      { cancelsOn: sub.cancelsOn },
      staff.personId,
    );
    return this.viewFor(staff.companyId, staff);
  }

  async withdrawCancel(actor: Actor | null): Promise<SubscriptionView> {
    const staff = this.manager(actor);
    const company = await this.subscriber(staff.companyId);
    const today = this.core.todayIn(company.timeZone);
    const sub = await withPlatform(
      this.database,
      { personId: staff.personId },
      async (tx, platformId) => {
        await lockSubscription(tx, company.id);
        const sub = await this.core.ensure(tx, platformId, company);
        if (sub.status !== 'cancel_scheduled')
          throw conflict('not_cancelling', 'No cancellation is scheduled');
        await tx.execute(
          sql`update subscription set cancels_on = null, cancel_reason = null, updated_at = now()
              where id = ${sub.id}::uuid`,
        );
        await this.core.event(tx, platformId, sub, 'cancel_withdrawn', {
          actorPersonId: staff.personId,
        });
        const updated = (await this.core.byId(tx, sub.id))!;
        await this.core.refresh(tx, platformId, updated, company, {
          today,
          personId: staff.personId,
        });
        return updated;
      },
    );
    await this.core.auditSubscriber(
      company.id,
      'subscription.cancel_withdrawn',
      sub.id,
      {},
      staff.personId,
    );
    return this.viewFor(staff.companyId, staff);
  }

  // The export (decision 12) --------------------------------------------------------------------

  /**
   * An Excel workbook of the company's properties, units, tenants (never ID numbers), leases,
   * invoices, payments and receipts, stored write-once and served by short-lived link.
   */
  async exportCreate(actor: Actor | null): Promise<SubscriptionExportView> {
    const staff = this.manager(actor);
    const company = await this.subscriber(staff.companyId);
    const sheets = await withCompany(this.database, staffContext(staff), (tx) => exportSheets(tx), {
      accessMode: 'read only',
    });
    const bytes = await writeXlsxFile(
      sheets.map((s) => ({ sheet: s.name, data: s.data })),
    ).toBuffer();
    const exportId = crypto.randomUUID();
    const country = await withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx.execute<{ country_code: string }>(
        sql`select country_code from company where id = ${staff.companyId}::uuid`,
      );
      return rows.rows[0]?.country_code ?? 'GH';
    });
    const file = await this.documents.storeWriteOnce({
      companyId: staff.companyId,
      countryCode: country,
      key: `documents/${staff.companyId}/subscription-exports/${exportId}.xlsx`,
      bytes,
      contentType: XLSX,
    });
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const documentId = await this.documents.recordWriteOnce(tx, file, {
        kind: 'subscription_export',
        createdBy: staff.personId,
      });
      await tx.execute(
        sql`insert into subscription_export (id, company_id, status, document_id, requested_by)
            values (${exportId}::uuid, ${staff.companyId}::uuid, 'ready', ${documentId}::uuid, ${staff.personId}::uuid)`,
      );
    });
    void company;
    return this.exportGet(staff, exportId);
  }

  async exportGet(actor: Actor | null, exportId: string): Promise<SubscriptionExportView> {
    const staff = this.manager(actor);
    const row = await withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx.execute<{
        id: string;
        status: 'preparing' | 'ready' | 'failed';
        document_id: string | null;
      }>(sql`select id, status, document_id from subscription_export where id = ${exportId}::uuid`);
      return rows.rows[0] ?? null;
    });
    if (!row) throw notFound('Export');
    if (row.status !== 'ready' || !row.document_id)
      return { id: row.id, status: row.status, url: null, expiresAt: null };
    const url = await this.documents.downloadUrl(
      staff.companyId,
      row.document_id,
      'company-data.xlsx',
    );
    return {
      id: row.id,
      status: 'ready',
      url,
      expiresAt: url ? new Date(Date.now() + DOWNLOAD_MS) : null,
    };
  }

  // The console (the platform admin's operations) -----------------------------------------------

  private platformAdmin(actor: Actor | null): Extract<Actor, { kind: 'platform_admin' }> {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'company.manage');
    switch (actor.kind) {
      case 'platform_admin':
        return actor;
      default:
        throw forbidden();
    }
  }

  /** Onboarding (decision 14): the new company's subscription, in trial, on the chosen tier. */
  async startFor(
    companyId: string,
    options: {
      readonly tier: SubscriptionTier;
      readonly trialDays?: number | null;
      readonly personId?: string | null;
    },
  ): Promise<void> {
    const company = await this.subscriber(companyId);
    const sub = await withPlatform(
      this.database,
      { personId: options.personId ?? null },
      async (tx, platformId) => {
        const sub = await this.core.ensure(
          tx,
          platformId,
          { ...company, plan: options.tier },
          {
            trialDays: options.trialDays ?? null,
            personId: options.personId ?? null,
          },
        );
        await this.core.refresh(tx, platformId, sub, company);
        return sub;
      },
    );
    await this.core.auditSubscriber(
      companyId,
      'subscription.started',
      sub.id,
      { tier: sub.tier, trialEndsOn: sub.trialEndsOn },
      options.personId ?? null,
    );
  }

  /** A platform admin sets the tier directly, for example for a pilot, with a reason. */
  async setTierByAdmin(
    actor: Actor | null,
    companyId: string,
    tier: SubscriptionTier,
    reason: string,
  ): Promise<void> {
    const admin = this.platformAdmin(actor);
    await this.applyTier(companyId, tier, { personId: admin.personId, byAdmin: { reason } });
  }

  /** A platform admin extends a trial by some days, with a reason (decision 5). */
  async extendTrial(
    actor: Actor | null,
    companyId: string,
    days: number,
    reason: string,
  ): Promise<void> {
    const admin = this.platformAdmin(actor);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365)
      throw new AppError(400, 'bad_days', 'Extend a trial by 1 to 365 days');
    const company = await this.subscriber(companyId);
    const sub = await withPlatform(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      async (tx, platformId) => {
        await lockSubscription(tx, companyId);
        const sub = await this.core.ensure(tx, platformId, company);
        if (sub.status !== 'trialing' || !sub.trialEndsOn)
          throw conflict('not_trialing', 'This subscription is not in its trial');
        const until = toIsoDate(addDays(parseBusinessDate(sub.trialEndsOn), days));
        await tx.execute(
          sql`update subscription set trial_ends_on = ${until}::date, updated_at = now() where id = ${sub.id}::uuid`,
        );
        await this.core.event(tx, platformId, sub, 'trial_extended', {
          effectiveOn: until,
          reason,
          data: { days },
          actorPersonId: admin.personId,
        });
        return { ...sub, trialEndsOn: until };
      },
    );
    await this.core.auditSubscriber(
      companyId,
      'subscription.trial_extended',
      sub.id,
      { trialEndsOn: sub.trialEndsOn, days, reason, byPlatformAdmin: true },
      admin.personId,
    );
  }

  /** A platform admin applies a code for a company (decision 8). */
  async applyCodeAsAdmin(actor: Actor | null, companyId: string, code: string): Promise<void> {
    const admin = this.platformAdmin(actor);
    await this.redeem(companyId, code, admin.personId, true);
  }
}

/** The export's sheets, read in the company's own context (decision 12). No ID numbers. */
async function exportSheets(tx: Tx) {
  type Cell = { value: string } | { value: number; type: NumberConstructor } | null;
  const text = (v: unknown): Cell => (v === null || v === undefined ? null : { value: String(v) });
  const num = (v: unknown): Cell =>
    v === null || v === undefined ? null : { value: Number(v), type: Number };
  const head = (cols: string[]): Cell[] => cols.map((c) => ({ value: c }));
  const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await tx.execute<T>(query)).rows;
  const properties = await q(
    sql`select code, name, property_type, use, town, street, ghanapost_gps from property order by code`,
  );
  const units = await q(
    sql`select u.code, u.label, u.unit_type, u.billing_band, u.availability, p.code as property
        from unit u join property p on p.company_id = u.company_id and p.id = u.property_id order by u.code`,
  );
  const tenants = await q(
    sql`select display_name, kind, legal_name, phone, email, occupation from tenant order by display_name`,
  );
  const leases = await q(
    sql`select u.code as unit, t.display_name as tenant, l.status, l.use, l.start_date::text, l.end_date::text,
          l.monthly_rent_minor, l.deposit_minor, l.rent_cycle
        from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
        join tenant t on t.company_id = l.company_id and t.id = l.tenant_id order by u.code, l.start_date`,
  );
  const invoices = await q(
    sql`select i.number, i.kind, i.unit_code, i.billed_to_name, i.issue_date::text, i.due_date::text,
          coalesce((select sum(x.amount_minor) from invoice_line x where x.company_id = i.company_id and x.invoice_id = i.id), 0) as total_minor
        from invoice i order by i.issue_date, i.number`,
  );
  const payments = await q(
    sql`select received_on::text, method, amount_minor, provider, sender_reference, payer_name from payment order by received_on, created_at`,
  );
  const receipts = await q(
    sql`select number, kind, amount_minor, issued_at from receipt order by issued_at, number`,
  );
  const sheet = (name: string, cols: string[], rows: Cell[][]) => ({
    name,
    data: [head(cols), ...rows],
  });
  return [
    sheet(
      'Properties',
      ['Code', 'Name', 'Type', 'Use', 'Town', 'Street', 'GhanaPost GPS'],
      properties.map((r) =>
        [r.code, r.name, r.property_type, r.use, r.town, r.street, r.ghanapost_gps].map(text),
      ),
    ),
    sheet(
      'Units',
      ['Code', 'Label', 'Type', 'Billing band', 'Availability', 'Property'],
      units.map((r) =>
        [r.code, r.label, r.unit_type, r.billing_band, r.availability, r.property].map(text),
      ),
    ),
    sheet(
      'Tenants',
      ['Name', 'Kind', 'Legal name', 'Phone', 'Email', 'Occupation'],
      tenants.map((r) =>
        [r.display_name, r.kind, r.legal_name, r.phone, r.email, r.occupation].map(text),
      ),
    ),
    sheet(
      'Leases',
      [
        'Unit',
        'Tenant',
        'Status',
        'Use',
        'Start',
        'End',
        'Monthly rent (GHS)',
        'Deposit (GHS)',
        'Rent cycle',
      ],
      leases.map((r) => [
        text(r.unit),
        text(r.tenant),
        text(r.status),
        text(r.use),
        text(r.start_date),
        text(r.end_date),
        text(r.monthly_rent_minor === null ? null : format(money(Number(r.monthly_rent_minor)))),
        text(r.deposit_minor === null ? null : format(money(Number(r.deposit_minor)))),
        text(r.rent_cycle),
      ]),
    ),
    sheet(
      'Invoices',
      ['Number', 'Kind', 'Unit', 'Billed to', 'Issued', 'Due', 'Total (pesewas)'],
      invoices.map((r) => [
        text(formatInvoiceNumber(Number(r.number))),
        text(r.kind),
        text(r.unit_code),
        text(r.billed_to_name),
        text(r.issue_date),
        text(r.due_date),
        num(r.total_minor),
      ]),
    ),
    sheet(
      'Payments',
      ['Received', 'Method', 'Amount (pesewas)', 'Provider', 'Reference', 'Payer'],
      payments.map((r) => [
        text(r.received_on),
        text(r.method),
        num(r.amount_minor),
        text(r.provider),
        text(r.sender_reference),
        text(r.payer_name),
      ]),
    ),
    sheet(
      'Receipts',
      ['Number', 'Kind', 'Amount (pesewas)', 'Issued (UTC)'],
      receipts.map((r) => [
        text(formatReceiptNumber(Number(r.number))),
        text(r.kind),
        num(r.amount_minor),
        text(r.issued_at instanceof Date ? r.issued_at.toISOString() : r.issued_at),
      ]),
    ),
  ];
}
