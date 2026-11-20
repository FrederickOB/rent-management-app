import { DomainError } from '../errors';
import type { CashAccount } from './accounts';
import { compactLines, type JournalLineDraft } from './journal';
import type { LeaseDimensions, PaymentAmount } from './posting';

/**
 * Rent tax, withholding, VAT payments and early termination (architecture section 5; M5 plan
 * section 5). One posting function per rule: event in, lines out.
 */
const positive = (amount: number, what: string): number => {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new DomainError('ledger.bad_amount', `${what} must be above zero`);
  return amount;
};

type OwnAccount = Extract<CashAccount, '1010' | '1070'>;

/**
 * P17: rent tax accrued on a receipt, one pair of lines per period it is pinned to, each on the
 * receipt's payment and, once invoiced, the line: Dr 5300 (rent tax), Cr 2200 (rent tax payable).
 */
export function rentTaxLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  /** The receipt's payment; null for credit carried to a renewal from several payments (P29). */
  readonly paymentId: string | null;
  readonly lines: readonly { readonly invoiceLineId: string | null; readonly taxMinor: number }[];
}): JournalLineDraft[] {
  return compactLines(
    input.lines.flatMap((l) => {
      const dims = {
        bookId: input.bookId,
        ...input.lease,
        paymentId: input.paymentId,
        invoiceLineId: l.invoiceLineId,
      };
      if (!Number.isSafeInteger(l.taxMinor) || l.taxMinor < 0)
        throw new DomainError('ledger.bad_amount', 'Tax is zero or more pesewas');
      return [
        { ...dims, accountCode: '5300' as const, amountMinor: l.taxMinor },
        { ...dims, accountCode: '2200' as const, amountMinor: -l.taxMinor },
      ];
    }),
  );
}

/**
 * P21 for rent tax (M5 plan 5.1, 5.2): tax accrued earlier taken back, per period: a payment
 * reversed mirrors its receipt's tax, and withholding replaces the tax accrued on the cash of the
 * lines it was withheld on. Dr 2200, Cr 5300.
 */
export function rentTaxReversalLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly paymentId: string | null;
  readonly lines: readonly { readonly invoiceLineId: string | null; readonly taxMinor: number }[];
}): JournalLineDraft[] {
  return compactLines(
    input.lines.flatMap((l) => {
      const dims = {
        bookId: input.bookId,
        ...input.lease,
        paymentId: input.paymentId,
        invoiceLineId: l.invoiceLineId,
      };
      if (!Number.isSafeInteger(l.taxMinor) || l.taxMinor < 0)
        throw new DomainError('ledger.bad_amount', 'Tax taken back is zero or more pesewas');
      return [
        { ...dims, accountCode: '2200' as const, amountMinor: l.taxMinor },
        { ...dims, accountCode: '5300' as const, amountMinor: -l.taxMinor },
      ];
    }),
  );
}

/** P18: rent tax paid to GRA from the owner's account (1010) or by the agent (1070), per item. */
export function graPaymentLines(input: {
  readonly bookId: string;
  readonly from: OwnAccount;
  readonly items: readonly (Omit<PaymentAmount, 'paymentId'> & {
    readonly paymentId: string | null;
    /** The item's lease, so the payable clears where it was accrued (M5). */
    readonly lease?: LeaseDimensions;
  })[];
  readonly propertyId?: string | null;
}): JournalLineDraft[] {
  const total = input.items.reduce((sum, i) => sum + positive(i.amountMinor, 'A settled item'), 0);
  return compactLines([
    ...input.items.map((i) => ({
      bookId: input.bookId,
      ...(i.lease ?? {}),
      accountCode: '2200' as const,
      amountMinor: i.amountMinor,
      paymentId: i.paymentId,
      propertyId: i.lease?.propertyId ?? input.propertyId ?? null,
    })),
    {
      bookId: input.bookId,
      accountCode: input.from,
      amountMinor: -total,
      propertyId: input.propertyId ?? null,
    },
  ]);
}

/**
 * P19: tax withheld by a corporate tenant, on the lines it was withheld on: the tenant no longer
 * owes it (Cr 1100) and the owner is owed it by GRA until the certificate arrives (Dr 1150).
 */
export function withholdingLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  /** The payment the tenant paid net with; null when the tenant advised it on its own. */
  readonly paymentId: string | null;
  readonly lines: readonly {
    readonly invoiceLineId: string;
    readonly amountMinor: number;
    /**
     * M5 decision 8: a month not yet started holds the withholding as its advance (Cr 2010 on the
     * line, as P03 holds a prepayment), drawn when the month starts (`withholdingDrawLines`).
     */
    readonly prepaid?: boolean;
    /**
     * M5 review 2: payments' cash the line already held, returned to their credit so the
     * withholding fits (Dr 1100 on a started line, or Dr 2010 on the line for one not started;
     * Cr 2010 on the payment), as a credit note releases money.
     */
    readonly released?: readonly PaymentAmount[];
  }[];
  /** The lease a payment's credit sits on, when it moved to a renewal (P29; as P27). */
  readonly creditLeaseOf?: (paymentId: string) => LeaseDimensions;
}): JournalLineDraft[] {
  return compactLines(
    input.lines.flatMap((l) => {
      const dims = {
        bookId: input.bookId,
        ...input.lease,
        paymentId: input.paymentId,
        invoiceLineId: l.invoiceLineId,
      };
      positive(l.amountMinor, 'Withholding');
      const releases = (l.released ?? []).flatMap((r) => {
        positive(r.amountMinor, 'Released cash');
        return [
          {
            ...dims,
            paymentId: r.paymentId,
            accountCode: l.prepaid ? ('2010' as const) : ('1100' as const),
            amountMinor: r.amountMinor,
          },
          {
            bookId: input.bookId,
            ...input.lease,
            ...(input.creditLeaseOf ? input.creditLeaseOf(r.paymentId) : {}),
            paymentId: r.paymentId,
            accountCode: '2010' as const,
            amountMinor: -r.amountMinor,
          },
        ];
      });
      return [
        ...releases,
        { ...dims, accountCode: '1150' as const, amountMinor: l.amountMinor },
        l.prepaid
          ? { ...dims, paymentId: null, accountCode: '2010' as const, amountMinor: -l.amountMinor }
          : { ...dims, accountCode: '1100' as const, amountMinor: -l.amountMinor },
      ];
    }),
  );
}

