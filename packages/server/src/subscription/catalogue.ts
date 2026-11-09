import { sql, type Tx } from '@rent/db';
import { parseBusinessDate } from '@rent/domain/dates';
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from '@rent/domain/settings';
import type { PriceList, SubscriptionVatRates } from '@rent/domain/subscription';
import type { RulesService } from '../rules/rules.service';

/**
 * The platform tables as of a day (decisions 3, 5, 10, 11 and 12): the price list per tier and
 * the subscription terms, each the latest version from on or before the day. Rows are versions,
 * never edited, so an invoice records the ids it was priced with and never changes.
 */
export interface PriceListVersion extends PriceList {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly placeholder: boolean;
  readonly createdAt: Date;
}

export interface TermsVersion {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly trialDays: number;
  readonly graceDays: number;
  readonly readOnlyEnabled: boolean;
  readonly dueDays: number;
  readonly retentionDaysAfterCancel: number;
  readonly vatRegistered: boolean;
  readonly createdAt: Date;
}

interface PriceRow extends Record<string, unknown> {
  id: string;
  tier: SubscriptionTier;
  rate_single_room_minor: string | number;
  rate_self_contained_minor: string | number;
  rate_commercial_minor: string | number;
  minimum_minor: string | number;
  annual_discount_bps: number;
  effective_from: string;
  placeholder: boolean;
  created_at: Date;
}

const toPrice = (r: PriceRow): PriceListVersion => ({
  id: r.id,
  tier: r.tier,
  ratesMinor: {
    single_room: Number(r.rate_single_room_minor),
    self_contained: Number(r.rate_self_contained_minor),
    commercial: Number(r.rate_commercial_minor),
  },
  minimumMinor: Number(r.minimum_minor),
  annualDiscountBps: Number(r.annual_discount_bps),
  effectiveFrom: r.effective_from,
  placeholder: r.placeholder,
  createdAt: new Date(r.created_at),
});

/** Every price list version, newest first within each tier. */
export async function allPriceLists(tx: Tx): Promise<PriceListVersion[]> {
  const rows = await tx.execute<PriceRow>(
    sql`select id, tier, rate_single_room_minor, rate_self_contained_minor, rate_commercial_minor,
          minimum_minor, annual_discount_bps, effective_from::text, placeholder, created_at
        from price_list order by tier, effective_from desc, created_at desc`,
  );
  return rows.rows.map(toPrice);
}

/** The price list in force for each tier on a day. */
export async function priceListsAsOf(
  tx: Tx,
  day: string,
): Promise<Record<SubscriptionTier, PriceListVersion>> {
  const rows = await tx.execute<PriceRow>(
    sql`select distinct on (tier) id, tier, rate_single_room_minor, rate_self_contained_minor,
          rate_commercial_minor, minimum_minor, annual_discount_bps, effective_from::text, placeholder,
          created_at
        from price_list where effective_from <= ${day}::date
        order by tier, effective_from desc, created_at desc`,
  );
  const byTier = new Map(rows.rows.map((r) => [r.tier, toPrice(r)]));
  const out = {} as Record<SubscriptionTier, PriceListVersion>;
  for (const tier of SUBSCRIPTION_TIERS) {
    const found = byTier.get(tier);
    if (!found) throw new Error(`No price list for ${tier} on ${day}`);
    out[tier] = found;
  }
  return out;
}

interface TermsRow extends Record<string, unknown> {
  id: string;
  effective_from: string;
  trial_days: number;
  grace_days: number;
  read_only_enabled: boolean;
  due_days: number;
  retention_days_after_cancel: number;
  vat_registered: boolean;
  created_at: Date;
}

const toTerms = (r: TermsRow): TermsVersion => ({
  id: r.id,
  effectiveFrom: r.effective_from,
  trialDays: Number(r.trial_days),
  graceDays: Number(r.grace_days),
  readOnlyEnabled: r.read_only_enabled,
  dueDays: Number(r.due_days),
  retentionDaysAfterCancel: Number(r.retention_days_after_cancel),
  vatRegistered: r.vat_registered,
  createdAt: new Date(r.created_at),
});

const TERMS_COLUMNS = sql`id, effective_from::text, trial_days, grace_days, read_only_enabled, due_days,
  retention_days_after_cancel, vat_registered, created_at`;

/** Every terms version, newest first. */
export async function allTerms(tx: Tx): Promise<TermsVersion[]> {
  const rows = await tx.execute<TermsRow>(
    sql`select ${TERMS_COLUMNS} from subscription_terms order by effective_from desc, created_at desc`,
  );
  return rows.rows.map(toTerms);
}

/** The terms in force on a day (the earliest version when the day comes before all of them). */
export async function termsAsOf(tx: Tx, day: string): Promise<TermsVersion> {
  const rows = await tx.execute<TermsRow>(
    sql`(select ${TERMS_COLUMNS} from subscription_terms where effective_from <= ${day}::date
         order by effective_from desc, created_at desc limit 1)
        union all
        (select ${TERMS_COLUMNS} from subscription_terms order by effective_from, created_at limit 1)`,
  );
  const row = rows.rows[0];
  if (!row) throw new Error('No subscription terms exist');
  return toTerms(row);
}

export interface SubscriptionVat {
  /** Null when no VAT is charged (the platform is not VAT-registered, decision 10). */
  readonly rates: SubscriptionVatRates | null;
  readonly ruleId: string | null;
  readonly unverified: boolean;
}

/**
 * VAT and levies on a subscription invoice (decision 10): `vat.platform_subscription` as of the
 * day, only while the terms record the platform's VAT registration. Never a hard-coded rate.
 */
export async function subscriptionVatAsOf(
  tx: Tx,
  rules: RulesService,
  terms: TermsVersion,
  day: string,
  country = 'GH',
): Promise<SubscriptionVat> {
  if (!terms.vatRegistered) return { rates: null, ruleId: null, unverified: false };
  const rule = await rules.resolveIn(
    tx,
    country,
    'vat.platform_subscription',
    parseBusinessDate(day),
  );
  const value = rule.value as { vatBps: number; nhilBps: number; getfundBps: number };
  return {
    rates: { vatBps: value.vatBps, nhilBps: value.nhilBps, getfundBps: value.getfundBps },
    ruleId: rule.ruleId,
    unverified: rule.verificationStatus !== 'verified',
  };
}
