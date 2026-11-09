import { formatBusinessDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { z } from 'zod';
import { Letterhead } from './letterhead';
import { defineTemplate, type TemplateProps } from './registry';

/**
 * The platform's subscription invoice and receipt (M10: PB-02, PB-07; decisions 2, 7, 9 and 10).
 * They are the platform's own documents, on the platform company's letterhead, sent to the
 * subscriber. Amounts are integer pesewas, formatted only here at the edge (GH₵1,500.00).
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = z.string().min(1).max(200);
const units = z.int().min(0).max(1_000_000);

const invoiceSchema = z.strictObject({
  platformName: name,
  subscriberName: name,
  subscriberLegalName: name,
  /** Gap-free: `SUB-2026-000001`. */
  number: z.string().regex(/^SUB-\d{4}-\d{6,}$/),
  /** The month billed in arrears, `YYYY-MM`, and its label (`October 2026`). */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  monthLabel: z.string().min(1).max(40),
  issuedOn: isoDate,
  dueOn: isoDate,
  lines: z
    .array(z.strictObject({ description: z.string().min(1).max(300), amountMinor: z.int() }))
    .max(200),
  subtotalMinor: z.int(),
  /** Zero or negative. */
  discountMinor: z.int(),
  netMinor: z.int(),
  vatMinor: z.int(),
  totalMinor: z.int(),
  /** Settled from prepaid credit (2020) when the invoice was issued. */
  prepaidMinor: z.int(),
  amountDueMinor: z.int(),
  /** VAT read an unverified rule (decision 10): the invoice says so. */
  vatUnverified: z.boolean(),
  /** Priced with placeholder rates (OQ-37): the invoice says so. */
  placeholderPrices: z.boolean(),
  /** The month's billable units by band (PB-01, PB-02; D8). */
  billableUnits: z.strictObject({ singleRoom: units, selfContained: units, commercial: units }),
});

export type SubscriptionInvoiceDocumentData = z.infer<typeof invoiceSchema>;

