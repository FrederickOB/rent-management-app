import { allocate, money } from '../money/money';

/**
 * Daily reconciliation (CLAUDE.md section 8; M4b plan 4.8): the provider's transactions against
 * our payments, then each settlement against the payments it pays out. Missing payments go
 * through the normal path; anything unexplained is flagged for a person.
 */
export interface ProviderCharge {
  readonly reference: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface LocalProviderPayment {
  readonly reference: string;
  readonly amountMinor: number;
  readonly reversed: boolean;
}

export type TransactionException =
  | { readonly kind: 'missing_here'; readonly reference: string }
  | { readonly kind: 'missing_at_provider'; readonly reference: string }
  | {
      readonly kind: 'amount_differs';
      readonly reference: string;
      readonly providerMinor: number;
      readonly localMinor: number;
    }
  | {
      readonly kind: 'not_successful_at_provider';
      readonly reference: string;
      readonly status: string;
    };

export interface TransactionReconciliation {
  /** Successful at the provider and unknown here: verify and post through the normal path. */
  readonly toProcess: readonly string[];
  readonly exceptions: readonly TransactionException[];
  readonly matched: number;
}

export function reconcileTransactions(
  provider: readonly ProviderCharge[],
  local: readonly LocalProviderPayment[],
): TransactionReconciliation {
  const ours = new Map(local.map((p) => [p.reference, p]));
  const theirs = new Map(provider.map((c) => [c.reference, c]));
  const toProcess: string[] = [];
  const exceptions: TransactionException[] = [];
  let matched = 0;
  for (const charge of provider) {
    const payment = ours.get(charge.reference);
    if (!payment) {
      if (charge.status === 'success') {
        toProcess.push(charge.reference);
        exceptions.push({ kind: 'missing_here', reference: charge.reference });
      }
      continue;
    }
    if (charge.status !== 'success' && !payment.reversed) {
      exceptions.push({
        kind: 'not_successful_at_provider',
        reference: charge.reference,
        status: charge.status,
      });
      continue;
    }
    if (charge.amountMinor !== payment.amountMinor) {
      exceptions.push({
        kind: 'amount_differs',
        reference: charge.reference,
        providerMinor: charge.amountMinor,
        localMinor: payment.amountMinor,
      });
      continue;
    }
    matched += 1;
  }
  for (const payment of local)
    if (!theirs.has(payment.reference) && !payment.reversed)
      exceptions.push({ kind: 'missing_at_provider', reference: payment.reference });
  return { toProcess, exceptions, matched };
}

export interface SettlementReport {
  readonly settlementId: string;
  readonly grossMinor: number;
  readonly feesMinor: number;
  readonly netMinor: number;
  readonly references: readonly string[];
}

export interface SettledPayment {
  readonly reference: string;
  readonly paymentId: string;
  readonly bookId: string;
  readonly amountMinor: number;
}

export interface SettlementPart {
  readonly bookId: string;
  readonly grossMinor: number;
  readonly feesMinor: number;
  readonly netMinor: number;
  readonly paymentIds: readonly string[];
}

export interface SettlementReconciliation {
  /** One part per book, fees shared by gross (largest remainder), ready for P22. */
  readonly parts: readonly SettlementPart[];
  readonly unknownReferences: readonly string[];
  /** The report's gross less the payments it names, and its own arithmetic. */
  readonly grossDifferenceMinor: number;
  readonly arithmeticHolds: boolean;
}

/**
 * Matches a settlement report to its payments and splits it by book (P22: one entry per
 * settlement per book). Fees are shared across books in proportion to gross, so the parts add up
 * to the report exactly. Any difference is returned, never absorbed.
 */
export function reconcileSettlement(
  report: SettlementReport,
  payments: readonly SettledPayment[],
): SettlementReconciliation {
  const byReference = new Map(payments.map((p) => [p.reference, p]));
  const unknownReferences: string[] = [];
  const books = new Map<string, { gross: number; paymentIds: string[] }>();
  for (const reference of report.references) {
    const payment = byReference.get(reference);
    if (!payment) {
      unknownReferences.push(reference);
      continue;
    }
    const book = books.get(payment.bookId) ?? { gross: 0, paymentIds: [] };
    book.gross += payment.amountMinor;
    book.paymentIds.push(payment.paymentId);
    books.set(payment.bookId, book);
  }
  const entries = [...books.entries()];
  const knownGross = entries.reduce((sum, [, b]) => sum + b.gross, 0);
  const fees =
    entries.length === 0 || knownGross === 0
      ? entries.map(() => 0)
      : allocate(
          money(report.feesMinor),
          entries.map(([, b]) => b.gross),
        ).map((m) => m.amountMinor);
  const parts = entries.map(([bookId, b], i) => {
    const feesMinor = fees[i] ?? 0;
    return {
      bookId,
      grossMinor: b.gross,
      feesMinor,
      netMinor: b.gross - feesMinor,
      paymentIds: b.paymentIds,
    };
  });
  return {
    parts,
    unknownReferences,
    grossDifferenceMinor: report.grossMinor - knownGross,
    arithmeticHolds: report.grossMinor - report.feesMinor === report.netMinor,
  };
}
