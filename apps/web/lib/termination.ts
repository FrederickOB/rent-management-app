import type { ApiClient } from '@rent/contracts/client';
import { refundDue } from '@rent/domain/billing';
import { DomainError } from '@rent/domain/errors';
import { periodLabel, type ReceivingAccount } from './billing-format';
import { formatBusinessDate } from './business-dates';
import { amountMinorOf, pastDateProblem, type Parsed } from './payment-form';
import { TAX_LIMITS } from './tax-limits';
import { formatMinor } from './tenancy-format';

// Early termination (AR-04, P13; M5 plan 5.4 and decision 6). After a move-out ends a lease early,
// the API works out, in order: agreed termination charges (P01); the unused days of the last
// month, credited only where the break clause allows (P27; otherwise the month is not prorated,
// prd-issues 36); the prepayment applied to open lines, oldest first; deductions agreed with the
// tenant; and the refund, which a second person approves. The refund is paid outside the platform
// (D1) and recorded with a reference and proof. These helpers show each step and check the forms.

/** An agreed charge or deduction, as the request carries it. */
export interface AmountLine {
  readonly description: string;
  readonly amountMinor: number;
}

/** The settlement's figures, as the API works them out from the ledger (never in the browser). */
export interface TerminationFigures {
  /** The tenancy's last day, and the end date the lease had. */
  readonly lastDay: string;
  readonly endDate: string;
  /** Whether the break clause credits unused days (`creditUnusedDays` in the lease terms). */
  readonly breakClauseCreditsUnusedDays: boolean;
  /** What the tenant had paid ahead before the settlement. */
  readonly creditBeforeMinor: number;
  readonly chargesMinor: number;
  readonly unusedDays: readonly {
    readonly lineId: string;
    readonly periodStart: string | null;
    readonly periodEnd: string | null;
    readonly unusedDays: number;
    readonly periodDays: number;
    readonly creditMinor: number;
  }[];
  readonly unusedDaysCreditMinor: number;
  /** The prepayment applied to open lines, oldest first (P13 apply). */
  readonly appliedMinor: number;
  /** The prepayment left once open lines are paid: the most deductions and the refund can take. */
  readonly creditLeftMinor: number;
  readonly deductionsMinor: number;
  readonly refundMinor: number;
  /** Still owed after that: arrears that stay on the lease. */
  readonly arrearsMinor: number;
}

export interface TerminationStep {
  readonly key: 'charges' | 'unused_days' | 'applied' | 'deductions' | 'refund' | 'owed';
  readonly title: string;
  readonly lines: readonly { readonly label: string; readonly amount: string }[];
  readonly total: string | null;
  readonly note: string | null;
}

const amountLines = (items: readonly AmountLine[]) =>
  items.map((item) => ({ label: item.description, amount: formatMinor(item.amountMinor) }));

/**
 * The settlement step by step, in the order the API works it out (plan 5.4), with the charges and
 * deductions as asked. Every total is the API's.
 */
export function terminationSteps(
  figures: TerminationFigures,
  asked: { readonly charges: readonly AmountLine[]; readonly deductions: readonly AmountLine[] },
): TerminationStep[] {
  return [
    {
      key: 'charges',
      title: '1. Agreed termination charges',
      lines: amountLines(asked.charges),
      total: asked.charges.length ? formatMinor(figures.chargesMinor) : null,
      note: asked.charges.length ? 'Raised as charges on the lease first.' : 'None agreed.',
    },
    {
      key: 'unused_days',
      title: '2. Unused days of the last month',
      lines: figures.unusedDays.map((line) => ({
        label: `${periodLabel(line.periodStart, line.periodEnd) ?? 'The last month'}: ${line.unusedDays} of ${line.periodDays} days unused`,
        amount: formatMinor(line.creditMinor),
      })),
      total: figures.unusedDays.length ? formatMinor(figures.unusedDaysCreditMinor) : null,
      note: !figures.breakClauseCreditsUnusedDays
        ? 'The lease’s break clause does not credit unused days, so the last month is not prorated.'
        : figures.unusedDays.length
          ? `Credited because the break clause allows it. The tenancy ended on ${formatBusinessDate(figures.lastDay)}.`
          : `No days of the last month are unused: the tenancy ended on ${formatBusinessDate(figures.lastDay)}.`,
    },
    {
      key: 'applied',
      title: '3. Prepayment applied to open charges, oldest first',
      lines: [],
      total: formatMinor(figures.appliedMinor),
      note: `${formatMinor(figures.creditBeforeMinor)} was paid ahead. ${formatMinor(figures.creditLeftMinor)} is left once the open charges are paid.`,
    },
    {
      key: 'deductions',
      title: '4. Deductions agreed with the tenant',
      lines: amountLines(asked.deductions),
      total: asked.deductions.length ? formatMinor(figures.deductionsMinor) : null,
      note: asked.deductions.length ? 'Taken off what is left.' : 'None agreed.',
    },
    {
      key: 'refund',
      title: '5. Refund to the tenant',
      lines: [],
      total: formatMinor(figures.refundMinor),
      note:
        figures.refundMinor > 0
          ? 'A second person approves it, and it is paid outside the platform.'
          : 'Nothing is left to refund.',
    },
    {
      key: 'owed',
      title: '6. Still owed',
      lines: [],
      total: formatMinor(figures.arrearsMinor),
      note:
        figures.arrearsMinor > 0
          ? 'These charges stay as arrears: settle them from the deposit, collect them, or ask to write them off.'
          : 'Nothing is owed.',
    },
  ];
}

