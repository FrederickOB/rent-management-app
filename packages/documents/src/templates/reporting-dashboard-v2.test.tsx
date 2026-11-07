import { describe, expect, it } from 'vitest';
import { renderHtml, templates } from './index';
import {
  DASHBOARD_LIVE_FIGURES,
  DASHBOARD_SNAPSHOT_FIGURES,
  type DashboardDocumentDataV2,
} from './reporting-dashboard';
import { sampleBranding } from './test-fixtures';

const data: DashboardDocumentDataV2 = {
  title: 'Osu Ridge: portfolio dashboard',
  generatedAt: '2026-11-06T10:15:00.000Z',
  liveAt: '2026-11-06T10:15:00.000Z',
  timeZone: 'Africa/Accra',
  asOf: '2026-11-06T04:00:00.000Z',
  date: '2026-11-06',
  filters: [],
  rows: [
    { section: 'Occupancy', figure: 'Units', count: 12, amountMinor: null, bps: null },
    { section: 'Arrears', figure: 'Total arrears', count: null, amountMinor: 81_000, bps: null },
  ],
};

describe('DA-06 the dashboard PDF names its snapshot and its live figures apart (M9 review)', () => {
  it('says what "Figures as of" covers, and when the live figures were read, each with the zone', () => {
    const html = renderHtml(templates.get('reporting.dashboard', 2), data, sampleBranding);
    expect(html).toContain(`04:00 GMT (Africa/Accra): ${DASHBOARD_SNAPSHOT_FIGURES}`);
    expect(html).toContain('Live figures as of');
    expect(html).toContain(`10:15 GMT (Africa/Accra): ${DASHBOARD_LIVE_FIGURES}`);
    // The live figures are not claimed by the snapshot's line.
    expect(DASHBOARD_SNAPSHOT_FIGURES).not.toMatch(/occupancy|collection rate/);
    expect(html).toContain('GH₵810.00');
  });

  it('says the snapshot is not worked out yet before the first rollup, and needs liveAt', () => {
    const template = templates.get('reporting.dashboard', 2);
    const html = renderHtml(template, { ...data, asOf: null }, sampleBranding);
    expect(html).toContain(`Not worked out yet: ${DASHBOARD_SNAPSHOT_FIGURES}`);
    const { liveAt: _liveAt, ...withoutLive } = data;
    expect(() => template.element(withoutLive, sampleBranding)).toThrow();
    expect(() => template.element({ ...data, extra: true }, sampleBranding)).toThrow();
  });

  it('leaves version 1 as it was, for exports already requested with it', () => {
    const { liveAt: _liveAt, ...v1 } = data;
    const html = renderHtml(templates.get('reporting.dashboard', 1), v1, sampleBranding);
    expect(html).toContain('Figures as of');
    expect(html).not.toContain('Live figures as of');
    expect(html).not.toContain(DASHBOARD_SNAPSHOT_FIGURES);
  });
});
