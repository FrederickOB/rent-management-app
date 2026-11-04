import { formatBusinessDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { z } from 'zod';
import { Letterhead } from './letterhead';
import { defineTemplate, type TemplateProps } from './registry';

/**
 * The per-owner rent tax report (TX-03; M5 plan 5.3): the rent tax on each receipt in a period,
 * selected by accounting date, with its base, rate, due date and status as of the period's end,
 * then the totals, GRA payments and what is still owed. It carries no time of generation, so a
 * report for a locked month regenerates byte for byte (`pdfDate` fixes the PDF's own dates).
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rentTaxReportSchema = z.strictObject({
  /** Not printed: who may fetch the PDF is decided by the owner it is for. */
  ownerId: z.uuid(),
  owner: z.strictObject({
    name: z.string().min(1).max(200),
    tin: z.string().min(1).max(40).nullable(),
  }),
  from: isoDate,
  to: isoDate,
  items: z
    .array(
      z.strictObject({
        valueDate: isoDate,
        accountingDate: isoDate,
        kind: z.string().min(1).max(40),
        receiptNumber: z.string().max(40).nullable(),
        unitCode: z.string().min(1).max(40),
        tenantName: z.string().min(1).max(200),
        baseMinor: z.int(),
        rateBps: z.int().min(0).max(100_000),
        taxMinor: z.int(),
        dueDate: isoDate.nullable(),
        status: z.string().min(1).max(40),
      }),
    )
    .max(5_000),
  graPayments: z
    .array(
      z.strictObject({
        paidOn: isoDate,
        graReceiptNumber: z.string().min(1).max(80),
        amountMinor: z.int(),
      }),
    )
    .max(1_000),
  totals: z.strictObject({
    baseMinor: z.int(),
    taxMinor: z.int(),
    withheldMinor: z.int(),
    paidToGraMinor: z.int(),
    settledByCertificatesMinor: z.int(),
    outstandingMinor: z.int(),
  }),
  /** Rules rows not yet verified that these figures used (CLAUDE.md section 7). */
  warnings: z.array(z.string().max(500)).max(20),
});

export type RentTaxReportData = z.infer<typeof rentTaxReportSchema>;

/**
 * Version 2 (M5 review 3): tax withheld by tenants and still awaiting its certificate is shown on
 * its own, and "still owed" leaves it out (the tenant pays it to GRA). Version 1 stays registered
 * so documents rendered with it keep their template (ADR-006).
 */
const rentTaxReportV2Schema = rentTaxReportSchema.extend({
  totals: z.strictObject({
    baseMinor: z.int(),
    taxMinor: z.int(),
    withheldMinor: z.int(),
    paidToGraMinor: z.int(),
    settledByCertificatesMinor: z.int(),
    withheldAwaitingCertificateMinor: z.int(),
    outstandingMinor: z.int(),
  }),
});

export type RentTaxReportV2Data = z.infer<typeof rentTaxReportV2Schema>;

const amount = (minor: number) => format(money(minor));
const percent = (bps: number) => `${(bps / 100).toString()}%`;

function RentTaxReport({ data, branding }: TemplateProps<RentTaxReportData | RentTaxReportV2Data>) {
  const awaiting =
    'withheldAwaitingCertificateMinor' in data.totals
      ? data.totals.withheldAwaitingCertificateMinor
      : null;
  return (
    <Letterhead branding={branding}>
      <h1>Rent tax report</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Owner</th>
            <td>
              {data.owner.tin ? `${data.owner.name} (TIN ${data.owner.tin})` : data.owner.name}
            </td>
          </tr>
          <tr>
            <th scope="row">Period</th>
            <td>{`${formatBusinessDate(data.from)} to ${formatBusinessDate(data.to)}`}</td>
          </tr>
        </tbody>
      </table>
      {data.warnings.length > 0 ? (
        <div className="small">
          {data.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}
      <h2>Rent tax by receipt</h2>
      <table className="lines">
        <thead>
          <tr>
            <th scope="col">Received</th>
            <th scope="col">Receipt</th>
            <th scope="col">Unit and tenant</th>
            <th scope="col" className="amount">
              Base
            </th>
            <th scope="col">Rate</th>
            <th scope="col" className="amount">
              Tax
            </th>
            <th scope="col">Due</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item, i) => (
            <tr key={i}>
              <td>{formatBusinessDate(item.valueDate)}</td>
              <td>{item.receiptNumber ?? item.kind}</td>
              <td>{`${item.unitCode}, ${item.tenantName}`}</td>
              <td className="amount">{amount(item.baseMinor)}</td>
              <td>{percent(item.rateBps)}</td>
              <td className="amount">{amount(item.taxMinor)}</td>
              <td>{item.dueDate ? formatBusinessDate(item.dueDate) : ''}</td>
              <td>{item.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Totals</h2>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Rent taxed</th>
            <td className="amount">{amount(data.totals.baseMinor)}</td>
          </tr>
          <tr>
            <th scope="row">Rent tax</th>
            <td className="amount">{amount(data.totals.taxMinor)}</td>
          </tr>
          <tr>
            <th scope="row">Of which withheld by tenants</th>
            <td className="amount">{amount(data.totals.withheldMinor)}</td>
          </tr>
          <tr>
            <th scope="row">Paid to GRA in the period</th>
            <td className="amount">{amount(data.totals.paidToGraMinor)}</td>
          </tr>
          <tr>
            <th scope="row">Settled by withholding certificates in the period</th>
            <td className="amount">{amount(data.totals.settledByCertificatesMinor)}</td>
          </tr>
          {awaiting === null ? null : (
            <tr>
              <th scope="row">Withheld by tenants, awaiting certificate</th>
              <td className="amount">{amount(awaiting)}</td>
            </tr>
          )}
          <tr>
            <th scope="row">Still owed at the end of the period</th>
            <td className="amount">{amount(data.totals.outstandingMinor)}</td>
          </tr>
        </tbody>
      </table>
      {data.graPayments.length > 0 ? (
        <>
          <h2>GRA payments</h2>
          <table className="lines">
            <thead>
              <tr>
                <th scope="col">Paid</th>
                <th scope="col">GRA receipt</th>
                <th scope="col" className="amount">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {data.graPayments.map((g, i) => (
                <tr key={i}>
                  <td>{formatBusinessDate(g.paidOn)}</td>
                  <td>{g.graReceiptNumber}</td>
                  <td className="amount">{amount(g.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Letterhead>
  );
}

export const rentTaxReportV1 = defineTemplate({
  key: 'tax.rent-tax-report',
  version: 1,
  title: 'Rent tax report',
  schema: rentTaxReportSchema,
  Component: RentTaxReport,
  pdfDate: (data) => data.to,
});

export const rentTaxReportV2 = defineTemplate({
  key: 'tax.rent-tax-report',
  version: 2,
  title: 'Rent tax report',
  schema: rentTaxReportV2Schema,
  Component: RentTaxReport,
  pdfDate: (data) => data.to,
});
