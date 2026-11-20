import { addDays, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';
import { allocate, money, multiplyBps } from '../money/money';
import { isOpeningAllocation, type AllocationRow } from '../billing/lines';
import type { WalkResult } from '../billing/walk';

/**
 * Rent tax per receipt (TX-01, TX-02; P17; decision D9, unverified; M5 plan section 2 and 5.1).
 *
 * Tax is due on rent received, advances included. A receipt's base is the rent it adds to what
 * the lease's money covers within the term: the forward walk's coverage after the receipt, less
 * the base already taxed on the lease. Measured that way, a later payment that pays invoices an
 * earlier payment's credit was expected to cover is taxed on the months that credit moves to,
 * money beyond the term is not rent until something applies it, and the base taxed on the lease
 * never exceeds the rent it charges. Every value comes from the rules table, passed in.
 */
export interface RentTaxRules {
  /** `rent_tax.rate.residential` or `.commercial`, for the lease's use. */
  readonly rateBps: number;
  /** `rent_tax.includes_service_charge` (unverified). */
  readonly includesServiceCharge: boolean;
  /** `rent_tax.due_days_after_receipt`. */
  readonly dueDays: number;
  /** `rent_tax.alert_days`. */
  readonly alertDays: readonly number[];
}

/** One charge period of the lease, as the tax sees it. */
export interface TaxPeriod {
  /** The charge period's id: stable whether or not it is invoiced yet. */
  readonly key: string;
  readonly kind: 'rent' | 'service_charge';
  /** The period's amount after credit notes. */
  readonly amountMinor: number;
  /** What all the lease's live money covers of it: allocations plus credit applied forward. */
  readonly coveredMinor: number;
  /** Base already taxed on it by live tax items (net of reversals). */
  readonly taxedBaseMinor: number;
  /** Tax already on it by live tax items. */
  readonly taxMinor: number;
  /** Withholding was recorded on it: its tax is the amount withheld (P19), not this rule. */
  readonly withheld: boolean;
}

export interface TaxPin {
  readonly key: string;
  readonly baseMinor: number;
}

const taxable = (p: TaxPeriod, rules: Pick<RentTaxRules, 'includesServiceCharge'>) =>
  !p.withheld && (p.kind === 'rent' || rules.includesServiceCharge);

/**
 * The receipt's taxable base, and the periods it is pinned to: first where coverage exceeds what
 * is taxed, in the walk's order, then any period with room. Deposits, VAT, one-off charges and
 * withheld periods are never in it.
 *
 * Without corrections the base taxed on the lease equals the rent its money covers after every
 * receipt. A reversal mirrors its payment's tax (P21) and a credit note leaves tax in place
 * (OQ-19), so either can leave the two apart; the next receipts then catch up, but a receipt is
 * never taxed on more than its own rent money (`capMinor`: the payment less what it paid towards
 * deposits, VAT and one-off charges).
 */
export function receiptTaxBase(
  periods: readonly TaxPeriod[],
  rules: Pick<RentTaxRules, 'includesServiceCharge'>,
  capMinor: number = Number.MAX_SAFE_INTEGER,
): { readonly baseMinor: number; readonly pins: readonly TaxPin[] } {
  const eligible = periods.filter((p) => taxable(p, rules));
  for (const p of eligible)
    if (p.coveredMinor < 0 || p.coveredMinor > p.amountMinor || p.taxedBaseMinor < 0)
      throw new DomainError('tax.bad_period', `Period ${p.key} is covered beyond its amount`);
  const covered = eligible.reduce((sum, p) => sum + p.coveredMinor, 0);
  const taxed = eligible.reduce((sum, p) => sum + p.taxedBaseMinor, 0);
  const baseMinor = Math.max(0, Math.min(covered - taxed, capMinor));
  let remaining = baseMinor;
  const pins = new Map<string, number>();
  const pin = (p: TaxPeriod, room: number) => {
    const amount = Math.min(room - (pins.get(p.key) ?? 0), remaining);
    if (amount <= 0) return;
    pins.set(p.key, (pins.get(p.key) ?? 0) + amount);
    remaining -= amount;
  };
  for (const p of eligible) pin(p, p.coveredMinor - p.taxedBaseMinor);
  for (const p of eligible) pin(p, p.amountMinor - p.taxedBaseMinor);
  if (remaining !== 0) throw new DomainError('tax.base_unpinned', 'The base could not be pinned');
  return {
    baseMinor,
    pins: [...pins].map(([key, base]) => ({ key, baseMinor: base })),
  };
}

export interface TaxLine {
  readonly key: string;
  readonly baseMinor: number;
  readonly taxMinor: number;
}

/**
 * The tax on a receipt: the rate on its whole base, rounded half up once (`rent_tax.rounding`),
 * split across its periods by largest remainder. No period's tax ever exceeds the rate on its
 * amount: a pesewa of rounding that would go over moves to a period with room, or is dropped.
 */
export function receiptTax(
  pins: readonly TaxPin[],
  periods: readonly TaxPeriod[],
  rateBps: number,
): { readonly taxMinor: number; readonly lines: readonly TaxLine[] } {
  const base = pins.reduce((sum, p) => sum + p.baseMinor, 0);
  if (base === 0) return { taxMinor: 0, lines: [] };
  const byKey = new Map(periods.map((p) => [p.key, p]));
  let total = multiplyBps(money(base), rateBps).amountMinor;
  const shares = allocate(
    money(total),
    pins.map((p) => p.baseMinor),
  ).map((m) => m.amountMinor);
  const room = pins.map((pin) => {
    const period = byKey.get(pin.key);
    if (!period) throw new DomainError('tax.unknown_period', `No period ${pin.key}`);
    return multiplyBps(money(period.amountMinor), rateBps).amountMinor - period.taxMinor;
  });
  let excess = 0;
  for (let i = 0; i < shares.length; i += 1) {
    const over = (shares[i] as number) - Math.max(0, room[i] as number);
    if (over > 0) {
      shares[i] = (shares[i] as number) - over;
      excess += over;
    }
  }
  for (let i = 0; i < shares.length && excess > 0; i += 1) {
    const spare = Math.max(0, room[i] as number) - (shares[i] as number);
    const move = Math.min(spare, excess);
    shares[i] = (shares[i] as number) + move;
    excess -= move;
  }
  total -= excess;
  return {
    taxMinor: total,
    lines: pins.map((pin, i) => ({
      key: pin.key,
      baseMinor: pin.baseMinor,
      taxMinor: shares[i] as number,
    })),
  };
}

/**
 * P25 (M11 decision 3; OQ-64): money received before the platform is not rent received through it.
 * The lease's opening payments (payments of source `opening_balance`) and its allocations, so the
 * walk's coverage by that money, paid onto a month or still credit applied forward, is left out.
 */
export interface OpeningMoney {
  readonly paymentIds: ReadonlySet<string>;
  readonly allocations: readonly AllocationRow[];
}

/** What opening money covers of one walk line: its allocations, and the credit the walk applies. */
function openingCover(line: WalkResult['lines'][number], opening: OpeningMoney): number {
  let cover = 0;
  if (line.lineId !== null)
    for (const a of opening.allocations)
      if (a.lineId === line.lineId && isOpeningAllocation(a, opening.paymentIds))
        cover += a.amountMinor;
  for (const d of line.draws) if (opening.paymentIds.has(d.paymentId)) cover += d.amountMinor;
  return cover;
}

/**
 * The periods as the walk covers them, with what live tax items already pin to each. The walk's
 * VAT and levy lines (M4a review 10) are never rent: they are left out, so VAT is never taxed.
 *
 * With `opening` (P25), what opening money covers of a period is out of it altogether: out of its
 * amount and out of its coverage. So an opening payment, or its credit drawn onto later months, is
 * never taxed (it was received before the platform), while a receipt after the cut-over that pays
 * opening arrears, or months the opening credit does not reach, is taxed on the rent it covers as
 * any other. Without `opening`, the periods are as before.
 */
export function taxPeriodsFromWalk(input: {
  readonly walk: WalkResult;
  /** The charge period behind each walk line (invoice line id or charge period id). */
  readonly periodKeyOf: (walkKey: string) => string;
  readonly taxed: ReadonlyMap<string, { readonly baseMinor: number; readonly taxMinor: number }>;
  readonly withheld: ReadonlySet<string>;
  readonly opening?: OpeningMoney | null;
}): TaxPeriod[] {
  const opening = input.opening ?? null;
  const periods = input.walk.lines
    .filter((line) => !line.tax)
    .map((line) => {
      const key = input.periodKeyOf(line.key);
      const all = Math.min(line.netMinor, line.settledMinor + line.creditMinor);
      const before = opening === null ? 0 : Math.min(all, Math.max(0, openingCover(line, opening)));
      const covered = all - before;
      return {
        key,
        kind: line.chargeType,
        amountMinor: line.netMinor - before,
        coveredMinor: covered,
        taxedBaseMinor: input.taxed.get(key)?.baseMinor ?? 0,
        taxMinor: input.taxed.get(key)?.taxMinor ?? 0,
        withheld: input.withheld.has(key),
      };
    });
  // A month brought in twice (an opening line and its raise, founder 2026-11-10) is one period:
  // its lines' amounts and coverage add up, and what is taxed on it counts once.
  const merged = new Map<string, TaxPeriod>();
  for (const p of periods) {
    const was = merged.get(p.key);
    if (!was) merged.set(p.key, p);
    else if (was.kind !== p.kind)
      throw new DomainError('tax.period_kinds', `Period ${p.key} is rent and service charge`);
    else
      merged.set(p.key, {
        ...was,
        amountMinor: was.amountMinor + p.amountMinor,
        coveredMinor: was.coveredMinor + p.coveredMinor,
      });
  }
  return [...merged.values()];
}

/** TX-02: due a set number of days after the value date, alerted on the alert days. */
export function rentTaxDueDate(valueDate: string, dueDays: number): string {
  if (!Number.isInteger(dueDays) || dueDays < 0)
    throw new DomainError('tax.bad_due_days', 'Due days must be a whole number');
  return toIsoDate(addDays(parseBusinessDate(valueDate), dueDays));
}

export function rentTaxAlertDates(valueDate: string, alertDays: readonly number[]): string[] {
  return [...new Set(alertDays)]
    .sort((a, b) => a - b)
    .map((d) => toIsoDate(addDays(parseBusinessDate(valueDate), d)));
}

/** Owners in the business of letting are taxed on income, not per receipt (decision 2, OQ-18). */
export const taxedPerReceipt = (owner: { readonly lettingBusiness: boolean }): boolean =>
  !owner.lettingBusiness;
