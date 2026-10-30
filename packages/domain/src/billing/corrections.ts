import { DomainError } from '../errors';
import { multiplyBps, money } from '../money/money';
import type { AllocationPosting, LeaseDimensions, PaymentAmount } from '../ledger/posting';
import type { PlannedAllocation } from './allocation';
import {
  chargedAccountOf,
  isRecurring,
  lineBalance,
  paymentCredit,
  paymentShares,
  postingClassOf,
  type AllocationRow,
  type BillingLine,
  type PaymentRef,
} from './lines';

/** A correction's new allocation rows, with their source. */
export interface CorrectionRow extends PlannedAllocation {
  readonly source: 'payment' | 'credit_note' | 'write_off';
}

export interface ReversalPlan {
  /** Negative rows, one per line the payment pays for now. */
  readonly rows: readonly CorrectionRow[];
  /** The same amounts as the ledger reverses them, by the line's state now. */
  readonly postings: readonly AllocationPosting[];
  /** The payment's credit, which leaves prepayments too. */
  readonly creditMinor: number;
}

/**
 * P21(b): reverses a payment from what it pays for now, never from its first entry. Each line
 * keeps every other payment's share; only this payment's net allocations come off.
 */
export function planPaymentReversal(input: {
  readonly payment: PaymentRef;
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly leaseOf: (lineId: string) => LeaseDimensions;
}): ReversalPlan {
  const rows: CorrectionRow[] = [];
  const postings: AllocationPosting[] = [];
  for (const line of input.lines) {
    const share = paymentShares(line.id, input.allocations).get(input.payment.id) ?? 0;
    if (share === 0) continue;
    rows.push({
      lineId: line.id,
      paymentId: input.payment.id,
      amountMinor: -share,
      source: 'payment',
    });
    postings.push({
      lease: input.leaseOf(line.id),
      invoiceLineId: line.id,
      postingClass: postingClassOf(line),
      amountMinor: share,
    });
  }
  const allocated = postings.reduce((sum, p) => sum + p.amountMinor, 0);
  const creditMinor = paymentCredit(input.payment, input.allocations);
  if (allocated + creditMinor !== input.payment.amountMinor)
    throw new DomainError(
      'billing.reversal_lines_missing',
      'Every line the payment pays for must be passed to reverse it',
    );
  return { rows, postings, creditMinor };
}

/** One line's part of a credit note. */
export interface LineCredit {
  readonly line: BillingLine;
  readonly creditMinor: number;
  /** The part that was still owed: it simply stops being owed. */
  readonly unpaidMinor: number;
  /** Payments' allocations released back to their credit, latest payment first. */
  readonly released: readonly PaymentAmount[];
  /** The account the line was charged to, reversed now; null if it was never charged. */
  readonly chargedTo: ReturnType<typeof chargedAccountOf>;
  readonly rows: readonly CorrectionRow[];
}

function creditOneLine(
  line: BillingLine,
  amountMinor: number,
  allocations: readonly AllocationRow[],
  payments: readonly PaymentRef[],
): LineCredit {
  const balance = lineBalance(line, allocations);
  const unpaidMinor = Math.min(amountMinor, balance.outstandingMinor);
  let toRelease = amountMinor - unpaidMinor;
  const order = new Map(payments.map((p) => [p.id, p.order]));
  const shares = [...paymentShares(line.id, allocations)].sort(([a], [b]) => {
    const x = order.get(a) ?? '';
    const y = order.get(b) ?? '';
    return x < y ? 1 : x > y ? -1 : 0;
  });
  const released: PaymentAmount[] = [];
  for (const [paymentId, share] of shares) {
    if (toRelease === 0) break;
    const amount = Math.min(share, toRelease);
    released.push({ paymentId, amountMinor: amount });
    toRelease -= amount;
  }
  if (toRelease > 0)
    throw new DomainError(
      'billing.credit_exceeds_payments',
      'Only money paid by payments can be released by a credit note',
    );
  return {
    line,
    creditMinor: amountMinor,
    unpaidMinor,
    released,
    chargedTo: chargedAccountOf(line),
    rows: [
      { lineId: line.id, paymentId: null, amountMinor, source: 'credit_note' },
      ...released.map((r) => ({
        lineId: line.id,
        paymentId: r.paymentId,
        amountMinor: -r.amountMinor,
        source: 'payment' as const,
      })),
    ],
  };
}

