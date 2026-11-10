import { DomainError } from '../errors';
import type { CashAccount } from './accounts';
import { compactLines, type JournalLineDraft, type LineDimensions } from './journal';

/**
 * One posting function per business event: event in, lines out (CLAUDE.md section 4; the rules
 * in architecture section 5). The ledger module's posting service is the only code that writes
 * the lines, in the same transaction as the business record, under an idempotency key.
 */

/** Which account an allocation lands in: earned and owed (1100), prepaid (2010) or a deposit (2100). */
export type PostingClass = 'receivable' | 'prepayment' | 'deposit';

const CLASS_ACCOUNT = { receivable: '1100', prepayment: '2010', deposit: '2100' } as const;

/** The lease dimensions every tenant line carries. */
export interface LeaseDimensions {
  readonly propertyId: string;
  readonly unitId: string;
  readonly leaseId: string;
  readonly tenantId: string;
}

/** Where money sits: the book and account, with the collector or provider where they apply. */
export interface CashSide {
  readonly bookId: string;
  readonly account: CashAccount;
  /** 1060: the person holding the cash or cheque. */
  readonly collectorId?: string | null;
  /** 1050: the provider holding it until settlement (M4b). */
  readonly provider?: string | null;
  readonly settlementAccountId?: string | null;
}

/** An allocation as the ledger sees it: a line, the account class, and a positive amount. */
export interface AllocationPosting {
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly postingClass: PostingClass;
  readonly amountMinor: number;
}

/** Money taken from a payment's place in prepayments (2010). */
export interface PaymentAmount {
  readonly paymentId: string;
  readonly amountMinor: number;
}

const positive = (amount: number, what: string): number => {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new DomainError('ledger.bad_amount', `${what} must be zero or more pesewas`);
  return amount;
};

const total = (amounts: readonly { readonly amountMinor: number }[]): number =>
  amounts.reduce((sum, a) => sum + positive(a.amountMinor, 'An amount'), 0);

const cashDims = (cash: Omit<CashSide, 'account'>): LineDimensions => ({
  collectorId: cash.collectorId ?? null,
  provider: cash.provider ?? null,
  settlementAccountId: cash.settlementAccountId ?? null,
});

/** The credit side of a receipt: each allocation to its class, the surplus to 2010 (P03 to P05). */
function allocationCredits(
  bookId: string,
  paymentId: string,
  allocations: readonly AllocationPosting[],
  surplus: { readonly lease: LeaseDimensions; readonly amountMinor: number } | null,
): JournalLineDraft[] {
  const lines: JournalLineDraft[] = allocations.map((a) => ({
    bookId,
    accountCode: CLASS_ACCOUNT[a.postingClass],
    amountMinor: -positive(a.amountMinor, 'An allocation'),
    ...a.lease,
    invoiceLineId: a.invoiceLineId,
    paymentId,
  }));
  if (surplus && surplus.amountMinor > 0)
    lines.push({
      bookId,
      accountCode: '2010',
      amountMinor: -positive(surplus.amountMinor, 'The surplus'),
      ...surplus.lease,
      paymentId,
    });
  return lines;
}

/**
 * P03 to P06, P08, P10 and P28: money received for a lease and allocated. The cash side is
 * debited where the money now sits; started and one-off lines reduce what is owed (1100), deposit
 * lines become deposits held (2100), and lines not started yet and the surplus become
 * prepayments (2010).
 */
export function receiptLines(input: {
  readonly cash: CashSide;
  readonly bookId: string;
  readonly paymentId: string;
  readonly lease: LeaseDimensions;
  readonly allocations: readonly AllocationPosting[];
  readonly surplusMinor: number;
}): JournalLineDraft[] {
  const amount = total(input.allocations) + positive(input.surplusMinor, 'The surplus');
  if (amount === 0) throw new DomainError('ledger.empty_receipt', 'A receipt needs an amount');
  return compactLines([
    {
      bookId: input.cash.bookId,
      accountCode: input.cash.account,
      amountMinor: amount,
      ...input.lease,
      paymentId: input.paymentId,
      ...cashDims(input.cash),
    },
    ...allocationCredits(input.bookId, input.paymentId, input.allocations, {
      lease: input.lease,
      amountMinor: input.surplusMinor,
    }),
  ]);
}

/**
 * P02 (and P09): a charge period starts. The whole line becomes income; what pays for it comes
 * out of prepayments (its advance allocations, kept on the line, then credit drawn now, taken
 * from the payment), and the rest becomes owed (1100).
 */