/** Rent tax already accrued on the refunded advance stays (OQ-19, decision 6); staff are told. */
export const TERMINATION_TAX_NOTE =
  'Rent tax already worked out on the advance is not reversed by the refund. A tax adviser is to confirm this (OQ-19).';

// The request (P13; decision 6) ------------------------------------------------------------------

/**
 * One agreed charge or deduction as typed: what it is for, and how much. A row left wholly blank
 * is ignored, so the form can always offer an empty row to fill in.
 */
export interface AmountRow {
  readonly description: string;
  readonly amount: string;
}

export const emptyRow: AmountRow = { description: '', amount: '' };

export interface TerminationDraft {
  /** Agreed termination charges (P01), raised before the prepayment is applied. */
  readonly charges: readonly AmountRow[];
  /** Deductions agreed with the tenant, taken off the refund. */
  readonly deductions: readonly AmountRow[];
  readonly note: string;
}

export const emptyTermination: TerminationDraft = {
  charges: [emptyRow],
  deductions: [emptyRow],
  note: '',
};

/** The request as `POST /leases/{leaseId}/early-termination` takes it, without the lease. */
export type TerminationInput = Omit<
  Parameters<ApiClient['earlyTermination']['request']>[0],
  'leaseId'
>;

/** Problems by row: `charges.0.amount`, `deductions.1.description`, or the whole form's. */
export type TerminationField =
  `${'charges' | 'deductions'}.${number}.${keyof AmountRow}` | 'deductions' | 'note';

/** The contract's limits on what a charge or deduction is for. */
const LABEL_MIN = TAX_LIMITS.descriptionMin;
const LABEL_MAX = TAX_LIMITS.descriptionMax;

function rows(
  kind: 'charges' | 'deductions',
  typed: readonly AmountRow[],
  errors: Partial<Record<TerminationField, string>>,
): AmountLine[] {
  const lines: AmountLine[] = [];
  typed.forEach((row, index) => {
    if (!row.description.trim() && !row.amount.trim()) return;
    const description = row.description.trim();
    const what = kind === 'charges' ? 'the charge' : 'the deduction';
    if (description.length < LABEL_MIN)
      errors[`${kind}.${index}.description`] = `Say what ${what} is for`;
    else if (description.length > LABEL_MAX)
      errors[`${kind}.${index}.description`] = `Use at most ${LABEL_MAX} characters`;
    const amount = amountMinorOf(row.amount);
    if (amount.problem || amount.value === null)
      errors[`${kind}.${index}.amount`] = amount.problem ?? '';
    else if (description.length >= LABEL_MIN && description.length <= LABEL_MAX)
      lines.push({ description, amountMinor: amount.value });
  });
  return lines;
}

/** The total of amount lines already checked, for the preview; the API's figures are shown after. */
const total = (lines: readonly AmountLine[]): number =>
  lines.reduce((sum, line) => sum + line.amountMinor, 0);

/**
 * The early termination request (AR-04, P13): agreed charges, deductions and a note. The API's
 * preview gives `creditLeftMinor`, what is left once open lines are paid; deductions never take
 * more than that (the domain's rule), so the refund is nothing or more. Every figure is worked out
 * again by the API, and a second person approves it.
 */
export function terminationForm(
  draft: TerminationDraft,
  creditLeftMinor: number | null,
): Parsed<TerminationInput, TerminationField> & {
  readonly deductionsMinor: number;
  readonly refundMinor: number | null;
} {
  const errors: Partial<Record<TerminationField, string>> = {};
  const charges = rows('charges', draft.charges, errors);
  const deductions = rows('deductions', draft.deductions, errors);
  const deductionsMinor = total(deductions);
  let refundMinor: number | null = null;
  if (creditLeftMinor !== null)
    try {
      refundMinor = refundDue(creditLeftMinor, deductionsMinor);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      errors.deductions = `Deductions cannot be more than is left to refund: ${formatMinor(creditLeftMinor)}`;
    }
  if (draft.note.trim().length > 500) errors.note = 'Use at most 500 characters';
  if (Object.keys(errors).length) return { input: null, errors, deductionsMinor, refundMinor };
  return {
    input: { charges, deductions, note: draft.note.trim() || null },
    errors: {},
    deductionsMinor,
    refundMinor,
  };
}

/**
 * The charges and deductions as the API's preview takes them, ignoring rows still being typed, so
 * the figures shown can be checked against what the form now asks for.
 */
export function previewInput(draft: Pick<TerminationDraft, 'charges' | 'deductions'>): {
  readonly charges: AmountLine[];
  readonly deductions: AmountLine[];
} {
  const ignored: Partial<Record<TerminationField, string>> = {};
  return {
    charges: rows('charges', draft.charges, ignored),
    deductions: rows('deductions', draft.deductions, ignored),
  };
}

