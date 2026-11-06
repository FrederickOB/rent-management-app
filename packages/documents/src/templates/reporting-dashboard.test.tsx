import { describe, expect, it } from 'vitest';
import { renderHtml, templates } from './index';
import type { DashboardDocumentData } from './reporting-dashboard';
import { sampleBranding } from './test-fixtures';

const data: DashboardDocumentData = {
  title: 'Osu Ridge: portfolio dashboard',
  generatedAt: '2026-11-06T10:15:00.000Z',
  timeZone: 'Africa/Accra',
  asOf: '2026-11-06T04:00:00.000Z',
  date: '2026-11-06',
  filters: [{ label: 'Owner', value: 'Kofi Asante' }],
  rows: [
    { section: 'Occupancy', figure: 'Units', count: 12, amountMinor: null, bps: null },
    { section: 'Occupancy', figure: 'Occupancy rate', count: null, amountMinor: null, bps: 8_333 },
    { section: 'Arrears', figure: 'Total arrears', count: null, amountMinor: 81_000, bps: null },
    {
      section: 'Gate 1, 2026-11',
      figure: 'Collection rate',
      count: null,
      amountMinor: null,
      bps: null,
    },
  ],
};

describe('DA-06 the dashboard PDF shows the screen’s rows', () => {
  it('renders every figure: counts, amounts in cedis, shares in percent, and the time zone named', () => {
    const template = templates.get('reporting.dashboard', 1);
    const html = renderHtml(template, data, sampleBranding);
    expect(html).toContain('Osu Ridge: portfolio dashboard');
    expect(html).toContain('GH₵810.00');
    expect(html).toContain('83.33%');
    expect(html).toContain('—');
    expect(html).toContain('Africa/Accra');
    expect(html).toContain('Kofi Asante');
    expect(html).toContain('6 November 2026');
  });

  it('refuses data that does not fit: an amount that is not whole pesewas, or no rows', () => {
    const template = templates.get('reporting.dashboard', 1);
    expect(() =>
      template.element(
        { ...data, rows: [{ ...data.rows[2]!, amountMinor: 810.5 }] },
        sampleBranding,
      ),
    ).toThrow();
    expect(() => template.element({ ...data, rows: [] }, sampleBranding)).toThrow();
    expect(() => template.element({ ...data, extra: true }, sampleBranding)).toThrow();
  });
});
