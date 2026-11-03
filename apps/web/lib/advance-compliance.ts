import { formatBusinessDate } from './business-dates';
import { verificationLabel, warns, type RuleUsed } from './tax-rules';

// The advance rent report (AR-05; M5 plan 5.5, decision 4 and D6). Every payment records how many
// months ahead it pays. Under `advance_rent_policy` `warn` or `block`, a payment beyond the limit
// for the lease's term flags the lease and lists it here, with the rule version it was judged
// by. The product never calls an advance compliant: it says only whether a limit is exceeded,
// and the limit is unverified until counsel confirms it (CLAUDE.md section 7).

export type AdvancePolicy = 'off' | 'warn' | 'block';

export const ADVANCE_POLICY_LABELS: Record<AdvancePolicy, string> = {
  off: 'Off: advances are recorded, and nothing is flagged',
  warn: 'Warn: advances over the limit are flagged on the lease and listed here',
  block: 'Block: forms and the pay page refuse an advance over the limit',
};

/** What the report says before its rows, by the company's policy (OQ-28). */
export function policyNote(policy: AdvancePolicy): string {
  switch (policy) {
    case 'off':
      return 'Your company’s advance rent check is off, so nothing is flagged. Months paid ahead are still recorded on every payment, so turning the check on needs no change to past records.';
    case 'warn':
      return 'Payments that pay further ahead than the limit for the lease’s term are recorded and flagged. Nothing is refused.';
    case 'block':
      return 'Forms and the pay page refuse an amount that would pay further ahead than the limit. Money that arrives anyway, from a payment provider, is recorded and listed here for a person to look at.';
  }
}

/** A flagged payment, as the report needs it. */
export interface AdvanceRow {
  readonly monthsAhead: number;
  readonly limitMonths: number;
  readonly receivedOn: string;
  readonly rule: (RuleUsed & { readonly effectiveFrom?: string }) | null;
}

/** A row of the report as the screen shows it: the lease, and the payment that went past the limit. */
export interface AdvanceReportRow extends AdvanceRow {
  readonly leaseId: string;
  readonly unitCode: string;
  readonly propertyName: string;
  readonly tenantName: string;
  readonly paymentId: string;
  /** The policy the payment was judged under: `warn` flags it, `block` means it came anyway. */
  readonly policy: 'warn' | 'block';
}

const months = (n: number): string => `${n} month${n === 1 ? '' : 's'}`;

/** `12 months paid ahead; the limit for this term is 6 months`. Never "compliant". */
export function aheadLabel(row: Pick<AdvanceRow, 'monthsAhead' | 'limitMonths'>): string {
  return `${months(row.monthsAhead)} paid ahead; the limit for this lease’s term is ${months(row.limitMonths)}`;
}

/** How far over the limit, or null when it is not (a row the API sends for another reason). */
export function overBy(row: Pick<AdvanceRow, 'monthsAhead' | 'limitMonths'>): string | null {
  const over = row.monthsAhead - row.limitMonths;
  return over > 0 ? `${months(over)} over the limit` : null;
}

/**
 * The rule a row was judged by: its key, the day the version took effect, and its status in
 * words (`Unverified: counsel to confirm`). Never "compliant" or "approved".
 */
export function ruleLabel(rule: AdvanceRow['rule']): string {
  if (!rule) return 'No rule recorded';
  const from = rule.effectiveFrom
    ? `, in force from ${formatBusinessDate(rule.effectiveFrom)}`
    : '';
  return `${rule.key}${from}. ${verificationLabel(rule)}`;
}

/** The words a person may read on this report, for the test that none calls an advance compliant. */
export function reportWords(policy: AdvancePolicy, rows: readonly AdvanceRow[]): string[] {
  return [
    ADVANCE_POLICY_LABELS[policy],
    policyNote(policy),
    ...rows.flatMap((row) => [aheadLabel(row), overBy(row) ?? '', ruleLabel(row.rule)]),
  ];
}

/** What a payment recorded about months paid ahead (AR-05), as the API sends it. */
export interface PaymentAdvance {
  readonly monthsAhead: number;
  readonly policy: AdvancePolicy;
  readonly limitMonths: number | null;
  readonly overLimit: boolean;
  /** Over the limit under `warn` or `block`: shown to staff. Never set under `off` (D6). */
  readonly flagged: boolean;
}

/**
 * A payment's months paid ahead in words, on the payment and the lease (AR-05). Recorded on every
 * payment; only a flagged one says it went past the limit, since under `off` nothing warns (D6).
 */
/** The sentence a flag ends with while the limit's rule is not verified (CLAUDE.md section 7). */
const unverifiedLimit = (rule: RuleUsed | null | undefined): string =>
  rule && warns(rule) ? ' The limit is not yet verified by counsel.' : '';

export function paymentAdvanceLabel(
  advance: PaymentAdvance,
  rule: RuleUsed | null = null,
): {
  readonly text: string;
  readonly flag: string | null;
} {
  const text =
    advance.monthsAhead === 0
      ? 'After this payment the lease is not paid for any month ahead.'
      : `After this payment the lease is paid ${months(advance.monthsAhead)} ahead.`;
  if (!advance.flagged || advance.limitMonths === null) return { text, flag: null };
  return {
    text,
    flag: `Over the advance rent limit: ${aheadLabel({ monthsAhead: advance.monthsAhead, limitMonths: advance.limitMonths })}. Your company flags it${advance.policy === 'block' ? ' (it arrived from a payment provider, so it was recorded)' : ''}; a person should look at it.${unverifiedLimit(rule)}`,
  };
}

/** AR-05 on the lease page, as the API works it out from the forward walk. */
export interface LeaseAdvance {
  readonly policy: AdvancePolicy;
  readonly monthsAheadNow: number;
  readonly limitMonths: number | null;
  readonly rule: RuleUsed | null;
  readonly overLimitNow: boolean;
  readonly flaggedPayments: readonly {
    readonly paymentId: string;
    readonly valueDate: string;
    readonly monthsAhead: number;
    readonly limitMonths: number | null;
    readonly policy: AdvancePolicy;
  }[];
}

/**
 * The lease's months paid ahead now (recorded on every lease, AR-05), and the flag when the
 * company checks advances and a payment went past the limit. Under `off` nothing is flagged (D6).
 */
export function leaseAdvanceLabel(advance: LeaseAdvance): {
  readonly text: string;
  readonly flag: string | null;
} {
  const text =
    advance.monthsAheadNow === 0
      ? 'The lease is not paid for any month ahead.'
      : `The lease is paid ${months(advance.monthsAheadNow)} ahead.`;
  const latest = advance.flaggedPayments.at(-1);
  if (advance.policy === 'off' || !latest || latest.limitMonths === null)
    return { text, flag: null };
  return {
    text,
    flag: `A payment on ${formatBusinessDate(latest.valueDate)} paid ${months(latest.monthsAhead)} ahead; the limit for this lease’s term is ${months(latest.limitMonths)}. Your company flags it; a person should look at it.${unverifiedLimit(advance.rule)}`,
  };
}
