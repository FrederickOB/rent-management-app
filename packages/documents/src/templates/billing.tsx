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
 * Invoices and receipts (BC-01, BC-06, CT-04; M4a plan 4.4 and 4.10). Amounts are integer
 * pesewas, formatted only here at the edge. A commercial invoice for a VAT-registered owner names
 * both parties with their TINs and shows the VAT and levies line by line.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const party = z.strictObject({
  name: z.string().min(1).max(200),
  tin: z.string().min(1).max(40).nullable(),
});
const unit = z.strictObject({
  code: z.string().min(1).max(40),
  propertyName: z.string().min(1).max(200),
});

const invoiceSchema = z.strictObject({
  number: z.string().min(1).max(40),
  kind: z.enum(['cycle', 'deposit', 'one_off']),
  issueDate: isoDate,
  dueDate: isoDate,
  periodFrom: isoDate.nullable(),
  periodTo: isoDate.nullable(),
  paymentReference: z.string().min(1).max(20),
  billedTo: party,
  /** The owner the rent is due to; for an agency, the agency is the sender named on the letterhead. */
  billedFrom: party,
  unit,
  lines: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(200),
        periodStart: isoDate.nullable(),
        periodEnd: isoDate.nullable(),
        rateBps: z.int().min(0).max(100_000).nullable(),
        amountMinor: z.int(),
        /** VAT and levy lines are indented under the line they are charged on. */
        isTax: z.boolean(),
      }),
    )
    .min(1)
    .max(400),
  totalMinor: z.int(),
  vatTotalMinor: z.int().nullable(),
  notes: z.array(z.string().max(500)).max(10),
});

export type InvoiceDocumentData = z.infer<typeof invoiceSchema>;

const amount = (minor: number) => format(money(minor));
const period = (from: string | null, to: string | null) =>
  from && to ? `${formatBusinessDate(from)} to ${formatBusinessDate(to)}` : null;
const percent = (bps: number) => `${(bps / 100).toString()}%`;

const INVOICE_TITLES: Record<InvoiceDocumentData['kind'], string> = {
  cycle: 'Rent invoice',
  deposit: 'Security deposit invoice',
  one_off: 'Invoice',
};

function Invoice({ data, branding }: TemplateProps<InvoiceDocumentData>) {
  const covering = period(data.periodFrom, data.periodTo);
  return (
    <Letterhead branding={branding}>
      <h1>{data.vatTotalMinor !== null ? 'Tax invoice' : INVOICE_TITLES[data.kind]}</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Invoice number</th>
            <td>{data.number}</td>
          </tr>
          <tr>
            <th scope="row">Issued</th>
            <td>{formatBusinessDate(data.issueDate)}</td>
          </tr>
          <tr>
            <th scope="row">Due</th>
            <td>{formatBusinessDate(data.dueDate)}</td>
          </tr>
          {covering ? (
            <tr>
              <th scope="row">Covering</th>
              <td>{covering}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">To</th>
            <td>
              {data.billedTo.tin
                ? `${data.billedTo.name} (TIN ${data.billedTo.tin})`
                : data.billedTo.name}
            </td>
          </tr>
          <tr>
            <th scope="row">From</th>
            <td>
              {data.billedFrom.tin
                ? `${data.billedFrom.name} (TIN ${data.billedFrom.tin})`
                : data.billedFrom.name}
            </td>
          </tr>
          <tr>
            <th scope="row">Unit</th>
            <td>{`${data.unit.code}, ${data.unit.propertyName}`}</td>
          </tr>
          <tr>
            <th scope="row">Payment reference</th>
            <td className="reference">{data.paymentReference}</td>
          </tr>
        </tbody>
      </table>
      <table className="lines">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="amount">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((line, i) => {
            const when = period(line.periodStart, line.periodEnd);
            const label =
              line.rateBps !== null ? `${line.label} at ${percent(line.rateBps)}` : line.label;
            return (
              <tr key={i}>
                <td className={line.isTax ? 'tax' : undefined}>
                  {label}
                  {when ? <span className="small">{` (${when})`}</span> : null}
                </td>
                <td className="amount">{amount(line.amountMinor)}</td>
              </tr>
            );
          })}
          {data.vatTotalMinor !== null ? (
            <tr>
              <th scope="row">VAT and levies</th>
              <td className="amount">{amount(data.vatTotalMinor)}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">Total</th>
            <td className="amount">{amount(data.totalMinor)}</td>
          </tr>
        </tbody>
      </table>
      <p>{`Please quote ${data.paymentReference} with every payment.`}</p>
      {data.notes.map((note, i) => (
        <p key={i} className="small">
          {note}
        </p>
      ))}
    </Letterhead>
  );
}

export const invoiceV1 = defineTemplate({
  key: 'billing.invoice',
  version: 1,
  title: 'Invoice',
  schema: invoiceSchema,
  Component: Invoice,
});

const receiptSchema = z.strictObject({
  number: z.string().min(1).max(40),
  kind: z.enum(['receipt', 'credit_receipt']),
  /** The server's time the receipt was issued, shown in `timeZone` (DO-04). */
  issuedAt: z.iso.datetime({ offset: true }),
  timeZone: z.string().refine(isValidTimeZone, 'Expected an IANA time zone such as Africa/Accra'),
  receivedOn: isoDate,
  /** For example "Cash", "Cheque 004512 (GCB Bank)", "Bank transfer". */
  method: z.string().min(1).max(120),
  receivedFrom: z.string().min(1).max(200),
  tenant: party,
  billedFrom: party,
  unit,
  paymentReference: z.string().min(1).max(20),
  amountMinor: z.int(),
  allocations: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(200),
        invoiceNumber: z.string().min(1).max(40),
        amountMinor: z.int(),
      }),
    )
    .max(400),
  /** Held as the tenant's credit for later months. */
  creditMinor: z.int(),
  vatMinor: z.int().nullable(),
  paidUntil: isoDate.nullable(),
  partial: z.strictObject({ monthStart: isoDate, amountMinor: z.int() }).nullable(),
  /** For cash and cheques: who received the money (BC-05). */
  receivedBy: z.string().min(1).max(200).nullable(),
  /** A credit receipt names the receipt it reverses and why. */
  reverses: z
    .strictObject({ number: z.string().min(1).max(40), reason: z.string().min(1).max(300) })
    .nullable(),
});

