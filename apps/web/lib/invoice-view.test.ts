import type { InvoiceLineView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  correctionMax,
  correctionsOffered,
  groupLines,
  lineName,
  otherInvoiceWarnings,
  unverifiedRuleKeys,
  vatWarning,
} from './invoice-view';

let n = 0;
const id = () => {
  n += 1;
  return `019a3000-0000-7000-8000-${String(n).padStart(12, '0')}`;
};

const RULE = {
  ruleId: '019a3000-0000-7000-8000-0000000000f9',
  key: 'vat.commercial_rent',
  verificationStatus: 'unverified' as const,
};

function line(overrides: Partial<InvoiceLineView> = {}): InvoiceLineView {
  return {
    id: id(),
    kind: 'rent',
    label: 'Rent',
    baseLineId: null,
    rateBps: null,
    periodStart: '2026-11-15',
    periodEnd: '2026-12-14',
    dueDate: '2026-11-15',
    amountMinor: 300_000,
    netMinor: 300_000,
    settledMinor: 0,
    creditedMinor: 0,
    writtenOffMinor: 0,
    outstandingMinor: 300_000,
    creditableMinor: 300_000,
    writeOffableMinor: 300_000,
    accrued: true,
    rule: null,
    ...overrides,
  };
}

describe('CT-04 VAT and levy lines sit under the line they are charged on', () => {
  it('nests VAT, NHIL and GETFund under their base line, in that order, keeping the API’s order of base lines', () => {
    const rent = line();
    const service = line({ kind: 'service_charge', label: 'Service charge', amountMinor: 30_000 });
    const tax = (kind: 'vat' | 'nhil' | 'getfund', base: InvoiceLineView, rateBps: number) =>
      line({ kind, baseLineId: base.id, rateBps, rule: RULE, accrued: false, periodStart: null });
    const getfund = tax('getfund', rent, 250);
    const vat = tax('vat', rent, 1500);
    const nhil = tax('nhil', rent, 250);
    const serviceVat = tax('vat', service, 1500);
    const groups = groupLines([rent, getfund, service, vat, serviceVat, nhil]);
    expect(groups.map((g) => g.line.id)).toEqual([rent.id, service.id]);
    expect(groups[0]?.taxes.map((t) => t.kind)).toEqual(['vat', 'nhil', 'getfund']);
    expect(groups[1]?.taxes.map((t) => t.id)).toEqual([serviceVat.id]);
  });

  it('shows a tax line on its own when its base line is not on the invoice', () => {
    const stray = line({ kind: 'vat', baseLineId: id(), rateBps: 1500 });
    expect(groupLines([stray]).map((g) => g.line.id)).toEqual([stray.id]);
  });

  it('warns staff where an unverified VAT rule is used, naming the rule (CLAUDE.md section 7)', () => {
    const vat = line({ kind: 'vat', rateBps: 1500, rule: RULE });
    const invoice = { lines: [line(), vat], unverifiedRules: true, hasVat: true };
    expect(unverifiedRuleKeys(invoice)).toEqual(['vat.commercial_rent']);
    expect(vatWarning(invoice)).toBe(
      'The VAT, NHIL and GETFund on this invoice use rates from rules a tax adviser has not yet verified (vat.commercial_rent). Check them before relying on them (OQ-20).',
    );
    // A rule from the PRD is not verified either.
    const fromPrd = line({ rule: { ...RULE, verificationStatus: 'from_prd' } });
    expect(vatWarning({ lines: [fromPrd], unverifiedRules: false, hasVat: true })).not.toBeNull();
  });

  it('shows no warning when every rule used is verified, and does not repeat the API’s', () => {
    const verified = line({ rule: { ...RULE, verificationStatus: 'verified' } });
    expect(vatWarning({ lines: [verified], unverifiedRules: false, hasVat: true })).toBeNull();
    expect(vatWarning({ lines: [line()], unverifiedRules: false, hasVat: false })).toBeNull();
    const shown = 'The VAT … not yet verified';
    expect(
      otherInvoiceWarnings(['VAT rates are not verified by a tax adviser', 'Billed late'], shown),
    ).toEqual(['Billed late']);
    expect(otherInvoiceWarnings(['VAT rates are not verified'], null)).toEqual([
      'VAT rates are not verified',
    ]);
  });
});

describe('P27 and P24 credit notes and write-offs offered per line', () => {
  it('offers each correction up to the amount the API allows, never the browser’s own figure', () => {
    // A paid rent line the API says can be credited in full, and not written off.
    const paid = line({ settledMinor: 300_000, outstandingMinor: 0, writeOffableMinor: 0 });
    expect(correctionsOffered(paid)).toEqual(['credit_note']);
    expect(correctionMax(paid, 'credit_note')).toBe(300_000);
    // The API's figure wins even where the line's other amounts would suggest more.
    const capped = line({ creditableMinor: 120_000, writeOffableMinor: 45_000 });
    expect(correctionMax(capped, 'credit_note')).toBe(120_000);
    expect(correctionMax(capped, 'write_off')).toBe(45_000);
  });

  it('offers nothing the API allows no amount for', () => {
    // A VAT line follows its base line, and a paid deposit leaves only at move-out (M8).
    const vat = line({ kind: 'vat', baseLineId: id(), rateBps: 1500, creditableMinor: 0 });
    expect(correctionsOffered({ ...vat, writeOffableMinor: 0 })).toEqual([]);
    expect(correctionsOffered({ ...vat, writeOffableMinor: 45_000 })).toEqual(['write_off']);
  });
});

describe('CT-04 and P27 each line is named where it is acted on', () => {
  it('names a line with its period, and a tax line with its rate and its base line', () => {
    const rent = line({ label: 'Rent' });
    expect(lineName(rent)).toBe('Rent, 15 Nov 2026 to 14 Dec 2026');
    const vat = line({ kind: 'vat', label: 'VAT', baseLineId: rent.id, rateBps: 1500 });
    expect(lineName(vat, rent)).toBe('VAT at 15% on Rent, 15 Nov 2026 to 14 Dec 2026');
    expect(lineName(vat)).toBe('VAT at 15%');
    const deposit = line({
      kind: 'deposit',
      label: 'Security deposit',
      periodStart: null,
      periodEnd: null,
    });
    expect(lineName(deposit)).toBe('Security deposit');
  });
});
