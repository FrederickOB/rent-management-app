import {
  formatBusinessDate,
  formatInstant,
  instantFrom,
  isValidTimeZone,
} from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { z } from 'zod';
import { Letterhead } from './letterhead';
import { defineTemplate, type TemplateProps } from './registry';

/**
 * The portfolio dashboard as a PDF (M9: DA-01, DA-02 and DA-06). The server sends the rows the
 * screen shows (`dashboardRows`), so the PDF and the Excel export carry the same figures. Amounts
 * are integer pesewas, formatted only here; shares are basis points; the snapshot's instant is
 * shown in the company's time zone, named (DO-04).
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rowSchema = z.strictObject({
  section: z.string().min(1).max(80),
  figure: z.string().min(1).max(120),
  count: z.int().nullable(),
  amountMinor: z.int().nullable(),
  /** A share in basis points; null when there was nothing to measure. */
  bps: z.int().nullable(),
});

const dashboardSchema = z.strictObject({
  title: z.string().min(1).max(200),
  generatedAt: z.string().datetime(),
  timeZone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
  /** When the snapshot was worked out; null before the first rollup. */
  asOf: z.string().datetime().nullable(),
  date: isoDate,
  filters: z
    .array(z.strictObject({ label: z.string().min(1).max(40), value: z.string().min(1).max(200) }))
    .max(4),
  rows: z.array(rowSchema).min(1).max(300),
});
export type DashboardDocumentData = z.infer<typeof dashboardSchema>;

const share = (bps: number | null) =>
  bps === null ? '—' : `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;

function value(row: DashboardDocumentData['rows'][number]): string {
  if (row.amountMinor !== null) return format(money(row.amountMinor));
  if (row.count !== null) return String(row.count);
  return share(row.bps);
}

/** The header lines above the figures: v1's single line, or v2's snapshot and live lines. */
type Header = (when: (iso: string) => string) => { label: string; value: string }[];

function DashboardBody({
  data,
  branding,
  header,
}: TemplateProps<DashboardDocumentData> & { header: Header }) {
  const sections: { name: string; rows: DashboardDocumentData['rows'] }[] = [];
  for (const row of data.rows) {
    const last = sections[sections.length - 1];
    if (last && last.name === row.section) last.rows.push(row);
    else sections.push({ name: row.section, rows: [row] });
  }
  // `28 Oct 2026, 04:00 GMT (Africa/Accra)`: the zone is always named (DO-04).
  const when = (iso: string) => formatInstant(instantFrom(iso), data.timeZone);
  return (
    <Letterhead branding={branding}>
      <h1>{data.title}</h1>
      <table className="summary">
        <tbody>
          {header(when).map((h) => (
            <tr key={h.label}>
              <th scope="row">{h.label}</th>
              <td>{h.value}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Snapshot date</th>
            <td>{formatBusinessDate(data.date)}</td>
          </tr>
          <tr>
            <th scope="row">Exported</th>
            <td>{when(data.generatedAt)}</td>
          </tr>
          {data.filters.map((f) => (
            <tr key={f.label}>
              <th scope="row">{f.label}</th>
              <td>{f.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sections.map((section) => (
        <section key={section.name}>
          <h2>{section.name}</h2>
          <table className="lines">
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.figure}>
                  <td>{row.figure}</td>
                  <td className="amount">{value(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </Letterhead>
  );
}

function Dashboard(props: TemplateProps<DashboardDocumentData>) {
  const { data } = props;
  return (
    <DashboardBody
      {...props}
      header={(when) => [
        { label: 'Figures as of', value: data.asOf ? when(data.asOf) : 'Not worked out yet' },
      ]}
    />
  );
}

export const dashboardV1 = defineTemplate({
  key: 'reporting.dashboard',
  version: 1,
  title: 'Portfolio dashboard',
  schema: dashboardSchema,
  Component: Dashboard,
});

/**
 * Version 2 (M9 review): "Figures as of" names only the snapshot's figures, and a separate line
 * says when the live ones (occupancy and this month's collection rate) were read (`liveAt`).
 */
const dashboardV2Schema = dashboardSchema.extend({
  /** When the live figures were read: the moment of the export. */
  liveAt: z.string().datetime(),
});
export type DashboardDocumentDataV2 = z.infer<typeof dashboardV2Schema>;

/** What the snapshot carries, and what is read live, as the screen labels them. */
export const DASHBOARD_SNAPSHOT_FIGURES =
  'arrears, rent roll, money held for tenants, paid-until coverage, lease expiries and Gate 1';
export const DASHBOARD_LIVE_FIGURES = 'occupancy and this month’s collection rate';

function DashboardV2(props: TemplateProps<DashboardDocumentDataV2>) {
  const { data } = props;
  return (
    <DashboardBody
      {...props}
      header={(when) => [
        {
          label: 'Figures as of',
          value: data.asOf
            ? `${when(data.asOf)}: ${DASHBOARD_SNAPSHOT_FIGURES}`
            : `Not worked out yet: ${DASHBOARD_SNAPSHOT_FIGURES}`,
        },
        { label: 'Live figures as of', value: `${when(data.liveAt)}: ${DASHBOARD_LIVE_FIGURES}` },
      ]}
    />
  );
}

export const dashboardV2 = defineTemplate({
  key: 'reporting.dashboard',
  version: 2,
  title: 'Portfolio dashboard',
  schema: dashboardV2Schema,
  Component: DashboardV2,
});