export type ReceiptDocumentData = z.infer<typeof receiptSchema>;

function Receipt({ data, branding }: TemplateProps<ReceiptDocumentData>) {
  const credit = data.kind === 'credit_receipt';
  return (
    <Letterhead branding={branding}>
      <h1>{credit ? 'Credit receipt' : 'Receipt'}</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Receipt number</th>
            <td>{data.number}</td>
          </tr>
          <tr>
            <th scope="row">Issued</th>
            <td>{formatInstant(instantFrom(data.issuedAt), data.timeZone)}</td>
          </tr>
          {data.reverses ? (
            <tr>
              <th scope="row">Reverses</th>
              <td>{`Receipt ${data.reverses.number}: ${data.reverses.reason}`}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">{credit ? 'Originally received' : 'Received'}</th>
            <td>{`${formatBusinessDate(data.receivedOn)}, ${data.method}`}</td>
          </tr>
          <tr>
            <th scope="row">From</th>
            <td>{data.receivedFrom}</td>
          </tr>
          <tr>
            <th scope="row">Tenant</th>
            <td>
              {data.tenant.tin ? `${data.tenant.name} (TIN ${data.tenant.tin})` : data.tenant.name}
            </td>
          </tr>
          <tr>
            <th scope="row">Landlord</th>
            <td>
              {data.billedFrom.tin
                ? `${data.billedFrom.name} (TIN ${data.billedFrom.tin})`
                : data.billedFrom.name}
            </td>
          </tr>
          <tr>
            <th scope="row">Unit</th>
            <td>{`${data.unit.code}, ${data.unit.propertyName}`}</td>
          </tr>
          <tr>
            <th scope="row">Payment reference</th>
            <td className="reference">{data.paymentReference}</td>
          </tr>
          {data.receivedBy ? (
            <tr>
              <th scope="row">Received by</th>
              <td>{data.receivedBy}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">{credit ? 'Amount reversed' : 'Amount'}</th>
            <td className="amount">{amount(data.amountMinor)}</td>
          </tr>
        </tbody>
      </table>
      {data.allocations.length > 0 ? (
        <table className="lines">
          <thead>
            <tr>
              <th scope="col">{credit ? 'No longer paid' : 'Paid towards'}</th>
              <th scope="col" className="amount">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {data.allocations.map((a, i) => (
              <tr key={i}>
                <td>{`${a.label} (invoice ${a.invoiceNumber})`}</td>
                <td className="amount">{amount(a.amountMinor)}</td>
              </tr>
            ))}
            {data.creditMinor > 0 ? (
              <tr>
                <td>{credit ? 'Credit withdrawn' : 'Held as credit for later months'}</td>
                <td className="amount">{amount(data.creditMinor)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
      {data.vatMinor !== null && data.vatMinor > 0 ? (
        <p>{`Of this, ${amount(data.vatMinor)} is VAT and levies.`}</p>
      ) : null}
      {data.paidUntil ? (
        <p>
          {`Rent is paid until ${formatBusinessDate(data.paidUntil)}`}
          {data.partial
            ? `, plus ${amount(data.partial.amountMinor)} towards the month starting ${formatBusinessDate(data.partial.monthStart)}.`
            : '.'}
        </p>
      ) : data.partial ? (
        <p>
          {`${amount(data.partial.amountMinor)} is paid towards the month starting ${formatBusinessDate(data.partial.monthStart)}.`}
        </p>
      ) : null}
    </Letterhead>
  );
}

export const receiptV1 = defineTemplate({
  key: 'billing.receipt',
  version: 1,
  title: 'Receipt',
  schema: receiptSchema,
  Component: Receipt,
});
