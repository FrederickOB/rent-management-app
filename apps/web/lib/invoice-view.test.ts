import type { InvoiceLineView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  groupLines,
  lineCorrections,
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
  it('offers a credit note up to what the line charges, less any write-off', () => {
    const paid = line({ settledMinor: 300_000, outstandingMinor: 0 });
    expect(lineCorrections(paid)).toEqual({ creditableMinor: 300_000, writableOffMinor: 0 });
    const part = line({ writtenOffMinor: 100_000, outstandingMinor: 200_000 });
    expect(lineCorrections(part)).toEqual({ creditableMinor: 200_000, writableOffMinor: 200_000 });
  });

  it('offers no credit note on a VAT or levy line: it follows the line it is charged on', () => {
    const vat = line({ kind: 'vat', baseLineId: id(), rateBps: 1500, amountMinor: 45_000 });
    expect(lineCorrections({ ...vat, netMinor: 45_000, outstandingMinor: 45_000 })).toEqual({
      creditableMinor: 0,
      writableOffMinor: 45_000,
    });
  });

  it('credits only the unpaid part of a deposit, and never writes a deposit off', () => {
    const deposit = line({
      kind: 'deposit',
      periodStart: null,
      periodEnd: null,
      amountMinor: 500_000,
      netMinor: 500_000,
      settledMinor: 200_000,
      outstandingMinor: 300_000,
      accrued: false,
    });
    expect(lineCorrections(deposit)).toEqual({ creditableMinor: 300_000, writableOffMinor: 0 });
  });

  it('writes off only a charge already owed: a rent period that has not started is credited instead', () => {
    const future = line({ accrued: false });
    expect(lineCorrections(future)).toEqual({ creditableMinor: 300_000, writableOffMinor: 0 });
    const oneOff = line({ kind: 'one_off', periodStart: null, periodEnd: null, accrued: false });
    expect(lineCorrections(oneOff).writableOffMinor).toBe(300_000);
  });
});
