import type { AllocationSource, LineKind } from '../billing/lines';
import { DomainError } from '../errors';
import { allocate, money } from '../money/money';
import { FEE_BEARING_KINDS, feeOnBaseMinor, refundFeeReversalMinor } from './fees';

/**
 * Fees tied to allocations (M9 review, must-fix 1). Every rent or service-charge allocation of
 * money (a payment, its credit drawn onto a month, a deposit applied or tax withheld) carries its
 * fee, at the rate in force on its value date, and none when no percentage terms were in force. A
 * negative allocation (a reversal, a release, a credit note's release) undoes the allocations
 * before it of the same line, source and payment, latest first, and takes back their fees in
 * proportion, mirrored exactly: when an allocation is wholly undone, the fee taken back equals the
 * fee it carried. So each pesewa allocated carries its fee once, and undoing it takes the fee back.
 * There is no pooled guard: what an allocation carries depends on it alone.
 *
 * An event's charges (one write of allocations) are rounded once per payment: the rate on the
 * payment's fee-bearing base, half up, split across its allocations by largest remainder. So each
 * posted fee equals its rate on its base, which the nightly check verifies.
 */

/**
 * Allocation sources that are money: only these carry a fee. Never `opening_balance` (P25): money
 * received before the platform carries no fee (M11 decision 3, OQ-64).
 */
export const FEE_SOURCES: readonly AllocationSource[] = ['payment', 'deposit', 'withholding'];

export interface FeeAllocation {
  readonly id: string;
  readonly lineId: string;
  readonly lineKind: LineKind;
  readonly source: AllocationSource;
  readonly paymentId: string | null;
  /** Signed: a negative row undoes earlier rows. */
  readonly amountMinor: number;
  /**
   * P25: the row is paid by an opening payment (`isOpeningAllocation`): money received before the
   * platform, which carries no fee, whether it pays a month at commit or its credit is drawn onto
   * one later. A platform payment that pays an opening line carries its fee as usual.
   */
  readonly opening?: boolean;
}

/** Whether an allocation carries (or takes back) a fee: money on rent or service charge. */
export const feeBearing = (a: Pick<FeeAllocation, 'lineKind' | 'source' | 'opening'>): boolean =>
  a.opening !== true && FEE_BEARING_KINDS.includes(a.lineKind) && FEE_SOURCES.includes(a.source);

const groupKey = (a: FeeAllocation) => `${a.lineId}|${a.source}|${a.paymentId ?? ''}`;

export interface Undoing {
  /** The negative allocation. */
  readonly allocationId: string;
  /** The earlier positive allocation it undoes, in part or whole. */
  readonly undoesId: string;
  readonly amountMinor: number;
}

/**
 * Which earlier allocations each negative allocation in `fresh` undoes: within the same line,
 * source and payment, latest first. `history` is every fee-bearing allocation of the lines
 * concerned, in the order written; the result covers only the negatives in `fresh`. Undoing beyond
 * what was allocated undoes nothing more.
 */
export function undoings(
  history: readonly FeeAllocation[],
  fresh: ReadonlySet<string> | null = null,
): Undoing[] {
  const stacks = new Map<string, { id: string; left: number }[]>();
  const out: Undoing[] = [];
  for (const a of history) {
    if (!feeBearing(a) || a.amountMinor === 0) continue;
    if (!Number.isSafeInteger(a.amountMinor))
      throw new DomainError('fees.bad_amount', 'Allocations are whole pesewas');
    const stack = stacks.get(groupKey(a)) ?? [];
    stacks.set(groupKey(a), stack);
    if (a.amountMinor > 0) {
      stack.push({ id: a.id, left: a.amountMinor });
      continue;
    }
    let left = -a.amountMinor;
    for (let i = stack.length - 1; i >= 0 && left > 0; i -= 1) {
      const top = stack[i]!;
      if (top.left === 0) continue;
      const taken = Math.min(top.left, left);
      top.left -= taken;
      left -= taken;
      if (!fresh || fresh.has(a.id))
        out.push({ allocationId: a.id, undoesId: top.id, amountMinor: taken });
    }
  }
  return out;
}