export function accrualLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly chargeType: 'rent' | 'service_charge';
  readonly amountMinor: number;
  readonly advance: readonly PaymentAmount[];
  readonly draws: readonly PaymentAmount[];
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The line');
  const prepaid = total(input.advance) + total(input.draws);
  if (prepaid > amount)
    throw new DomainError('ledger.overdrawn', 'A line cannot draw more than it charges');
  const line = { bookId: input.bookId, ...input.lease };
  return compactLines([
    {
      ...line,
      accountCode: input.chargeType === 'rent' ? '4000' : '4100',
      amountMinor: -amount,
      invoiceLineId: input.invoiceLineId,
    },
    ...input.advance.map((a) => ({
      ...line,
      accountCode: '2010' as const,
      amountMinor: a.amountMinor,
      invoiceLineId: input.invoiceLineId,
      paymentId: a.paymentId,
    })),
    ...input.draws.map((d) => ({
      ...line,
      accountCode: '2010' as const,
      amountMinor: d.amountMinor,
      paymentId: d.paymentId,
    })),
    {
      ...line,
      accountCode: '1100',
      amountMinor: amount - prepaid,
      invoiceLineId: input.invoiceLineId,
    },
  ]);
}

/**
 * P02's prepaid part, late (P03): money received before a period started, for a period that has
 * accrued since it arrived, was held as the line's advance; it now pays the line. Dated at the
 * period start, so the receivable is never negative and prepayments right as of every date.
 */
export function lateDrawLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The draw');
  if (amount === 0) return [];
  const line = { bookId: input.bookId, ...input.lease, invoiceLineId: input.invoiceLineId };
  return [
    { ...line, accountCode: '2010', amountMinor: amount, paymentId: input.paymentId },
    { ...line, accountCode: '1100', amountMinor: -amount },
  ];
}

/**
 * P02's credit for a tax line (review 10): as its base line's period starts, credit pays the VAT
 * and levies already owed on it, out of prepayments, payment by payment.
 */
export function creditDrawLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly draws: readonly PaymentAmount[];
}): JournalLineDraft[] {
  const amount = total(input.draws);
  if (amount === 0) return [];
  const line = { bookId: input.bookId, ...input.lease };
  return compactLines([
    ...input.draws.map((d) => ({
      ...line,
      accountCode: '2010' as const,
      amountMinor: d.amountMinor,
      paymentId: d.paymentId,
    })),
    { ...line, accountCode: '1100', amountMinor: -amount, invoiceLineId: input.invoiceLineId },
  ]);
}

/** P01 for one-off lines: the tenant owes it (1100) and it is income (4200) when issued. */
export function oneOffChargeLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly lines: readonly { readonly invoiceLineId: string; readonly amountMinor: number }[];
}): JournalLineDraft[] {
  return compactLines(
    input.lines.flatMap((l) => [
      {
        bookId: input.bookId,
        ...input.lease,
        accountCode: '1100' as const,
        amountMinor: positive(l.amountMinor, 'A charge'),
        invoiceLineId: l.invoiceLineId,
      },
      {
        bookId: input.bookId,
        ...input.lease,
        accountCode: '4200' as const,
        amountMinor: -l.amountMinor,
        invoiceLineId: l.invoiceLineId,
      },
    ]),
  );
}

/** P32: at the tax point the tenant owes the VAT and levies (1100) and the owner owes GRA (2210). */
export function vatChargeLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly lines: readonly { readonly invoiceLineId: string; readonly amountMinor: number }[];
}): JournalLineDraft[] {
  return compactLines(
    input.lines.flatMap((l) => [
      {
        bookId: input.bookId,
        ...input.lease,
        accountCode: '1100' as const,
        amountMinor: positive(l.amountMinor, 'A tax line'),
        invoiceLineId: l.invoiceLineId,
      },
      {
        bookId: input.bookId,
        ...input.lease,
        accountCode: '2210' as const,
        amountMinor: -l.amountMinor,
        invoiceLineId: l.invoiceLineId,
      },
    ]),
  );
}

