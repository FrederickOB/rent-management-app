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
 * Checks recorded withholding: positive, never more than a line still owes. The rate
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
    if (line.withheldMinor > line.outstandingMinor)
      throw new DomainError(
        'withholding.too_large',
        'Withholding cannot exceed what is still owed on the line',
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
