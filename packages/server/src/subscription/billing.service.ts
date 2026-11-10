import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database, type Tx } from '@rent/db';
import { subscriptionInvoiceV1, type SubscriptionInvoiceDocumentData } from '@rent/documents';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { subscriptionInvoiceLines, subscriptionPostingKeys } from '@rent/domain/ledger';
import { format, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import {
  billableUnits,
  billingStartsOn,
  countsByBand,
  discountTermsOf,
  inAnnualTerm,
  isBillingBand,
  monthBounds,
  monthlyBill,
  monthOf,
  nextMonth,
  previousMonth,
  redemptionCovers,
  shiftMonth,
  tierSpans,
  type BandCounts,
  type DiscountTerms,
  type SnapshotUnit,
  type SnapshotUnitInput,
} from '@rent/domain/subscription';
import { staffActor } from '../companies/companies.service';
import { AppError, conflict, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PostingService } from '../ledger/posting.service';
import { PolicyService } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { priceListsAsOf, subscriptionVatAsOf, termsAsOf } from './catalogue';
import {
  SubscriptionCoreService,
  type SubscriberCompany,
  type SubscriptionRecord,
} from './core.service';
import { settleFromCredit } from './credit';
import { notifySubscriber } from './notices';
import { nextSubscriptionNumber } from './numbering';
import { lockSubscription, platformBookId, withPlatform } from './platform';

export const SUBSCRIPTION_SNAPSHOT_JOB = 'subscription.snapshot';
export const SUBSCRIPTION_INVOICE_JOB = 'subscription.invoice';

/** How many ended months one run of the snapshot or invoice job catches up, at most (BE-13). */
export const CATCH_UP_MONTHS = 3;

export const SUBSCRIPTION_INVOICE_TEMPLATE = {
  key: subscriptionInvoiceV1.key,
  version: subscriptionInvoiceV1.version,
} as const;

const DOWNLOAD_MS = 5 * 60_000;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** The later of two optional days (null means no bound). */
const laterOf = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a > b ? a : b;

const monthLabel = (month: string): string =>
  `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** The subscriber's units with the leases that became active (D8 input), in its own context. */
export async function unitsWithLeases(tx: Tx): Promise<SnapshotUnitInput[]> {
  const rows = await tx.execute<{
    unit_id: string;
    unit_code: string;
    band: string;
    lease_id: string;
    start_date: string;
    last_day: string | null;
  }>(
    sql`select u.id as unit_id, u.code as unit_code, u.billing_band as band, l.id as lease_id,
          l.start_date::text, coalesce(l.move_out_date, l.ended_on)::text as last_day
        from unit u join lease l on l.company_id = u.company_id and l.unit_id = u.id
        where l.status in ('active', 'ending', 'holding_over', 'ended', 'terminated')
        order by u.code, l.start_date, l.id`,
  );
  const units = new Map<
    string,
    SnapshotUnitInput & { leases: SnapshotUnitInput['leases'][number][] }
  >();
  for (const r of rows.rows) {
    if (!isBillingBand(r.band)) continue;
    const unit = units.get(r.unit_id) ?? {
      unitId: r.unit_id,
      unitCode: r.unit_code,
      band: r.band,
      leases: [],
    };
    unit.leases.push({ leaseId: r.lease_id, startDate: r.start_date, lastDay: r.last_day });
    units.set(r.unit_id, unit);
  }
  return [...units.values()];
}

export interface SnapshotRecord {
  readonly id: string;
  readonly month: string;
  readonly takenAt: Date;
  readonly counts: BandCounts;
}

export interface InvoiceIssued {
  readonly id: string;
  readonly number: string;
  readonly totalMinor: number;
}

/**
 * Billing (M10 plan 4.3; decision 2, monthly in arrears): on the 1st, the snapshot of last
 * month's billable units by band (D8, PB-02), unit by unit and frozen; then the invoice priced
 * with the price list in force for the month and the tier days from the subscription's history,
 * with the minimum, the discount and VAT lines when charged; numbered gap-free, posted (P26),
 * settled from prepaid credit first, rendered, and told to the company's admins.
 */
@Injectable()
export class SubscriptionBillingService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SubscriptionCoreService) private readonly core: SubscriptionCoreService,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  /** The subscriber company, read from the platform's side; null for anything else. */
  private async company(subscriberCompanyId: string): Promise<SubscriberCompany | null> {
    return withPlatform(this.database, {}, (tx) =>
      this.core.subscriberCompany(tx, subscriberCompanyId),
    );
  }

  /**
   * The ended months a job run bills for one subscriber, oldest first (M10 review BE-13): every
   * month that has ended in the subscriber's own time zone by `asOf`, after the latest month it
   * was invoiced for, and at most the last {@link CATCH_UP_MONTHS}; never a month before its
   * subscription started or billing went on, nor after a cancellation's last month. `asOf` is the
   * earlier of the subscriber's today and the job's date: a run for a day never bills a month that
   * ended after it, and a company west of Accra waits until its own month has ended.
   */
  async dueMonths(
    subscriberCompanyId: string,
    options: { readonly date?: string | null } = {},
  ): Promise<{ readonly asOf: string; readonly months: readonly string[] } | null> {
    const company = await this.company(subscriberCompanyId);
    if (!company) return null;
    const today = this.core.todayIn(company.timeZone);
    const asOf = options.date && options.date < today ? options.date : today;
    const months = await withPlatform(this.database, {}, async (tx, platformId) => {
      const activation = await this.core.billingActivation(tx);
      if (!activation) return [];
      const sub = await this.core.ensure(tx, platformId, company);
      const lastEnded = previousMonth(monthOf(asOf));
      const latest = await tx.execute<{ month: string | null }>(
        sql`select max(month) as month from subscription_invoice
            where subscriber_company_id = ${subscriberCompanyId}::uuid`,
      );
      const candidates = [
        shiftMonth(lastEnded, 1 - CATCH_UP_MONTHS),
        monthOf(sub.startedOn),
        monthOf(activation.startsOn),
        ...(latest.rows[0]?.month ? [nextMonth(latest.rows[0].month)] : []),
      ];
      const last =
        sub.cancelsOn && monthOf(sub.cancelsOn) < lastEnded ? monthOf(sub.cancelsOn) : lastEnded;
      const due: string[] = [];
      for (let m = candidates.reduce((a, b) => (a > b ? a : b)); m <= last; m = nextMonth(m))
        due.push(m);
      return due;
    });
    return { asOf, months };
  }

  /**
   * The `subscription.snapshot` job for one subscriber (daily, review BE-13): the snapshot of
   * every month {@link dueMonths} gives that has none yet, oldest first; returns those it took.
   * Idempotent per month.
   */
  async snapshotDue(
    subscriberCompanyId: string,
    options: { readonly date?: string | null } = {},
  ): Promise<SnapshotRecord[]> {
    const due = await this.dueMonths(subscriberCompanyId, options);
    const taken: SnapshotRecord[] = [];
    for (const month of due?.months ?? []) {
      if (await this.findSnapshot(subscriberCompanyId, month)) continue;
      const snapshot = await this.snapshot(subscriberCompanyId, month);
      if (snapshot) taken.push(snapshot);
    }
    return taken;
  }

  /**
   * The `subscription.invoice` job for one subscriber (daily, review BE-13): the invoice of every
   * month {@link dueMonths} gives, oldest first, so numbers and allocation follow the months.
   * Months with nothing billable (a trial) issue nothing. Idempotent per month.
   */
  async invoiceDue(
    subscriberCompanyId: string,
    options: { readonly date?: string | null } = {},
  ): Promise<InvoiceIssued[]> {
    const due = await this.dueMonths(subscriberCompanyId, options);
    const issued: InvoiceIssued[] = [];
    for (const month of due?.months ?? []) {
      const invoice = await this.invoice(subscriberCompanyId, { month });
      if (invoice) issued.push(invoice);
    }
    return issued;
  }

  /**
   * `subscription.snapshot` for one subscriber: last month's billable units (or `month`), read in
   * the subscriber's own context and stored in the platform company's. Idempotent per month.
   */
  async snapshot(subscriberCompanyId: string, month?: string): Promise<SnapshotRecord | null> {
    const company = await this.company(subscriberCompanyId);
    if (!company) return null;
    const target = month ?? previousMonth(monthOf(this.core.todayIn(company.timeZone)));
    const existing = await this.findSnapshot(subscriberCompanyId, target);
    if (existing) return existing;
    const units = await withCompany(
      this.database,
      { companyId: subscriberCompanyId, actorKind: 'system' },
      (tx) => unitsWithLeases(tx),
      { accessMode: 'read only' },
    );
    const billable = billableUnits(target, units);
    return withPlatform(this.database, {}, async (tx, platformId) => {
      await lockSubscription(tx, subscriberCompanyId);
      const again = await this.snapshotIn(tx, subscriberCompanyId, target);
      if (again) return again;
      const sub = await this.core.ensure(tx, platformId, company);
      if (!(await this.billableMonth(tx, sub, target))) return null;
      return this.insertSnapshot(tx, platformId, sub, target, billable);
    });
  }

  /**
   * Whether a month may be snapshotted and invoiced: billing is on and has started by the month's
   * end (founder answer Q1), and the month is not after a cancellation's last month (review BE-4).
   */
  private async billableMonth(tx: Tx, sub: SubscriptionRecord, month: string): Promise<boolean> {
    const activation = await this.core.billingActivation(tx);
    if (!activation || monthBounds(month).last < activation.startsOn) return false;
    if (sub.cancelsOn && month > monthOf(sub.cancelsOn)) return false;
    return true;
  }

  private async insertSnapshot(
    tx: Tx,
    platformId: string,
    sub: SubscriptionRecord,
    month: string,
    billable: readonly SnapshotUnit[],
  ): Promise<SnapshotRecord> {
    const counts = countsByBand(billable);
    const inserted = await tx.execute<{ id: string; taken_at: Date }>(
      sql`insert into billing_snapshot (company_id, subscription_id, subscriber_company_id, month,
            single_room_units, self_contained_units, commercial_units)
          values (${platformId}::uuid, ${sub.id}::uuid, ${sub.subscriberCompanyId}::uuid, ${month},
            ${counts.single_room}, ${counts.self_contained}, ${counts.commercial})
          returning id, taken_at`,
    );
    const snapshotId = inserted.rows[0]!.id;
    for (const u of billable)
      await tx.execute(
        sql`insert into billing_snapshot_unit (company_id, snapshot_id, unit_id, unit_code, band, lease_id, days_leased)
            values (${platformId}::uuid, ${snapshotId}::uuid, ${u.unitId}::uuid, ${u.unitCode}, ${u.band},
              ${u.leaseId}::uuid, ${u.daysLeased})`,
      );
    return { id: snapshotId, month, takenAt: new Date(inserted.rows[0]!.taken_at), counts };
  }

  private async findSnapshot(subscriberCompanyId: string, month: string) {
    return withPlatform(
      this.database,
      {},
      (tx) => this.snapshotIn(tx, subscriberCompanyId, month),
      {
        accessMode: 'read only',
      },
    );
  }

  private async snapshotIn(
    tx: Tx,
    subscriberCompanyId: string,
    month: string,
  ): Promise<SnapshotRecord | null> {
    const rows = await tx.execute<{
      id: string;
      taken_at: Date;
      single_room_units: number;
      self_contained_units: number;
      commercial_units: number;
    }>(
      sql`select id, taken_at, single_room_units, self_contained_units, commercial_units
          from billing_snapshot where subscriber_company_id = ${subscriberCompanyId}::uuid and month = ${month}`,
    );
    const r = rows.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      month,
      takenAt: new Date(r.taken_at),
      counts: {
        single_room: Number(r.single_room_units),
        self_contained: Number(r.self_contained_units),
        commercial: Number(r.commercial_units),
      },
    };
  }

  /**
   * `subscription.invoice` for one subscriber: last month's invoice (or `month`), from its
   * snapshot (taken first if missing). Nothing billable in the month (all trial, or the
   * subscription did not exist yet) issues nothing. Idempotent per subscriber and month.
   */
  async invoice(
    subscriberCompanyId: string,
    options: {
      readonly month?: string;
      /** For the test-control route only: issue and due dates, and bill the whole month. */
      readonly dates?: { readonly issuedOn: string; readonly dueOn: string };
      readonly wholeMonth?: boolean;
    } = {},
  ): Promise<InvoiceIssued | null> {
    const company = await this.company(subscriberCompanyId);
    if (!company) return null;
    const today = this.core.todayIn(company.timeZone);
    const month = options.month ?? previousMonth(monthOf(today));
    const snapshot = await this.snapshot(subscriberCompanyId, month);
    if (!snapshot) return null;
    const issued = await withPlatform(this.database, {}, async (tx, platformId) => {
      await lockSubscription(tx, subscriberCompanyId);
      const existing = await tx.execute<{ id: string; number: string; total_minor: string }>(
        sql`select id, number, total_minor from subscription_invoice
            where subscriber_company_id = ${subscriberCompanyId}::uuid and month = ${month}`,
      );
      if (existing.rows[0])
        return {
          created: false,
          id: existing.rows[0].id,
          number: existing.rows[0].number,
          totalMinor: Number(existing.rows[0].total_minor),
        };
      const sub = await this.core.ensure(tx, platformId, company);
      if (!(await this.billableMonth(tx, sub, month))) return null;
      const result = await this.issue(tx, platformId, sub, company, snapshot, {
        month,
        issuedOn: options.dates?.issuedOn ?? today,
        dueOn: options.dates?.dueOn ?? null,
        wholeMonth: options.wholeMonth ?? false,
      });
      if (!result) return null;
      // In the subscriber's chain with the invoice (review BE-12).
      await this.core.auditSubscriberIn(
        tx,
        subscriberCompanyId,
        'subscription.invoice_issued',
        result.id,
        { number: result.number, month, totalMinor: result.totalMinor },
        `subscription_invoice:${result.id}`,
      );
      // Told with the invoice, in the same transaction (review BE-12).
      await notifySubscriber(tx, platformId, subscriberCompanyId, {
        key: `invoice:${result.id}:issued`,
        subject: `Subscription invoice ${result.number}`,
        body: `Your subscription invoice ${result.number} for ${monthLabel(month)} is ${format(money(result.totalMinor))}. It is on the subscription page, where you can pay it by MoMo or card.`,
        related: { type: 'subscription_invoice', id: result.id },
      });
      await this.core.refresh(tx, platformId, sub, company, { today });
      return { created: true, ...result };
    });
    if (!issued) return null;
    return { id: issued.id, number: issued.number, totalMinor: issued.totalMinor };
  }

  /** Prices, numbers, posts and settles one invoice from prepaid credit; renders its PDF. */
  private async issue(
    tx: Tx,
    platformId: string,
    sub: SubscriptionRecord,
    company: SubscriberCompany,
    snapshot: SnapshotRecord,
    options: {
      readonly month: string;
      readonly issuedOn: string;
      readonly dueOn: string | null;
      readonly wholeMonth: boolean;
    },
  ): Promise<InvoiceIssued | null> {
    const { month } = options;
    const bounds = monthBounds(month);
    const activation = await this.core.billingActivation(tx);
    const prices = await priceListsAsOf(tx, bounds.first);
    const history = await this.core.tierHistory(tx, sub.id);
    const spans = tierSpans({
      month,
      changes: options.wholeMonth
        ? [{ tier: sub.tier, from: bounds.first }]
        : history.length > 0
          ? history
          : [{ tier: sub.tier, from: sub.startedOn }],
      billFrom: options.wholeMonth
        ? null
        : laterOf(billingStartsOn(sub.trialEndsOn), activation?.startsOn ?? null),
      billTo: options.wholeMonth ? null : sub.cancelsOn,
      pricesFor: (tier) => prices[tier],
    });
    if (spans.length === 0) return null;
    const terms = await termsAsOf(tx, options.issuedOn);
    const vat = await subscriptionVatAsOf(tx, this.rules, terms, options.issuedOn);
    const discount = await this.discountFor(tx, sub.subscriberCompanyId, month);
    const annual = await this.annualFor(tx, sub.subscriberCompanyId, month);
    const bill = monthlyBill({
      month,
      counts: snapshot.counts,
      spans,
      annual,
      discount,
      vat: vat.rates,
    });
    const year = Number(options.issuedOn.slice(0, 4));
    const number = await nextSubscriptionNumber(tx, platformId, 'invoice', year);
    const dueOn =
      options.dueOn ?? toIsoDate(addDays(parseBusinessDate(options.issuedOn), terms.dueDays));
    // The versions the month was priced with: the domain's span keeps only the rates, so read the
    // ids and the placeholder flag from the price lists themselves (review).
    const priceListIds = [...new Set(spans.map((s) => prices[s.tier].id))];
    const placeholder = spans.some((s) => prices[s.tier].placeholder);
    const inserted = await tx.execute<{ id: string }>(
      sql`insert into subscription_invoice (company_id, subscription_id, subscriber_company_id, number, month,
            snapshot_id, issued_on, due_on, subtotal_minor, discount_minor, net_minor, vat_minor, total_minor,
            price_list_ids, terms_id, vat_rule_id, vat_unverified, template_key, template_version)
          values (${platformId}::uuid, ${sub.id}::uuid, ${sub.subscriberCompanyId}::uuid, ${number}, ${month},
            ${snapshot.id}::uuid, ${options.issuedOn}::date, ${dueOn}::date, ${bill.subtotalMinor},
            ${bill.discountMinor}, ${bill.netMinor}, ${bill.vatMinor}, ${bill.totalMinor},
            ${`{${priceListIds.join(',')}}`}::uuid[], ${terms.id}::uuid, ${vat.ruleId}::uuid,
            ${vat.unverified}, ${SUBSCRIPTION_INVOICE_TEMPLATE.key}, ${SUBSCRIPTION_INVOICE_TEMPLATE.version})
          returning id`,
    );
    const invoiceId = inserted.rows[0]!.id;
    let lineNo = 0;
    for (const line of bill.lines) {
      lineNo += 1;
      await tx.execute(
        sql`insert into subscription_invoice_line (company_id, invoice_id, line_no, kind, description, tier, band,
              units, rate_minor, days, days_in_month, rate_bps, amount_minor)
            values (${platformId}::uuid, ${invoiceId}::uuid, ${lineNo}, ${line.kind}, ${line.description},
              ${line.tier}, ${line.band}, ${line.units}, ${line.rateMinor}, ${line.days}, ${line.daysInMonth},
              ${line.rateBps}, ${line.amountMinor})`,
      );
    }
    const bookId = await platformBookId(tx, platformId);
    if (bill.totalMinor > 0)
      await this.posting.post(tx, {
        companyId: platformId,
        rule: 'P26',
        key: subscriptionPostingKeys.invoice(invoiceId),
        // Revenue in the month it covers (review BE-9): dated the billed month's last day (never
        // after the issue date; only ended months are billed); the accounting date follows the
        // usual period rules (PostingService).
        valueDate: bounds.last < options.issuedOn ? bounds.last : options.issuedOn,
        lines: subscriptionInvoiceLines({
          bookId,
          invoiceId,
          netMinor: bill.netMinor,
          vatMinor: bill.vatMinor,
        }),
        record: { type: 'subscription_invoice', id: invoiceId },
      });
    // Prepaid credit (2020) first: an annual prepayment or an overpayment (decision 7), drawn onto
    // the open invoices oldest first, so credit never sits beside debt (review BE-3).
    const drawn = await settleFromCredit(
      tx,
      { core: this.core, posting: this.posting },
      platformId,
      sub.subscriberCompanyId,
      options.issuedOn,
    );
    const drawMinor = drawn
      .filter((d) => d.invoiceId === invoiceId)
      .reduce((sum, d) => sum + d.amountMinor, 0);
    const draw = { drawMinor, shortfallMinor: bill.totalMinor - drawMinor };
    if (bill.totalMinor === 0)
      await tx.execute(
        sql`update subscription_invoice set status = 'paid', paid_at = now(), updated_at = now()
            where id = ${invoiceId}::uuid`,
      );
    const data: SubscriptionInvoiceDocumentData = {
      platformName: await this.platformName(tx, platformId),
      subscriberName: company.displayName,
      subscriberLegalName: company.legalName,
      number,
      month,
      monthLabel: monthLabel(month),
      issuedOn: options.issuedOn,
      dueOn,
      lines: bill.lines.map((l) => ({ description: l.description, amountMinor: l.amountMinor })),
      subtotalMinor: bill.subtotalMinor,
      discountMinor: bill.discountMinor,
      netMinor: bill.netMinor,
      vatMinor: bill.vatMinor,
      totalMinor: bill.totalMinor,
      prepaidMinor: draw.drawMinor,
      amountDueMinor: draw.shortfallMinor,
      vatUnverified: vat.unverified,
      placeholderPrices: placeholder,
      billableUnits: {
        singleRoom: snapshot.counts.single_room,
        selfContained: snapshot.counts.self_contained,
        commercial: snapshot.counts.commercial,
      },
    };
    const renderRequestId = await this.documents.requestRender(tx, {
      companyId: platformId,
      templateKey: SUBSCRIPTION_INVOICE_TEMPLATE.key,
      templateVersion: SUBSCRIPTION_INVOICE_TEMPLATE.version,
      data: data as unknown as Record<string, unknown>,
    });
    await tx.execute(
      sql`update subscription_invoice set render_request_id = ${renderRequestId}::uuid, updated_at = now()
          where id = ${invoiceId}::uuid`,
    );
    return { id: invoiceId, number, totalMinor: bill.totalMinor };
  }

  private async platformName(tx: Tx, platformId: string): Promise<string> {
    const rows = await tx.execute<{ display_name: string }>(
      sql`select display_name from company where id = ${platformId}::uuid`,
    );
    return rows.rows[0]?.display_name ?? 'The platform';
  }

  /** The discount code in force for the month (decision 8): the latest redemption covering it. */
  async discountFor(
    tx: Tx,
    subscriberCompanyId: string,
    month: string,
  ): Promise<DiscountTerms | null> {
    const rows = await tx.execute<{
      first_month: string;
      months: number;
      code: string;
      kind: 'percentage' | 'fixed';
      percent_bps: number | null;
      amount_minor: string | null;
      code_months: number;
      expires_on: string | null;
      max_uses: number | null;
    }>(
      sql`select r.first_month, r.months, c.code, c.kind, c.percent_bps, c.amount_minor, c.months as code_months,
            c.expires_on::text, c.max_uses
          from discount_redemption r join discount_code c on c.company_id = r.company_id and c.id = r.discount_code_id
          where r.subscriber_company_id = ${subscriberCompanyId}::uuid
          order by r.applied_at desc, r.id desc`,
    );
    const found = rows.rows.find((r) => redemptionCovers(r.first_month, Number(r.months), month));
    if (!found) return null;
    return discountTermsOf({
      code: found.code,
      kind: found.kind,
      percentBps: found.percent_bps === null ? null : Number(found.percent_bps),
      amountMinor: found.amount_minor === null ? null : Number(found.amount_minor),
      months: Number(found.code_months),
      expiresOn: found.expires_on,
      maxUses: found.max_uses === null ? null : Number(found.max_uses),
      uses: 0,
    });
  }

  /** Whether a paid annual term covers the month (decision 7: discounted rates while it runs). */
  async annualFor(tx: Tx, subscriberCompanyId: string, month: string): Promise<boolean> {
    const rows = await tx.execute<{ first: string; last: string }>(
      sql`select annual_first_month as first, annual_last_month as last from subscription_payment
          where subscriber_company_id = ${subscriberCompanyId}::uuid and purpose = 'annual' and status = 'succeeded'`,
    );
    return rows.rows.some((r) => inAnnualTerm({ firstMonth: r.first, lastMonth: r.last }, month));
  }

  /** `documents.rendered` for an invoice: its document and fingerprint, recorded once. */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    return withPlatform(this.database, {}, async (tx, platformId) => {
      if (companyId !== platformId) return false;
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      if (
        !rendered ||
        rendered.templateKey !== SUBSCRIPTION_INVOICE_TEMPLATE.key ||
        rendered.status !== 'rendered' ||
        !rendered.documentId ||
        !rendered.sha256
      )
        return false;
      const updated = await tx.execute(
        sql`update subscription_invoice set document_id = ${rendered.documentId}::uuid,
              sha256 = ${rendered.sha256}, updated_at = now()
            where render_request_id = ${renderRequestId}::uuid and document_id is null`,
      );
      return (updated.rowCount ?? 0) > 0;
    });
  }

  /** A subscriber's invoice PDF (`subscription.read`): a 5-minute link. */
  async invoiceDocument(actor: Actor | null, invoiceId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'subscription.read');
    return this.invoiceDocumentFor(staff.companyId, invoiceId);
  }

  /** The same for the console (the caller has checked the platform admin). */
  async invoiceDocumentFor(
    subscriberCompanyId: string,
    invoiceId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const { platformId, row } = await withPlatform(
      this.database,
      {},
      async (tx, platformId) => {
        const rows = await tx.execute<{
          number: string;
          document_id: string | null;
          render_request_id: string | null;
        }>(
          sql`select number, document_id, render_request_id from subscription_invoice
              where id = ${invoiceId}::uuid and subscriber_company_id = ${subscriberCompanyId}::uuid`,
        );
        let row = rows.rows[0] ?? null;
        if (row && !row.document_id && row.render_request_id) {
          const rendered = await this.documents.renderedDocument(tx, row.render_request_id);
          if (rendered?.status === 'rendered' && rendered.documentId)
            row = { ...row, document_id: rendered.documentId };
        }
        return { platformId, row };
      },
      { accessMode: 'read only' },
    );
    if (!row) throw notFound('Invoice');
    if (!row.document_id)
      throw conflict('document_rendering', 'The PDF is still being made. Try again in a moment.');
    const url = await this.documents.downloadUrl(platformId, row.document_id, `${row.number}.pdf`);
    if (!url) throw notFound('Invoice document');
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_MS) };
  }

  /**
   * For the gated test-control route (e2e assumption A1): an open invoice through the normal
   * path, for the latest month with none, billed for the whole month at the current tier, dated
   * so it fell due `dueDaysAgo` days ago. The caller then runs that day's dunning.
   */
  async forceOverdueInvoice(
    subscriberCompanyId: string,
    dueDaysAgo: number,
  ): Promise<InvoiceIssued> {
    if (!Number.isSafeInteger(dueDaysAgo) || dueDaysAgo < 0 || dueDaysAgo > 365)
      throw new AppError(400, 'bad_days', 'dueDaysAgo must be 0 to 365');
    const company = await this.company(subscriberCompanyId);
    if (!company) throw notFound('Company');
    const today = this.core.todayIn(company.timeZone);
    const dueOn = toIsoDate(addDays(parseBusinessDate(today), -dueDaysAgo));
    const terms = await withPlatform(this.database, {}, (tx) => termsAsOf(tx, dueOn));
    const issuedOn = toIsoDate(addDays(parseBusinessDate(dueOn), -terms.dueDays));
    let month = previousMonth(monthOf(issuedOn));
    for (let i = 0; i < 24; i += 1) {
      const taken = await withPlatform(this.database, {}, (tx) =>
        tx.execute(
          sql`select 1 from subscription_invoice where subscriber_company_id = ${subscriberCompanyId}::uuid
              and month = ${month}`,
        ),
      );
      if (taken.rows.length === 0) break;
      month = previousMonth(month);
    }
    const activation = await withPlatform(this.database, {}, (tx) =>
      this.core.billingActivation(tx),
    );
    if (!activation)
      throw new AppError(409, 'billing_off', 'Billing is not on yet, so nothing is invoiced');
    const issued = await this.invoice(subscriberCompanyId, {
      month,
      dates: { issuedOn, dueOn },
      wholeMonth: true,
    });
    if (!issued) throw new AppError(409, 'nothing_billable', 'Nothing to bill for that month');
    return issued;
  }
}