/**
 * P02's draw of withholding held as a month's advance (M5 decision 8): when the month starts it
 * is charged in full (P02), and the tax withheld on it moves from prepayments to pay it: Dr 2010,
 * Cr 1100 on the line. Its own key per withholding, beside the line's P02.
 */
export function withholdingDrawLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly invoiceLineId: string;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'A withholding draw');
  const dims = { bookId: input.bookId, ...input.lease, invoiceLineId: input.invoiceLineId };
  return [
    { ...dims, accountCode: '2010', amountMinor: amount },
    { ...dims, accountCode: '1100', amountMinor: -amount },
  ];
}

/**
 * P20: a withholding certificate confirmed. The withholding settles the rent tax (Dr 2200), or
 * for an owner in the letting business it is a tax credit (Dr 1160); it leaves 1150.
 */
export function certificateLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly paymentId: string | null;
  /** 3900 for withholding brought in at the cut-over, for an owner outside the letting business. */
  readonly debit: '2200' | '1160' | '3900';
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The certificate');
  const dims = { bookId: input.bookId, ...input.lease, paymentId: input.paymentId };
  return [
    { ...dims, accountCode: input.debit, amountMinor: amount },
    { ...dims, accountCode: '1150', amountMinor: -amount },
  ];
}

/** P24 for withholding whose certificate never comes: Dr 5900, Cr 1150 (two-person approval). */
export function withholdingWriteOffLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly paymentId: string | null;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The write-off');
  const dims = { bookId: input.bookId, ...input.lease, paymentId: input.paymentId };
  return [
    { ...dims, accountCode: '5900', amountMinor: amount },
    { ...dims, accountCode: '1150', amountMinor: -amount },
  ];
}

/** P13 apply: the lease's credit pays open charged lines (Dr 2010 on the payment, Cr 1100 on the line). */
export function creditApplicationLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly applications: readonly {
    readonly invoiceLineId: string;
    readonly draws: readonly PaymentAmount[];
  }[];
}): JournalLineDraft[] {
  return compactLines(
    input.applications.flatMap((a) =>
      a.draws.flatMap((d) => {
        positive(d.amountMinor, 'A draw');
        return [
          {
            bookId: input.bookId,
            ...input.lease,
            accountCode: '2010' as const,
            amountMinor: d.amountMinor,
            paymentId: d.paymentId,
          },
          {
            bookId: input.bookId,
            ...input.lease,
            accountCode: '1100' as const,
            amountMinor: -d.amountMinor,
            invoiceLineId: a.invoiceLineId,
            paymentId: d.paymentId,
          },
        ];
      }),
    ),
  );
}

/** P13 refund approved: the credit becomes a refund payable (Dr 2010 per payment, Cr 2400). */
export function refundApprovedLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly credits: readonly PaymentAmount[];
}): JournalLineDraft[] {
  const total = input.credits.reduce((sum, c) => sum + positive(c.amountMinor, 'A credit'), 0);
  return compactLines([
    ...input.credits.map((c) => ({
      bookId: input.bookId,
      ...input.lease,
      accountCode: '2010' as const,
      amountMinor: c.amountMinor,
      paymentId: c.paymentId,
    })),
    { bookId: input.bookId, ...input.lease, accountCode: '2400', amountMinor: -total },
  ]);
}

/** P13 refund paid outside the platform (D1), with a reference and proof: Dr 2400, Cr 1010 or 1070. */
export function refundPaidLines(input: {
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  readonly from: OwnAccount;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The refund');
  const dims = { bookId: input.bookId, ...input.lease };
  return [
    { ...dims, accountCode: '2400', amountMinor: amount },
    { ...dims, accountCode: input.from, amountMinor: -amount },
  ];
}

/** P33: VAT and levies paid to GRA with the return: Dr 2210, Cr 1010 or 1070. */
export function vatPaymentLines(input: {
  readonly bookId: string;
  readonly from: OwnAccount;
  readonly amountMinor: number;
}): JournalLineDraft[] {
  const amount = positive(input.amountMinor, 'The VAT payment');
  return [
    { bookId: input.bookId, accountCode: '2210', amountMinor: amount },
    { bookId: input.bookId, accountCode: input.from, amountMinor: -amount },
  ];
}
