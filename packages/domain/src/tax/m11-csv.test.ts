import { describe, expect, it } from 'vitest';
import { toCsv } from './report';

// M11 security review R3 F11 (ASVS 1.2.10): a spreadsheet opening the rent tax CSV never runs a
// tenant's name or a unit code as a formula. A text field starting with =, +, -, @, a tab or a
// carriage return is prefixed with a single quote; amounts and dates are left alone.

describe('TX-03 NFR-SEC the tax CSV neutralises formulas in tenant names and unit codes (M11 review R3 F11)', () => {
  it('prefixes a quote to text that a spreadsheet would read as a formula', () => {
    const csv = toCsv([
      ['Unit', 'Tenant', 'Tax (GHS)'],
      ['=HYPERLINK("http://x")', '+233 Traders', '96.00'],
      ['-ACC-1', '@SUM(A1:A9)', '-0.07'],
      ['\tTAB-1', '\rCR Ltd', '1500.00'],
      ['ACC-LEG-B1-01', 'Ama Mensah', '-12'],
    ]);
    expect(csv).toBe(
      '"Unit","Tenant","Tax (GHS)"\r\n' +
        '"\'=HYPERLINK(""http://x"")","\'+233 Traders","96.00"\r\n' +
        '"\'-ACC-1","\'@SUM(A1:A9)","-0.07"\r\n' +
        '"\'\tTAB-1","\'\rCR Ltd","1500.00"\r\n' +
        '"ACC-LEG-B1-01","Ama Mensah","-12"\r\n',
    );
  });

  it('gives the same bytes for the same rows, so a regenerated report is identical', () => {
    const rows = [['=1+1', '-x', null, 42]] as const;
    expect(toCsv(rows)).toBe(toCsv(rows));
    expect(toCsv(rows)).toBe('"\'=1+1","\'-x","","42"\r\n');
  });
});
