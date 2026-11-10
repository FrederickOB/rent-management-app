import { DomainError } from '../errors';
import { money, multiplyBps } from '../money/money';

/**
 * Withholding tax by a corporate tenant (TX-04; P19 and P20; M5 plan 5.2). The tenant pays net
 * and withholds tax on particular lines. Withholding is pinned to those lines and skips the
 * oldest-first order; the tax on them becomes the amount withheld, settled when the certificate
 * is confirmed.
 */
export interface WithheldLine {
  readonly lineId: string;
  /** The line's amount after credit notes. */
  readonly netMinor: number;
  /** Still owed on it before this withholding. */
  readonly outstandingMinor: number;
  /**
   * Payments' cash on the line, which the withholding may move back to their credit when the
   * tenant paid before the withholding was recorded (M5 review 2). Zero when not given.
   */
  readonly releasableMinor?: number;
  readonly withheldMinor: number;
}

export interface WithholdingCheck {
  readonly totalMinor: number;
  /** Lines where the amount differs from the rate on the line: shown to staff, not refused. */
  readonly differsFromRate: readonly {
    readonly lineId: string;
    readonly expectedMinor: number;
    readonly withheldMinor: number;
  }[];
}

/**
 * Checks recorded withholding: positive, never more than a line still owes plus the payments'
 * cash on it (which moves back to their credit, M5 review 2). The rate
 * (`withholding_tax.rate.*`, unverified) only produces a warning, because the tenant decides
 * what it withholds and the certificate is the evidence.
 */
export function checkWithholding(
  lines: readonly WithheldLine[],
  rateBps: number,
): WithholdingCheck {
  if (lines.length === 0)
    throw new DomainError('withholding.no_lines', 'Say which lines the tax was withheld on');
  const differsFromRate: WithholdingCheck['differsFromRate'][number][] = [];
  let totalMinor = 0;
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.lineId))
      throw new DomainError('withholding.repeated_line', 'Each line is listed once');
    seen.add(line.lineId);
    if (!Number.isSafeInteger(line.withheldMinor) || line.withheldMinor <= 0)
      throw new DomainError('withholding.bad_amount', 'Withholding is an amount above zero');
    if (line.withheldMinor > line.outstandingMinor + Math.max(0, line.releasableMinor ?? 0))
      throw new DomainError(
        'withholding.too_large',
        'Withholding cannot exceed what is still owed on the line, plus the cash paid on it',
      );
    const expectedMinor = multiplyBps(money(line.netMinor), rateBps).amountMinor;
    if (expectedMinor !== line.withheldMinor)
      differsFromRate.push({
        lineId: line.lineId,
        expectedMinor,
        withheldMinor: line.withheldMinor,
      });
    totalMinor += line.withheldMinor;
  }
  return { totalMinor, differsFromRate };
}

/** P20's debit (decision 2): the withholding settles the owner's rent tax, or is a tax credit. */
export const certificateDebitAccount = (owner: {
  readonly lettingBusiness: boolean;
}): '2200' | '1160' => (owner.lettingBusiness ? '1160' : '2200');

/**
 * How the rent tax treated a withholding when it was recorded (M5 review 1), kept with it:
 * `accrued` (P17 accrued the amount withheld to 2200), `letting_business` (the owner is taxed on
 * income, decision 2) or `not_assessed` (a rules row was missing or not one this build applies).
 */
export const WITHHOLDING_TAX_TREATMENTS = ['accrued', 'letting_business', 'not_assessed'] as const;
export type WithholdingTaxTreatment = (typeof WITHHOLDING_TAX_TREATMENTS)[number];

/**
 * P20's debit from what the withholding's rent tax was, never from the owner's flag today (M5
 * review 1): 2200 only when P17 accrued the amount withheld to 2200, so the certificate settles
 * exactly that; otherwise nothing in 2200 is owed for it and it is a tax credit (1160).
 */
export const certificateDebitFor = (record: {
  /** A P17 item of kind `withholding` exists for it. */
  readonly accruedToRentTax: boolean;
}): '2200' | '1160' => (record.accruedToRentTax ? '2200' : '1160');

/**
 * P20's debit for withholding brought in at the cut-over (P25; M11 founder decision 4, OQ-64): no
 * P17 item exists for it on the platform. For an owner in the letting business it is a tax credit
 * (1160); for any other owner it settled rent tax owed before the platform, so it closes against
 * opening balances (3900). Pass the owner's flag as recorded with the opening item at commit.
 */
export const openingCertificateDebit = (owner: {
  readonly lettingBusiness: boolean;
}): '1160' | '3900' => (owner.lettingBusiness ? '1160' : '3900');

/** A certificate is confirmed by a user for that owner, or an agency admin; never its uploader. */
export function checkCertificateConfirmer(input: {
  readonly uploadedBy: string;
  readonly confirmer: string;
}): void {
  if (input.uploadedBy === input.confirmer)
    throw new DomainError(
      'withholding.confirmer_is_uploader',
      'The person who uploaded a certificate cannot confirm it',
    );
}
