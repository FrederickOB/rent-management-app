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

function Dashboard({ data, branding }: TemplateProps<DashboardDocumentData>) {
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
          <tr>
            <th scope="row">Figures as of</th>
            <td>{data.asOf ? when(data.asOf) : 'Not worked out yet'}</td>
          </tr>
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

export const dashboardV1 = defineTemplate({
  key: 'reporting.dashboard',
  version: 1,
  title: 'Portfolio dashboard',
  schema: dashboardSchema,
  Component: Dashboard,
});
