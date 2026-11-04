import type { InvoiceDetail, InvoiceLineView, InvoiceRow } from '@rent/contracts';
import { TAX_KINDS } from '@rent/domain/billing';
import { lineKindLabel, periodLabel, rateLabel } from './billing-format';

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

/**
 * A line's name for a heading or a button: `Rent, 15 Nov 2026 to 14 Dec 2026`, and for a tax line
 * `VAT at 15% on Rent, 15 Nov 2026 to 14 Dec 2026`, so each per-line control says which line it is.
 */
export function lineName(line: InvoiceLineView, base: InvoiceLineView | null = null): string {
  if (line.baseLineId !== null) {
    const tax = `${lineKindLabel(line.kind)}${line.rateBps !== null ? ` at ${rateLabel(line.rateBps)}` : ''}`;
    return base ? `${tax} on ${lineName(base)}` : tax;
  }
  const period = periodLabel(line.periodStart, line.periodEnd);
  const label = line.label || lineKindLabel(line.kind);
  return period && !label.includes(period) ? `${label}, ${period}` : label;
}

export type CorrectionKind = 'credit_note' | 'write_off';

/**
 * The most a correction may take off a line now, as the API works it out from the domain's rules
 * (P27 credit notes, P24 write-offs): never a figure the browser computes. Zero offers nothing.
 */
export function correctionMax(
  line: Pick<InvoiceLineView, 'creditableMinor' | 'writeOffableMinor'>,
  kind: CorrectionKind,
): number {
  return kind === 'credit_note' ? line.creditableMinor : line.writeOffableMinor;
}

/** The corrections to offer on a line: those the API allows an amount for. */
export function correctionsOffered(
  line: Pick<InvoiceLineView, 'creditableMinor' | 'writeOffableMinor'>,
): CorrectionKind[] {
  return (['credit_note', 'write_off'] as const).filter((kind) => correctionMax(line, kind) > 0);
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