const amount = (minor: number) => format(money(minor));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function SubscriptionInvoice({ data, branding }: TemplateProps<SubscriptionInvoiceDocumentData>) {
  const u = data.billableUnits;
  const billedTo =
    data.subscriberLegalName === data.subscriberName
      ? data.subscriberName
      : `${data.subscriberLegalName} (trading as ${data.subscriberName})`;
  return (
    <Letterhead branding={branding}>
      <h1>Subscription invoice</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Invoice number</th>
            <td>{data.number}</td>
          </tr>
          <tr>
            <th scope="row">For</th>
            <td>{data.monthLabel}</td>
          </tr>
          <tr>
            <th scope="row">Issued</th>
            <td>{formatBusinessDate(data.issuedOn)}</td>
          </tr>
          <tr>
            <th scope="row">Due</th>
            <td>{formatBusinessDate(data.dueOn)}</td>
          </tr>
          <tr>
            <th scope="row">To</th>
            <td>{billedTo}</td>
          </tr>
          <tr>
            <th scope="row">From</th>
            <td>{data.platformName}</td>
          </tr>
          <tr>
            <th scope="row">Billable units</th>
            <td>
              {`${plural(u.singleRoom, 'single room', 'single rooms')}, ${plural(u.selfContained, 'self-contained unit', 'self-contained units')}, ${plural(u.commercial, 'commercial unit', 'commercial units')}`}
            </td>
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
          {data.lines.map((line, i) => (
            <tr key={i}>
              <td>{line.description}</td>
              <td className="amount">{amount(line.amountMinor)}</td>
            </tr>
          ))}
          {data.discountMinor !== 0 || data.vatMinor !== 0 ? (
            <tr>
              <th scope="row">Subtotal</th>
              <td className="amount">{amount(data.subtotalMinor)}</td>
            </tr>
          ) : null}
          {data.discountMinor !== 0 ? (
            <tr>
              <th scope="row">After the discount</th>
              <td className="amount">{amount(data.netMinor)}</td>
            </tr>
          ) : null}
          {data.vatMinor !== 0 ? (
            <tr>
              <th scope="row">VAT and levies</th>
              <td className="amount">{amount(data.vatMinor)}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">Total</th>
            <td className="amount">{amount(data.totalMinor)}</td>
          </tr>
          {data.prepaidMinor !== 0 ? (
            <tr>
              <th scope="row">Paid from prepaid credit</th>
              <td className="amount">{amount(-data.prepaidMinor)}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">Amount due</th>
            <td className="amount">{amount(data.amountDueMinor)}</td>
          </tr>
        </tbody>
      </table>
      {data.amountDueMinor > 0 ? (
        <p>
          {`Please pay by ${formatBusinessDate(data.dueOn)} on the subscription page (Settings, then Subscription), by mobile money or card.`}
        </p>
      ) : (
        <p>Nothing is due on this invoice.</p>
      )}
      <p className="small">
        {`Billed in arrears: a unit counts for ${data.monthLabel} if it had an active lease on any day of the month.`}
      </p>
      {data.placeholderPrices ? (
        <p className="small">The rates on this invoice are provisional while pricing is set.</p>
      ) : null}
      {data.vatMinor !== 0 && data.vatUnverified ? (
        <p className="small">
          VAT and levies on this invoice follow a rate still to be confirmed by a tax adviser.
        </p>
      ) : null}
    </Letterhead>
  );
}

export const subscriptionInvoiceV1 = defineTemplate({
  key: 'subscription.invoice',
  version: 1,
  title: 'Subscription invoice',
  schema: invoiceSchema,
  Component: SubscriptionInvoice,
});

const receiptSchema = z.strictObject({
  platformName: name,
  subscriberName: name,
  /** Gap-free: `SUBR-2026-000001`. */
  number: z.string().regex(/^SUBR-\d{4}-\d{6,}$/),
  paidOn: isoDate,
  amountMinor: z.int().positive(),
  channel: z.enum(['card', 'momo']),
  /** The payment's reference (`SUB-…`). */
  reference: z.string().min(1).max(100),
  purpose: z.enum(['invoices', 'annual']),
  /** The invoices it paid, oldest first. */
  invoices: z
    .array(z.strictObject({ number: z.string().min(1).max(40), amountMinor: z.int().positive() }))
    .max(400),
  /** Held as prepaid credit (2020) for later invoices. */
  creditMinor: z.int().min(0),
});

export type SubscriptionReceiptDocumentData = z.infer<typeof receiptSchema>;

const CHANNELS: Record<SubscriptionReceiptDocumentData['channel'], string> = {
  card: 'Card',
  momo: 'Mobile money',
};

function SubscriptionReceipt({ data, branding }: TemplateProps<SubscriptionReceiptDocumentData>) {
  return (
    <Letterhead branding={branding}>
      <h1>Subscription receipt</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Receipt number</th>
            <td>{data.number}</td>
          </tr>
          <tr>
            <th scope="row">Paid</th>
            <td>{`${formatBusinessDate(data.paidOn)}, ${CHANNELS[data.channel]}`}</td>
          </tr>
          <tr>
            <th scope="row">From</th>
            <td>{data.subscriberName}</td>
          </tr>
          <tr>
            <th scope="row">To</th>
            <td>{data.platformName}</td>
          </tr>
          <tr>
            <th scope="row">Payment reference</th>
            <td className="reference">{data.reference}</td>
          </tr>
          <tr>
            <th scope="row">Amount</th>
            <td className="amount">{amount(data.amountMinor)}</td>
          </tr>
        </tbody>
      </table>
      {data.invoices.length > 0 || data.creditMinor > 0 ? (
        <table className="lines">
          <thead>
            <tr>
              <th scope="col">Paid towards</th>
              <th scope="col" className="amount">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {data.invoices.map((invoice, i) => (
              <tr key={i}>
                <td>{`Invoice ${invoice.number}`}</td>
                <td className="amount">{amount(invoice.amountMinor)}</td>
              </tr>
            ))}
            {data.creditMinor > 0 ? (
              <tr>
                <td>Held as prepaid credit for later invoices</td>
                <td className="amount">{amount(data.creditMinor)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
      {data.purpose === 'annual' ? (
        <p>
          This is an annual prepayment. It is held as prepaid credit, and each monthly invoice of
          the next 12 months is paid from it first.
        </p>
      ) : null}
    </Letterhead>
  );
}

export const subscriptionReceiptV1 = defineTemplate({
  key: 'subscription.receipt',
  version: 1,
  title: 'Subscription receipt',
  schema: receiptSchema,
  Component: SubscriptionReceipt,
});

// A credit note on a subscription invoice (M10 review BE-6, founder answer Q2) ------------------

const creditNoteSchema = z.strictObject({
  platformName: z.string().min(1).max(200),
  subscriberName: z.string().min(1).max(200),
  /** Gap-free: `SUBC-2026-000001`. */
  number: z.string().min(1).max(40),
  issuedOn: isoDate,
  invoiceNumber: z.string().min(1).max(40),
  netMinor: z.int().min(0),
  vatMinor: z.int().min(0),
  amountMinor: z.int().positive(),
  /** The part beyond what the invoice still owed: prepaid credit for later invoices. */
  toCreditMinor: z.int().min(0),
  reason: z.string().min(1).max(500),
});

export type SubscriptionCreditNoteDocumentData = z.infer<typeof creditNoteSchema>;

function SubscriptionCreditNote({
  data,
  branding,
}: TemplateProps<SubscriptionCreditNoteDocumentData>) {
  return (
    <Letterhead branding={branding}>
      <h1>Credit note</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Credit note number</th>
            <td>{data.number}</td>
          </tr>
          <tr>
            <th scope="row">Issued</th>
            <td>{formatBusinessDate(data.issuedOn)}</td>
          </tr>
          <tr>
            <th scope="row">To</th>
            <td>{data.subscriberName}</td>
          </tr>
          <tr>
            <th scope="row">From</th>
            <td>{data.platformName}</td>
          </tr>
          <tr>
            <th scope="row">On invoice</th>
            <td>{data.invoiceNumber}</td>
          </tr>
          <tr>
            <th scope="row">Reason</th>
            <td>{data.reason}</td>
          </tr>
        </tbody>
      </table>
      <table className="lines">
        <tbody>
          <tr>
            <td>Credited</td>
            <td className="amount">{amount(data.netMinor)}</td>
          </tr>
          {data.vatMinor > 0 ? (
            <tr>
              <td>VAT and levies credited</td>
              <td className="amount">{amount(data.vatMinor)}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">Total credited</th>
            <td className="amount">{amount(data.amountMinor)}</td>
          </tr>
        </tbody>
      </table>
      {data.toCreditMinor > 0 ? (
        <p>
          {`The invoice was already paid, so ${amount(data.toCreditMinor)} is held as prepaid credit and taken off the next invoice.`}
        </p>
      ) : null}
    </Letterhead>
  );
}

export const subscriptionCreditNoteV1 = defineTemplate({
  key: 'subscription.credit-note',
  version: 1,
  title: 'Credit note',
  schema: creditNoteSchema,
  Component: SubscriptionCreditNote,
});