/** P07: a collector's cash is banked into the owner's account (1010) or handed to the agent (1070). */
export function bankingLines(input: {
  readonly bookId: string;
  readonly collectorId: string;
  readonly to: Extract<CashAccount, '1010' | '1070'>;
  readonly amountMinor: number;
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The amount banked');
  if (amount === 0) throw new DomainError('ledger.empty_banking', 'Bank an amount above zero');
  return [
    {
      bookId: input.bookId,
      accountCode: input.to,
      amountMinor: amount,
      propertyId: input.propertyId ?? null,
    },
    {
      bookId: input.bookId,
      accountCode: '1060',
      amountMinor: -amount,
      collectorId: input.collectorId,
      propertyId: input.propertyId ?? null,
    },
  ];
}

/**
 * P21(b): a payment reversed (a bounced cheque, a wrong entry; a chargeback in M4b). Built from
 * what the payment pays for now, never by mirroring its first entry: started lines are owed
 * again, unstarted lines and its credit leave prepayments, deposit lines leave deposits, and the
 * cash side is credited where the money sits now.
 */
export function paymentReversalLines(input: {
  readonly cash: CashSide;
  readonly bookId: string;
  readonly paymentId: string;
  readonly allocations: readonly AllocationPosting[];
  readonly credit: { readonly lease: LeaseDimensions; readonly amountMinor: number } | null;
}): JournalLineDraft[] {
  const debits = allocationCredits(
    input.bookId,
    input.paymentId,
    input.allocations,
    input.credit,
  ).map((l) => ({ ...l, amountMinor: -l.amountMinor }));
  const amount = debits.reduce((sum, l) => sum + l.amountMinor, 0);
  if (amount === 0) throw new DomainError('ledger.empty_reversal', 'Nothing is left to reverse');
  const lease = input.credit?.lease ?? input.allocations[0]?.lease;
  return compactLines([
    ...debits,
    {
      bookId: input.cash.bookId,
      accountCode: input.cash.account,
      amountMinor: -amount,
      ...(lease ?? {}),
      paymentId: input.paymentId,
      ...cashDims(input.cash),
    },
  ]);
}

/** P23 on arrival: money whose lease nobody knows yet waits in suspense (2090) where it arrived. */
export function unmatchedArrivalLines(input: {
  readonly cash: CashSide;
  readonly paymentId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The amount');
  if (amount === 0) throw new DomainError('ledger.empty_receipt', 'A receipt needs an amount');
  return [
    {
      bookId: input.cash.bookId,
      accountCode: input.cash.account,
      amountMinor: amount,
      paymentId: input.paymentId,
      ...cashDims(input.cash),
    },
    {
      bookId: input.cash.bookId,
      accountCode: '2090',
      amountMinor: -amount,
      paymentId: input.paymentId,
    },
  ];
}

/**
 * P23 on matching: the suspense clears and the money is allocated as P03. When the suspense sits
 * in the company book and the lease in an owner book, the company book gives up the asset holding
 * the money and the owner book takes it, so each book balances.
 */
export function unmatchedMatchLines(input: {
  readonly suspenseBookId: string;
  readonly bookId: string;
  /** Where the money sits, in both books when they differ (1070 for an agency's client account). */
  readonly holding: CashSide;
  /**
   * Money already settled by the provider (P22) sits in parts: its net in the account it was paid
   * into, its fee in 5200 (M4b). When given, these move between the books instead of `holding`;
   * they add up to the payment.
   */
  readonly holdings?: readonly {
    readonly side: Omit<CashSide, 'account'> & { readonly account: CashAccount | '5200' };
    readonly amountMinor: number;
  }[];
  readonly paymentId: string;
  readonly lease: LeaseDimensions;
  readonly allocations: readonly AllocationPosting[];
  readonly surplusMinor: number;
}): JournalLineDraft[] {
  const amount = total(input.allocations) + positive(input.surplusMinor, 'The surplus');
  if (amount === 0) throw new DomainError('ledger.empty_receipt', 'A match needs an amount');
  const credits = allocationCredits(input.bookId, input.paymentId, input.allocations, {
    lease: input.lease,
    amountMinor: input.surplusMinor,
  });
  const suspense: JournalLineDraft = {
    bookId: input.suspenseBookId,
    accountCode: '2090',
    amountMinor: amount,
    paymentId: input.paymentId,
  };
  if (input.suspenseBookId === input.bookId) return compactLines([suspense, ...credits]);
  const parts: NonNullable<typeof input.holdings> = input.holdings ?? [
    { side: input.holding, amountMinor: amount },
  ];
  if (parts.reduce((sum, p) => sum + positive(p.amountMinor, 'A holding'), 0) !== amount)
    throw new DomainError('ledger.holdings_differ', 'The money moved must add up to the payment');
  const moves = parts.flatMap((part) => {
    const holding = {
      accountCode: part.side.account,
      paymentId: input.paymentId,
      ...cashDims(part.side),
    };
    return [
      { ...holding, bookId: input.suspenseBookId, amountMinor: -part.amountMinor },
      { ...holding, bookId: input.bookId, amountMinor: part.amountMinor, ...input.lease },
    ];
  });
  return compactLines([suspense, ...moves, ...credits]);
}

/** P24: a debt two people agree will not be paid becomes an expense (5900) and stops being owed. */
export function writeOffLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The write-off');
  if (amount === 0)
    throw new DomainError('ledger.empty_write_off', 'Write off an amount above zero');
  const line = { bookId: input.bookId, ...input.lease, invoiceLineId: input.invoiceLineId };
  return [
    { ...line, accountCode: '5900', amountMinor: amount },
    { ...line, accountCode: '1100', amountMinor: -amount },
  ];
}

/**
 * P27: a credit note on one line. On a line already charged (accrued, a one-off, or a VAT line),
 * what it charged is reversed: the unpaid part stops being owed (1100) and the paid part returns
 * to its payments' credit (2010). On a line not yet accrued nothing was charged, so the only
 * entry moves released advance allocations to their payments' credit within prepayments.
 */
export function creditNoteLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  /**
   * The account the line was charged to: 4000, 4100, 4200 or 2210; 3900 for an opening line (P25),
   * whose credit reverses opening balances, never income; null if never charged.
   */
  readonly chargedTo: '4000' | '4100' | '4200' | '2210' | '3900' | null;
  readonly unpaidMinor: number;
  readonly released: readonly PaymentAmount[];
  /** The lease a payment's credit sits on, when it moved to a renewal (P29; review 11). */
  readonly creditLeaseOf?: (paymentId: string) => LeaseDimensions;
}): JournalLineDraft[] {
  const line = { bookId: input.bookId, ...input.lease };
  const releasedTotal = total(input.released);
  const unpaid = positive(input.unpaidMinor, 'The unpaid part');
  const toCredit = input.released.map((r) => ({
    ...line,
    ...(input.creditLeaseOf ? input.creditLeaseOf(r.paymentId) : {}),
    accountCode: '2010' as const,
    amountMinor: -r.amountMinor,
    paymentId: r.paymentId,
  }));
  if (input.chargedTo === null)
    return compactLines([
      ...input.released.map((r) => ({
        ...line,
        accountCode: '2010' as const,
        amountMinor: r.amountMinor,
        invoiceLineId: input.invoiceLineId,
        paymentId: r.paymentId,
      })),
      ...toCredit,
    ]);
  return compactLines([
    {
      ...line,
      accountCode: input.chargedTo,
      amountMinor: unpaid + releasedTotal,
      invoiceLineId: input.invoiceLineId,
    },
    { ...line, accountCode: '1100', amountMinor: -unpaid, invoiceLineId: input.invoiceLineId },
    ...toCredit,
  ]);
}