/**
 * P27: a credit note for a whole line or part of one (approval required, M4a decision 3). The
 * unpaid part is credited first, then payments' money returns to their credit, latest payment
 * first. VAT and levy lines charged on the line follow it, so each stays at its rate of the
 * line's net amount. A deposit is credited only where it is unpaid: money held as a deposit
 * leaves only through the move-out flow (M8).
 */
export function planCreditNote(input: {
  readonly line: BillingLine;
  readonly taxLines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly payments: readonly PaymentRef[];
  readonly amountMinor: number;
}): LineCredit[] {
  const { line, allocations } = input;
  if (line.baseLineId !== null)
    throw new DomainError('billing.credit_tax_line', 'Credit the line the tax is charged on');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new DomainError('billing.bad_amount', 'Credit an amount above zero');
  const balance = lineBalance(line, allocations);
  const creditable =
    line.kind === 'deposit' ? balance.outstandingMinor : balance.netMinor - balance.writtenOffMinor;
  if (input.amountMinor > creditable)
    throw new DomainError(
      'billing.credit_too_large',
      line.kind === 'deposit'
        ? 'Only the unpaid part of a deposit can be credited'
        : 'A credit note cannot exceed what the line charges',
    );
  const result = [creditOneLine(line, input.amountMinor, allocations, input.payments)];
  const netAfter = balance.netMinor - input.amountMinor;
  for (const tax of input.taxLines) {
    if (tax.baseLineId !== line.id || tax.rateBps === null)
      throw new DomainError(
        'billing.not_a_tax_line',
        `Line ${tax.id} is not charged on ${line.id}`,
      );
    const before = multiplyBps(money(balance.netMinor), tax.rateBps).amountMinor;
    const after = multiplyBps(money(netAfter), tax.rateBps).amountMinor;
    const taxBalance = lineBalance(tax, allocations);
    const amount = Math.min(before - after, taxBalance.netMinor - taxBalance.writtenOffMinor);
    if (amount > 0) result.push(creditOneLine(tax, amount, allocations, input.payments));
  }
  return result;
}

/**
 * P24: a write-off of a debt still owed on a charged line (two-person approval). Lines not yet
 * started are credited instead, never written off.
 */
export function planWriteOff(input: {
  readonly line: BillingLine;
  readonly allocations: readonly AllocationRow[];
  readonly amountMinor: number;
}): CorrectionRow {
  if (postingClassOf(input.line) !== 'receivable')
    throw new DomainError(
      'billing.write_off_not_owed',
      'Only a charge already owed can be written off',
    );
  const { outstandingMinor } = lineBalance(input.line, input.allocations);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new DomainError('billing.bad_amount', 'Write off an amount above zero');
  if (input.amountMinor > outstandingMinor)
    throw new DomainError(
      'billing.write_off_too_large',
      'A write-off cannot exceed what is still owed',
    );
  return {
    lineId: input.line.id,
    paymentId: null,
    amountMinor: input.amountMinor,
    source: 'write_off',
  };
}

/**
 * Lines a lease ending on `lastDay` no longer bills (M4a plan 4.4): recurring lines whose period
 * starts after it. They are cancelled by a system credit note with their tax lines.
 */
export function linesAfterEnd(lines: readonly BillingLine[], lastDay: string): BillingLine[] {
  return lines.filter(
    (l) => isRecurring(l.kind) && l.periodStart !== null && l.periodStart > lastDay,
  );
}