export interface AllocationCharge {
  readonly allocationId: string;
  readonly baseMinor: number;
  readonly feeMinor: number;
}

export interface PaymentCharge {
  readonly paymentId: string | null;
  readonly rateBps: number;
  readonly baseMinor: number;
  readonly feeMinor: number;
  readonly parts: readonly AllocationCharge[];
}

/**
 * The fee an event's new positive allocations carry at a rate: per payment (withholding and a
 * deposit with no payment form one group), the rate on the base, half up once, split across the
 * allocations by largest remainder. Allocations that are not fee-bearing carry nothing.
 */
export function chargeAllocations(
  rows: readonly FeeAllocation[],
  rateBps: number,
): PaymentCharge[] {
  const groups = new Map<string, FeeAllocation[]>();
  for (const r of rows)
    if (feeBearing(r) && r.amountMinor > 0) {
      const key = r.paymentId ?? '';
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
  return [...groups.values()].map((parts) => {
    const base = parts.reduce((s, p) => s + p.amountMinor, 0);
    const fee = feeOnBaseMinor(base, rateBps);
    const shares = allocate(
      money(fee),
      parts.map((p) => p.amountMinor),
    ).map((m) => m.amountMinor);
    return {
      paymentId: parts[0]!.paymentId,
      rateBps,
      baseMinor: base,
      feeMinor: fee,
      parts: parts.map((p, i) => ({
        allocationId: p.id,
        baseMinor: p.amountMinor,
        feeMinor: shares[i] ?? 0,
      })),
    };
  });
}

/** A charged allocation as stored: its base and fee, and what was taken back so far. */
export interface ChargedAllocation {
  readonly allocationId: string;
  readonly baseMinor: number;
  readonly feeMinor: number;
  readonly takenBaseMinor: number;
  readonly takenFeeMinor: number;
}

export interface FeeTakeBack {
  readonly allocationId: string;
  readonly chargedAllocationId: string;
  /** Base undone, as a positive amount. */
  readonly baseMinor: number;
  /** Fee taken back, as a positive amount. */
  readonly feeMinor: number;
}

/**
 * The fees the undoings take back: for each charged allocation undone, the growth of its undone
 * share of the fee (cumulative, half up, by largest remainder), so the take-backs of a wholly
 * undone allocation add up to its fee exactly. Allocations that carried no fee give nothing back.
 */
export function takeBacks(
  undone: readonly Undoing[],
  charged: ReadonlyMap<string, ChargedAllocation>,
): FeeTakeBack[] {
  const taken = new Map<string, number>();
  const out: FeeTakeBack[] = [];
  for (const u of undone) {
    const c = charged.get(u.undoesId);
    if (!c) continue;
    const before = (taken.get(u.undoesId) ?? 0) + c.takenBaseMinor;
    const amount = Math.min(u.amountMinor, Math.max(0, c.baseMinor - before));
    if (amount <= 0) continue;
    const fee = refundFeeReversalMinor({
      feeMinor: c.feeMinor,
      baseMinor: c.baseMinor,
      refundedBaseBeforeMinor: before,
      refundedBaseMinor: amount,
    });
    taken.set(u.undoesId, (taken.get(u.undoesId) ?? 0) + amount);
    out.push({
      allocationId: u.allocationId,
      chargedAllocationId: u.undoesId,
      baseMinor: amount,
      feeMinor: fee,
    });
  }
  return out;
}

/**
 * What an allocation's fee should be net of take-backs, given how much of its base is still live:
 * the fee less the undone share (the nightly check's invariant).
 */
export function liveFeeMinor(input: {
  readonly baseMinor: number;
  readonly feeMinor: number;
  readonly undoneBaseMinor: number;
}): number {
  if (input.undoneBaseMinor <= 0) return input.feeMinor;
  const undone = Math.min(input.undoneBaseMinor, input.baseMinor);
  return (
    input.feeMinor -
    refundFeeReversalMinor({
      feeMinor: input.feeMinor,
      baseMinor: input.baseMinor,
      refundedBaseBeforeMinor: 0,
      refundedBaseMinor: undone,
    })
  );
}
