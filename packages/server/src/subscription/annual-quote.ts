import { sql, type Tx } from '@rent/db';
import type { SubscriptionTier } from '@rent/domain/settings';
import {
  annualPrice,
  annualTerm,
  billableUnits,
  countsByBand,
  monthBounds,
  monthlyBill,
  monthOf,
  type SnapshotUnitInput,
} from '@rent/domain/subscription';
import type { RulesService } from '../rules/rules.service';
import { priceListsAsOf, subscriptionVatAsOf, termsAsOf } from './catalogue';

export interface AnnualQuote {
  readonly netMinor: number;
  readonly vatMinor: number;
  readonly totalMinor: number;
  readonly discountBps: number;
  readonly firstMonth: string;
  readonly lastMonth: string;
}

/**
 * The price of a year up front (decision 7; M10 review BE-7): a full month at the current tier,
 * from the units let today at full-month rates, with no discount code; then the annual discount
 * once, floored at 12 × the tier's minimum, VAT on top when charged. The term is the 12 billing
 * months from this one. In the platform company's context; `units` are the subscriber's own,
 * read in its context.
 */
export async function annualQuote(
  tx: Tx,
  rules: RulesService,
  tier: SubscriptionTier,
  today: string,
  units: readonly SnapshotUnitInput[],
): Promise<AnnualQuote> {
  const month = monthOf(today);
  // BE-25: the month is priced with the list in force on its 1st.
  const prices = (await priceListsAsOf(tx, monthBounds(month).first))[tier];
  const terms = await termsAsOf(tx, today);
  const vat = await subscriptionVatAsOf(tx, rules, terms, today);
  const bounds = monthBounds(month);
  const counts = countsByBand(billableUnits(month, units, today));
  const monthlyNetMinor = monthlyBill({
    month,
    counts,
    spans: [{ tier, firstDay: bounds.first, lastDay: bounds.last, prices }],
    annual: false,
    discount: null,
    vat: null,
  }).netMinor;
  const price = annualPrice({
    monthlyNetMinor,
    minimumMinor: prices.minimumMinor,
    annualDiscountBps: prices.annualDiscountBps,
    vat: vat.rates,
  });
  const term = annualTerm(month);
  return {
    netMinor: price.netMinor,
    vatMinor: price.vatMinor,
    totalMinor: price.totalMinor,
    discountBps: prices.annualDiscountBps,
    firstMonth: term.firstMonth,
    lastMonth: term.lastMonth,
  };
}

/** Whether a paid year up front covers this month (one at a time). */
export async function annualRunning(
  tx: Tx,
  subscriberCompanyId: string,
  month: string,
): Promise<boolean> {
  const rows = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from subscription_payment
        where subscriber_company_id = ${subscriberCompanyId}::uuid and purpose = 'annual'
          and status = 'succeeded' and annual_last_month >= ${month}`,
  );
  return Number(rows.rows[0]?.n ?? 0) > 0;
}