// The request's life -----------------------------------------------------------------------------

/** An early termination's status (the API's): approved means settled, the refund still to pay. */
export const TERMINATION_STATUSES = [
  'awaiting_approval',
  'settled',
  'refund_paid',
  'rejected',
] as const;
export type TerminationStatus = (typeof TERMINATION_STATUSES)[number];

export const TERMINATION_STATUS_LABELS: Record<TerminationStatus, string> = {
  awaiting_approval: 'Waiting for a second person to approve it',
  settled: 'Approved: charges raised and the prepayment applied',
  refund_paid: 'Refund paid to the tenant',
  rejected: 'Rejected: nothing changed',
};

/** What is left to do once a request is approved: pay the refund, if there is one. */
export function terminationNext(status: TerminationStatus, refundMinor: number): string | null {
  if (status === 'settled')
    return refundMinor > 0
      ? `Pay the tenant ${formatMinor(refundMinor)} outside the platform, then record it here with the reference and proof.`
      : 'Nothing is left to refund.';
  if (status === 'rejected') return 'You can ask again with corrected charges or deductions.';
  return null;
}

/** A rejected request can be asked again; one waiting, approved or paid cannot. */
export const mayRequestAgain = (status: TerminationStatus | null): boolean =>
  status === null || status === 'rejected';

// Recording the refund as paid (P13 pay) ------------------------------------------------------

export interface RefundPaidDraft {
  readonly paidOn: string;
  readonly reference: string;
  readonly paidFrom: ReceivingAccount | '';
}

export type RefundPaidField = keyof RefundPaidDraft;

export const emptyRefundPaid = (today: string, agency: boolean): RefundPaidDraft => ({
  paidOn: today,
  reference: '',
  paidFrom: agency ? '' : 'owner_account',
});

/** The refund recorded as paid, without the termination and the proof the page adds. */
export type RefundPaidInput = Omit<
  Parameters<ApiClient['earlyTermination']['recordRefundPaid']>[0],
  'terminationId' | 'proofUploadId'
>;

/** The refund recorded as paid: when, the bank or MoMo reference, and the account it left. */
export function refundPaidForm(
  draft: RefundPaidDraft,
  approvedOn: string | null,
  today: string,
): Parsed<RefundPaidInput, RefundPaidField> {
  const errors: Partial<Record<RefundPaidField, string>> = {};
  const date = pastDateProblem(draft.paidOn, today, 'the refund was paid');
  if (date) errors.paidOn = date;
  else if (approvedOn && draft.paidOn < approvedOn)
    errors.paidOn = `It cannot be paid before it was approved, on ${formatBusinessDate(approvedOn)}`;
  const reference = draft.reference.trim();
  if (reference.length < TAX_LIMITS.refundReferenceMin)
    errors.reference = 'Enter the transfer or MoMo reference';
  else if (reference.length > TAX_LIMITS.refundReferenceMax)
    errors.reference = `Use at most ${TAX_LIMITS.refundReferenceMax} characters`;
  if (!draft.paidFrom) errors.paidFrom = 'Choose the account it was paid from';
  if (Object.keys(errors).length || !draft.paidFrom) return { input: null, errors };
  return { input: { paidOn: draft.paidOn, reference, paidFrom: draft.paidFrom }, errors: {} };
}

/**
 * Whether a move-out ended the lease before its end date (plan 5.4), so the early-termination
 * card is offered: the tenancy's last day is the move-out, and it falls before the term's end.
 */
export function endedEarly(lease: {
  readonly terms: { readonly endDate: string };
  readonly lifecycle: { readonly moveOutDate: string | null };
}): boolean {
  const last = lease.lifecycle.moveOutDate;
  return last !== null && last < lease.terms.endDate;
}

/** An early termination asked for, as the API returns it: its figures as asked. */
export interface AskedTermination {
  readonly lastDay: string;
  readonly charges: readonly AmountLine[];
  readonly deductions: readonly AmountLine[];
  readonly chargesMinor: number;
  readonly unusedDaysCreditMinor: number;
  readonly appliedMinor: number;
  readonly deductionsMinor: number;
  readonly refundMinor: number;
}

/** A request's figures in the order they were worked out, for the lease page (plan 5.4). */
export function requestSummary(
  asked: AskedTermination,
): { readonly label: string; readonly value: string }[] {
  return [
    { label: 'Last day of the tenancy', value: formatBusinessDate(asked.lastDay) },
    ...asked.charges.map((c) => ({
      label: `Charge: ${c.description}`,
      value: formatMinor(c.amountMinor),
    })),
    { label: 'Unused days credited', value: formatMinor(asked.unusedDaysCreditMinor) },
    { label: 'Prepayment applied to open charges', value: formatMinor(asked.appliedMinor) },
    ...asked.deductions.map((d) => ({
      label: `Deduction: ${d.description}`,
      value: formatMinor(d.amountMinor),
    })),
    { label: 'Refund to the tenant', value: formatMinor(asked.refundMinor) },
  ];
}