/**
 * P29: a renewal starts. The old lease's credit, payment by payment so first in, first out is
 * kept, and its deposit move to the new lease within the owner's book. Debts stay where they are.
 */
export function carryOverLines(input: {
  readonly bookId: string;
  readonly from: LeaseDimensions;
  readonly to: LeaseDimensions;
  readonly credits: readonly PaymentAmount[];
  readonly depositMinor: number;
  /**
   * The deposit by the payment that paid it, so a later reversal can take it from where it sits;
   * the parts add up to `depositMinor` (a part with no payment came from before they were kept).
   */
  readonly deposits?: readonly {
    readonly paymentId: string | null;
    readonly amountMinor: number;
  }[];
}): JournalLineDraft[] {
  const lines: JournalLineDraft[] = [];
  for (const credit of input.credits) {
    positive(credit.amountMinor, 'The credit');
    lines.push(
      {
        bookId: input.bookId,
        ...input.from,
        accountCode: '2010',
        amountMinor: credit.amountMinor,
        paymentId: credit.paymentId,
      },
      {
        bookId: input.bookId,
        ...input.to,
        accountCode: '2010',
        amountMinor: -credit.amountMinor,
        paymentId: credit.paymentId,
      },
    );
  }
  const deposit = positive(input.depositMinor, 'The deposit');
  const parts = input.deposits ?? [{ paymentId: null, amountMinor: deposit }];
  if (total(parts) !== deposit)
    throw new DomainError('ledger.deposit_parts', 'The deposit parts must add up to the deposit');
  for (const part of parts)
    if (part.amountMinor > 0)
      lines.push(
        {
          bookId: input.bookId,
          ...input.from,
          accountCode: '2100',
          amountMinor: part.amountMinor,
          paymentId: part.paymentId,
        },
        {
          bookId: input.bookId,
          ...input.to,
          accountCode: '2100',
          amountMinor: -part.amountMinor,
          paymentId: part.paymentId,
        },
      );
  return compactLines(lines);
}
