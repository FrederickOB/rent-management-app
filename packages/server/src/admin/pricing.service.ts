import { Inject, Injectable } from '@nestjs/common';
import { sql, withSystem, type Database, type Tx } from '@rent/db';
import {
  addDays,
  businessDateOf,
  compareDates,
  DEFAULT_TIME_ZONE,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { PRICING_CATEGORIES, type PricingCategory } from '@rent/domain/messaging';
import type { Actor } from '@rent/domain/policy';
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from '@rent/domain/settings';
import { monthOf, normalizeCode, shiftMonth, type DiscountKind } from '@rent/domain/subscription';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import { isUniqueViolation, sqlStateOf } from '../core/db-errors';
import { conflict, invalid } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import {
  allPriceLists,
  allTerms,
  type PriceListVersion,
  type TermsVersion,
} from '../subscription/catalogue';
import { withPlatform } from '../subscription/platform';
import { platformAdminFor, platformSystemContext, type PlatformAdmin } from './platform-admin';

/** The contract's `priceListSchema`, before serialisation. */
export interface PriceListView {
  readonly id: string;
  readonly tier: SubscriptionTier;
  readonly ratesMinor: {
    readonly single_room: number;
    readonly self_contained: number;
    readonly commercial: number;
  };
  readonly minimumMinor: number;
  readonly annualDiscountBps: number;
  readonly effectiveFrom: string;
  /**
   * The first month it prices ('YYYY-MM'): the first month whose 1st is on or after
   * `effectiveFrom`, because a month is priced with the list in force on its 1st (review BE-25).
   */
  readonly appliesFromMonth: string;
  readonly placeholder: boolean;
  readonly createdAt: Date;
}

/** The first month a list dated `effectiveFrom` prices (a month is priced on its 1st). */
export function firstMonthPriced(effectiveFrom: string): string {
  const month = monthOf(effectiveFrom);
  return effectiveFrom.endsWith('-01') ? month : shiftMonth(month, 1);
}

export type TermsView = TermsVersion;

export interface DiscountCodeView {
  readonly id: string;
  readonly code: string;
  readonly kind: DiscountKind;
  readonly percentBps: number | null;
  readonly amountMinor: number | null;
  readonly months: number;
  readonly expiresOn: string | null;
  readonly maxUses: number | null;
  /** Redemptions so far. */
  readonly uses: number;
  readonly createdAt: Date;
}

export interface WhatsappRateView {
  readonly id: string;
  readonly category: PricingCategory;
  readonly rateMinor: number;
  readonly effectiveFrom: string;
  readonly createdAt: Date;
}

export interface NewPriceList {
  readonly tier: SubscriptionTier;
  readonly ratesMinor: PriceListView['ratesMinor'];
  readonly minimumMinor: number;
  readonly annualDiscountBps: number;
  readonly effectiveFrom: string;
}

export interface NewTerms {
  readonly effectiveFrom: string;
  readonly trialDays: number;
  readonly graceDays: number;
  readonly readOnlyEnabled: boolean;
  readonly dueDays: number;
  readonly retentionDaysAfterCancel: number;
  readonly vatRegistered: boolean;
}

export interface NewDiscountCode {
  readonly code: string;
  readonly kind: DiscountKind;
  readonly percentBps?: number | null;
  readonly amountMinor?: number | null;
  readonly months: number;
  readonly expiresOn?: string | null;
  readonly maxUses?: number | null;
}

/** 400 `effective_from_past`: versions never change what already happened (decision 3). */
const effectiveFromPast = (message: string) => invalid('effective_from_past', message);

const priceView = (p: PriceListVersion): PriceListView => ({
  id: p.id,
  tier: p.tier,
  ratesMinor: {
    single_room: p.ratesMinor.single_room,
    self_contained: p.ratesMinor.self_contained,
    commercial: p.ratesMinor.commercial,
  },
  minimumMinor: p.minimumMinor,
  annualDiscountBps: p.annualDiscountBps,
  effectiveFrom: p.effectiveFrom,
  appliesFromMonth: firstMonthPriced(p.effectiveFrom),
  placeholder: p.placeholder,
  createdAt: p.createdAt,
});

function businessDate(value: string, what: string): string {
  try {
    return toIsoDate(parseBusinessDate(value));
  } catch {
    throw invalid('bad_date', `${what} is not a date such as 2026-12-01`);
  }
}

const nonNegative = (value: number) => Number.isSafeInteger(value) && value >= 0;

interface DiscountRow extends Record<string, unknown> {
  id: string;
  code: string;
  kind: DiscountKind;
  percent_bps: number | null;
  amount_minor: number | null;
  months: number;
  expires_on: string | null;
  max_uses: number | null;
  uses: number;
  created_at: Date | string;
}

const discountView = (r: DiscountRow): DiscountCodeView => ({
  id: r.id,
  code: r.code,
  kind: r.kind,
  percentBps: r.percent_bps === null ? null : Number(r.percent_bps),
  amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
  months: Number(r.months),
  expiresOn: r.expires_on,
  maxUses: r.max_uses === null ? null : Number(r.max_uses),
  uses: Number(r.uses),
  createdAt: new Date(r.created_at),
});

interface RateRow extends Record<string, unknown> {
  id: string;
  category: PricingCategory;
  rate_minor: number;
  effective_from: string;
  created_at: Date | string;
}

const rateView = (r: RateRow): WhatsappRateView => ({
  id: r.id,
  category: r.category,
  rateMinor: Number(r.rate_minor),
  effectiveFrom: r.effective_from,
  createdAt: new Date(r.created_at),
});

/**
 * The console's plans and billing (AD-10; M10 decisions 3, 5, 8, 10 and 15): price list and terms
 * versions, discount codes and the WhatsApp rate table. Versions are new rows from a date, never
 * edits: a price list from a future date, terms from today or later (the database refuses the
 * past too, RA112). An admin's price list is never a placeholder. Each change is in the platform
 * company's audit chain, with the admin as the actor.
 */
@Injectable()
export class PlatformPricingService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Today in Accra: the platform's business day for effective dates. */
  private today(): string {
    return toIsoDate(businessDateOf(instantFrom(this.clock.now()), DEFAULT_TIME_ZONE));
  }

  private inPlatform<T>(admin: PlatformAdmin, fn: (tx: Tx, platformId: string) => Promise<T>) {
    return withPlatform(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      fn,
    );
  }

  // Price lists (PB-03) -----------------------------------------------------------------------

  async priceLists(actor: Actor | null): Promise<PriceListView[]> {
    const admin = platformAdminFor(this.policy, actor, 'pricing.manage');
    const rows = await withSystem(this.database, platformSystemContext(admin), (tx) =>
      allPriceLists(tx),
    );
    return rows.map(priceView);
  }

  async addPriceList(actor: Actor | null, input: NewPriceList): Promise<PriceListView> {
    const admin = platformAdminFor(this.policy, actor, 'pricing.manage');
    if (!SUBSCRIPTION_TIERS.includes(input.tier))
      throw invalid('bad_tier', 'Choose Starter, Growth or Portfolio');
    const from = businessDate(input.effectiveFrom, 'The start date');
    const tomorrow = toIsoDate(addDays(parseBusinessDate(this.today()), 1));
    if (compareDates(parseBusinessDate(from), parseBusinessDate(tomorrow)) < 0)
      throw effectiveFromPast('A new price list starts from tomorrow or later.');
    const rates = input.ratesMinor;
    if (
      ![rates.single_room, rates.self_contained, rates.commercial, input.minimumMinor].every(
        nonNegative,
      )
    )
      throw invalid('bad_amount', 'Rates and the minimum are whole pesewas, 0 or more');
    if (
      !Number.isSafeInteger(input.annualDiscountBps) ||
      input.annualDiscountBps < 0 ||
      input.annualDiscountBps > 10_000
    )
      throw invalid('bad_discount', 'The annual discount is 0 to 10,000 basis points');
    return this.inPlatform(admin, async (tx, platformId) => {
      const id = await this.mapped(
        tx.execute<{ id: string }>(
          sql`select app.add_price_list(${input.tier}, ${rates.single_room}::bigint,
                ${rates.self_contained}::bigint, ${rates.commercial}::bigint,
                ${input.minimumMinor}::bigint, ${input.annualDiscountBps}::int, ${from}::date,
                false) as id`,
        ),
        'A price list for this tier already starts on that day.',
        'price_list_version_exists',
      );
      await this.audit.append(tx, {
        companyId: platformId,
        action: 'pricing.price_list_added',
        recordType: 'price_list',
        recordId: id,
        data: { tier: input.tier, effectiveFrom: from },
      });
      const added = (await allPriceLists(tx)).find((p) => p.id === id)!;
      return priceView(added);
    });
  }

  // Terms (decisions 2, 5, 10, 11 and 12) -----------------------------------------------------

  async terms(actor: Actor | null): Promise<TermsView[]> {
    const admin = platformAdminFor(this.policy, actor, 'pricing.manage');
    return withSystem(this.database, platformSystemContext(admin), (tx) => allTerms(tx));
  }

  async addTerms(actor: Actor | null, input: NewTerms): Promise<TermsView> {
    const admin = platformAdminFor(this.policy, actor, 'pricing.manage');
    const from = businessDate(input.effectiveFrom, 'The start date');
    if (compareDates(parseBusinessDate(from), parseBusinessDate(this.today())) < 0)
      throw effectiveFromPast('New terms start from today or later.');
    const days = [input.trialDays, input.graceDays, input.dueDays, input.retentionDaysAfterCancel];
    if (!days.every(nonNegative)) throw invalid('bad_days', 'Days are whole numbers, 0 or more');
    return this.inPlatform(admin, async (tx, platformId) => {
      const id = await this.mapped(
        tx.execute<{ id: string }>(
          sql`select app.add_subscription_terms(${from}::date, ${input.trialDays}::int,
                ${input.graceDays}::int, ${input.readOnlyEnabled}, ${input.dueDays}::int,
                ${input.retentionDaysAfterCancel}::int, ${input.vatRegistered}) as id`,
        ),
        'Terms already start on that day.',
        'terms_version_exists',
      );
      await this.audit.append(tx, {
        companyId: platformId,
        action: 'pricing.terms_added',
        recordType: 'subscription_terms',
        recordId: id,
        data: {
          effectiveFrom: from,
          trialDays: input.trialDays,
          graceDays: input.graceDays,
          readOnlyEnabled: input.readOnlyEnabled,
          dueDays: input.dueDays,
          retentionDaysAfterCancel: input.retentionDaysAfterCancel,
          vatRegistered: input.vatRegistered,
        },
      });
      return (await allTerms(tx)).find((t) => t.id === id)!;
    });
  }

  // Discount codes (decision 8) ---------------------------------------------------------------

  async discountCodes(actor: Actor | null): Promise<DiscountCodeView[]> {
    const admin = platformAdminFor(this.policy, actor, 'discount.manage');
    return this.inPlatform(admin, async (tx) => (await this.discountRows(tx)).map(discountView));
  }

  async addDiscountCode(actor: Actor | null, input: NewDiscountCode): Promise<DiscountCodeView> {
    const admin = platformAdminFor(this.policy, actor, 'discount.manage');
    const code = normalizeCode(input.code);
    if (!/^[A-Z0-9-]{2,40}$/.test(code))
      throw invalid('discount_code', 'A code is 2 to 40 capital letters, digits and dashes');
    const percentBps = input.percentBps ?? null;
    const amountMinor = input.amountMinor ?? null;
    if (input.kind === 'percentage') {
      if (percentBps === null || amountMinor !== null)
        throw invalid('discount_terms', 'A percentage code has a percentage and no amount');
      if (!Number.isSafeInteger(percentBps) || percentBps < 1 || percentBps > 10_000)
        throw invalid('discount_terms', 'The percentage is 1 to 10,000 basis points');
    } else if (input.kind === 'fixed') {
      if (amountMinor === null || percentBps !== null)
        throw invalid('discount_terms', 'A fixed code has an amount and no percentage');
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 1)
        throw invalid('discount_terms', 'The amount is whole pesewas, more than 0');
    } else throw invalid('discount_terms', 'A code is a percentage or a fixed amount');
    if (!Number.isSafeInteger(input.months) || input.months < 1)
      throw invalid('discount_terms', 'A code covers one billing month or more');
    const maxUses = input.maxUses ?? null;
    if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1))
      throw invalid('discount_terms', 'The cap on uses is 1 or more');
    const expiresOn = input.expiresOn ? businessDate(input.expiresOn, 'The last day') : null;
    if (
      expiresOn !== null &&
      compareDates(parseBusinessDate(expiresOn), parseBusinessDate(this.today())) < 0
    )
      throw invalid('expires_on_past', 'The last day to apply a code is today or later');
    return this.inPlatform(admin, async (tx, platformId) => {
      const taken = await tx.execute(
        sql`select 1 from discount_code where company_id = ${platformId}::uuid and code = ${code}`,
      );
      if (taken.rows.length > 0) throw discountCodeTaken();
      const id = await this.mapped(
        tx.execute<{ id: string }>(
          sql`insert into discount_code (company_id, code, kind, percent_bps, amount_minor, months,
                expires_on, max_uses, created_by)
              values (${platformId}::uuid, ${code}, ${input.kind}, ${percentBps}::int,
                ${amountMinor}::bigint, ${input.months}::int, ${expiresOn}::date,
                ${maxUses}::int, ${admin.personId}::uuid)
              returning id`,
        ),
        null,
        'discount_code_taken',
      );
      const row = (await this.discountRows(tx)).find((r) => r.id === id)!;
      return discountView(row);
    });
  }

  private async discountRows(tx: Tx): Promise<DiscountRow[]> {
    const rows = await tx.execute<DiscountRow>(
      sql`select d.id, d.code, d.kind, d.percent_bps, d.amount_minor, d.months,
            d.expires_on::text as expires_on, d.max_uses, d.created_at,
            (select count(*) from discount_redemption r
              where r.company_id = d.company_id and r.discount_code_id = d.id)::int as uses
          from discount_code d
          order by d.created_at desc, d.id desc`,
    );
    return rows.rows;
  }

  // WhatsApp rates (decision 15): an estimate, never an invoice ------------------------------

  async whatsappRates(actor: Actor | null): Promise<WhatsappRateView[]> {
    const admin = platformAdminFor(this.policy, actor, 'pricing.manage');
    const rows = await withSystem(this.database, platformSystemContext(admin), (tx) =>
      this.rateRows(tx),
    );
    return rows.map(rateView);
  }

  async addWhatsappRate(
    actor: Actor | null,
    input: {
      readonly category: PricingCategory;
      readonly rateMinor: number;
      effectiveFrom: string;
    },
  ): Promise<WhatsappRateView> {
    const admin = platformAdminFor(this.policy, actor, 'pricing.manage');
    if (!PRICING_CATEGORIES.includes(input.category))
      throw invalid('bad_category', 'Choose one of Meta’s pricing categories');
    if (!nonNegative(input.rateMinor))
      throw invalid('bad_amount', 'The rate is whole pesewas, 0 or more');
    const from = businessDate(input.effectiveFrom, 'The start date');
    return this.inPlatform(admin, async (tx, platformId) => {
      const id = await this.mapped(
        tx.execute<{ id: string }>(
          sql`select app.add_whatsapp_rate(${input.category}, ${input.rateMinor}::bigint,
                ${from}::date) as id`,
        ),
        'A rate for this category already starts on that day.',
        'whatsapp_rate_version_exists',
      );
      await this.audit.append(tx, {
        companyId: platformId,
        action: 'pricing.whatsapp_rate_added',
        recordType: 'whatsapp_rate',
        recordId: id,
        data: { category: input.category, rateMinor: input.rateMinor, effectiveFrom: from },
      });
      return rateView((await this.rateRows(tx)).find((r) => r.id === id)!);
    });
  }

  private async rateRows(tx: Tx): Promise<RateRow[]> {
    const rows = await tx.execute<RateRow>(
      sql`select id, category, rate_minor, effective_from::text as effective_from, created_at
          from whatsapp_rate order by category, effective_from desc, created_at desc`,
    );
    return rows.rows;
  }

  /** The new row's id, with the database's refusals as clear errors. */
  private async mapped(
    query: Promise<{ rows: { id: string }[] }>,
    duplicateMessage: string | null,
    duplicateCode: string,
  ): Promise<string> {
    try {
      const result = await query;
      return result.rows[0]!.id;
    } catch (error) {
      if (sqlStateOf(error) === 'RA112')
        throw effectiveFromPast('Prices and terms never change in the past: choose a later date.');
      if (isUniqueViolation(error))
        throw duplicateCode === 'discount_code_taken'
          ? discountCodeTaken()
          : conflict(duplicateCode, duplicateMessage ?? 'That version already exists.');
      throw error;
    }
  }
}

/** 409 `discount_code_taken`. */
export const discountCodeTaken = () =>
  conflict('discount_code_taken', 'A discount code with that name already exists.');
