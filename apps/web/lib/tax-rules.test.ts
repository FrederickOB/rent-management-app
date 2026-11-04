import { describe, expect, it } from 'vitest';
import { confirmerOf, rulesWarning, ruleName, verificationLabel, warns } from './tax-rules';

describe('TX-08 a figure worked out with an unverified rule says so (CLAUDE.md section 7)', () => {
  it('warns for an unverified rule and for one taken from the PRD, never for a verified one', () => {
    expect(warns({ key: 'rent_tax.base', verificationStatus: 'unverified' })).toBe(true);
    expect(warns({ key: 'rent_tax.rate.residential', verificationStatus: 'from_prd' })).toBe(true);
    expect(warns({ key: 'rent_tax.rate.residential', verificationStatus: 'verified' })).toBe(false);
    // The API's own flag is honoured even on a verified rule.
    expect(
      warns({ key: 'rent_tax.rate.residential', verificationStatus: 'verified', warning: true }),
    ).toBe(true);
  });

  it('names each rule, with its key, and who must confirm it', () => {
    const warning = rulesWarning([
      { key: 'rent_tax.rounding', verificationStatus: 'unverified' },
      { key: 'rent_tax.base', verificationStatus: 'unverified' },
      { key: 'rent_tax.base', verificationStatus: 'unverified' },
      { key: 'rent_tax.due_days_after_receipt', verificationStatus: 'verified' },
    ]);
    expect(warning?.keys).toEqual(['rent_tax.base', 'rent_tax.rounding']);
    expect(warning?.text).toBe(
      'These figures use what rent tax is charged on (rent_tax.base) and how rent tax is rounded (rent_tax.rounding), which a tax adviser has not yet verified. Check them before relying on them; a confirmed value is added as a new rule and never changes figures already worked out.',
    );
  });

  it('asks counsel for the law and a tax adviser for tax', () => {
    expect(confirmerOf('advance_rent.max_months.over_six_months')).toBe('counsel');
    expect(confirmerOf('withholding_tax.rate.commercial')).toBe('tax adviser');
    const both = rulesWarning([
      { key: 'advance_rent.max_months.over_six_months', verificationStatus: 'unverified' },
      { key: 'vat.commercial_rent', verificationStatus: 'unverified' },
    ]);
    expect(both?.text).toContain('which counsel and a tax adviser have not yet verified');
  });

  it('shows the API’s own warning words when it sends them', () => {
    expect(
      rulesWarning(
        [{ key: 'rent_tax.base', verificationStatus: 'unverified' }],
        [' The rent tax base is unverified (OQ-17). '],
      ),
    ).toEqual({
      title: 'Worked out with rules not yet verified',
      text: 'The rent tax base is unverified (OQ-17).',
      keys: ['rent_tax.base'],
    });
  });

  it('shows nothing when every rule used is verified', () => {
    expect(rulesWarning([{ key: 'rent_tax.base', verificationStatus: 'verified' }])).toBeNull();
    expect(rulesWarning([])).toBeNull();
  });

  it('says a rule’s status plainly, and an unknown key by its key', () => {
    expect(verificationLabel({ key: 'rent_tax.base', verificationStatus: 'unverified' })).toBe(
      'Unverified: a tax adviser to confirm',
    );
    expect(
      verificationLabel({
        key: 'advance_rent.max_months.over_six_months',
        verificationStatus: 'from_prd',
      }),
    ).toBe('Taken from the PRD, not yet confirmed by counsel');
    expect(verificationLabel({ key: 'rent_tax.base', verificationStatus: 'verified' })).toBe(
      'Verified',
    );
    expect(ruleName('something.new')).toBe('something.new');
  });
});
