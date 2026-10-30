import type { InvoiceDetail, InvoiceLineView, InvoiceRow } from '@rent/contracts';
import { isRecurring, TAX_KINDS } from '@rent/domain/billing';

// The invoice screens (BC-01, CT-04; M4a plan 4.19). The API derives every balance and status;
// these helpers only arrange them, and offer corrections the domain rules allow, which the API
// checks again.

export interface LineGroup {
  readonly line: InvoiceLineView;
  /** VAT, NHIL and GETFund charged on the line, in that order (plan 4.5: straight after it). */
  readonly taxes: readonly InvoiceLineView[];
}

const taxRank = (line: InvoiceLineView): number => {
  const rank = (TAX_KINDS as readonly string[]).indexOf(line.kind);
  return rank < 0 ? TAX_KINDS.length : rank;
};

/**
 * An invoice's lines with each VAT and levy line under the line it is charged on. Base lines keep
 * the API's order. A tax line whose base line is not on the invoice is shown on its own.
 */
export function groupLines(lines: readonly InvoiceLineView[]): LineGroup[] {
  const ids = new Set(lines.map((line) => line.id));
  const taxesOf = new Map<string, InvoiceLineView[]>();
  for (const line of lines)
    if (line.baseLineId && ids.has(line.baseLineId))
      taxesOf.set(line.baseLineId, [...(taxesOf.get(line.baseLineId) ?? []), line]);
  return lines
    .filter((line) => !(line.baseLineId && ids.has(line.baseLineId)))
    .map((line) => ({
      line,
      taxes: [...(taxesOf.get(line.id) ?? [])].sort((a, b) => taxRank(a) - taxRank(b)),
    }));
}

export interface LineCorrections {
  /** The most a credit note can take off the line (P27); 0 when none can be asked for. */
  readonly creditableMinor: number;
  /** The most that can be written off (P24); 0 when nothing can be. */
  readonly writableOffMinor: number;
}

/**
 * What can be asked for on a line, by the domain's rules (packages/domain/billing corrections):
 * - a credit note on any line but a VAT or levy line, which follows the line it is charged on; a
 *   deposit only where it is unpaid, since money held as a deposit leaves only at move-out (M8);
 * - a write-off of what is still owed on a charged line: a started rent or service-charge period,
 *   a one-off charge, or a tax line. A deposit is never income, so it is never written off.
 */
export function lineCorrections(line: InvoiceLineView): LineCorrections {
  const creditable =
    line.baseLineId !== null
      ? 0
      : line.kind === 'deposit'
        ? line.outstandingMinor
        : line.netMinor - line.writtenOffMinor;
  const charged = line.kind !== 'deposit' && (!isRecurring(line.kind) || line.accrued);
  return {
    creditableMinor: Math.max(0, creditable),
    writableOffMinor: charged ? Math.max(0, line.outstandingMinor) : 0,
  };
}

/** The legal rules behind an invoice's amounts that nobody has verified yet (CLAUDE.md section 7). */
export function unverifiedRuleKeys(invoice: Pick<InvoiceDetail, 'lines'>): string[] {
  const keys = new Set<string>();
  for (const line of invoice.lines)
    if (line.rule && line.rule.verificationStatus !== 'verified') keys.add(line.rule.key);
  return [...keys].sort();
}

/**
 * The warning staff see wherever VAT is used (CT-04, OQ-20): the rates come from rules a tax
 * adviser has not verified. Null when every rule used is verified.
 */
export function vatWarning(
  invoice: Pick<InvoiceDetail, 'lines' | 'unverifiedRules' | 'hasVat'>,
): string | null {
  const keys = unverifiedRuleKeys(invoice);
  if (!invoice.unverifiedRules && keys.length === 0) return null;
  const which = keys.length ? ` (${keys.join(', ')})` : '';
  return invoice.hasVat
    ? `The VAT, NHIL and GETFund on this invoice use rates from rules a tax adviser has not yet verified${which}. Check them before relying on them (OQ-20).`
    : `Amounts on this invoice use rules a tax adviser has not yet verified${which}. Check them before relying on them.`;
}

/** The API's own warnings, without one that repeats the unverified-rules warning shown already. */
export function otherInvoiceWarnings(warnings: readonly string[], shown: string | null): string[] {
  return warnings.filter((warning) => !(shown && /not (yet )?verified/i.test(warning)));
}

/** `INV-000123`, and the tenant and unit, for a link or a heading. */
export function invoiceTitle(invoice: Pick<InvoiceRow, 'number' | 'unitCode'>): string {
  return `${invoice.number} · ${invoice.unitCode}`;
}
