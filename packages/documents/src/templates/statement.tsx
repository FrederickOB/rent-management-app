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
 * A tenant's account statement for one lease (M6 decision 11; CM-03): invoices, payments and
 * credits for the last 12 months or since the lease began, with the balance and paid-until.
 * Amounts are integer pesewas, formatted only here at the edge; every figure is the billing
 * records' own. The bot sends it as a PDF in the chat.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const statementSchema = z.strictObject({
  generatedAt: z.string().datetime(),
  timeZone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
  from: isoDate,
  to: isoDate,
  tenant: z.strictObject({ name: z.string().min(1).max(200) }),
  landlord: z.strictObject({ name: z.string().min(1).max(200) }),
  unit: z.strictObject({
    code: z.string().min(1).max(40),
    propertyName: z.string().min(1).max(200),
  }),
  lines: z
    .array(
      z.strictObject({
        date: isoDate,
        kind: z.enum(['invoice', 'payment', 'credit']),
        reference: z.string().min(1).max(40),
        description: z.string().min(1).max(200),
        /** Positive: charged; negative: paid or credited. */
        amountMinor: z.int(),
      }),
    )
    .max(500),
  dueNowMinor: z.int(),
  creditMinor: z.int(),
  paidUntil: isoDate.nullable(),
  nextDueDate: isoDate.nullable(),
});

export type StatementDocumentData = z.infer<typeof statementSchema>;

const amount = (minor: number) => format(money(minor));

function Statement({ data, branding }: TemplateProps<StatementDocumentData>) {
  return (
    <Letterhead branding={branding}>
      <h1>Account statement</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Tenant</th>
            <td>{data.tenant.name}</td>
          </tr>
          <tr>
            <th scope="row">Landlord</th>
            <td>{data.landlord.name}</td>
          </tr>
          <tr>
            <th scope="row">Unit</th>
            <td>{`${data.unit.code}, ${data.unit.propertyName}`}</td>
          </tr>
          <tr>
            <th scope="row">Period</th>
            <td>{`${formatBusinessDate(data.from)} to ${formatBusinessDate(data.to)}`}</td>
          </tr>
          <tr>
            <th scope="row">Prepared</th>
            <td>{formatInstant(instantFrom(data.generatedAt), data.timeZone)}</td>
          </tr>
        </tbody>
      </table>
      <table className="lines">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Reference</th>
            <th scope="col">Description</th>
            <th scope="col" className="amount">
              Charged
            </th>
            <th scope="col" className="amount">
              Paid or credited
            </th>
          </tr>
        </thead>
        <tbody>
          {data.lines.length === 0 ? (
            <tr>
              <td colSpan={5}>Nothing in this period.</td>
            </tr>
          ) : (
            data.lines.map((l, i) => (
              <tr key={i}>
                <td>{formatBusinessDate(l.date)}</td>
                <td>{l.reference}</td>
                <td>{l.description}</td>
                <td className="amount">{l.amountMinor > 0 ? amount(l.amountMinor) : ''}</td>
                <td className="amount">{l.amountMinor < 0 ? amount(-l.amountMinor) : ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p>
        {data.dueNowMinor > 0 ? `Due now: ${amount(data.dueNowMinor)}.` : 'Nothing is due now.'}
      </p>
      {data.creditMinor > 0 ? (
        <p>{`Held as credit for later months: ${amount(data.creditMinor)}.`}</p>
      ) : null}
      {data.paidUntil ? <p>{`Rent is paid until ${formatBusinessDate(data.paidUntil)}.`}</p> : null}
      {data.nextDueDate ? (
        <p>{`The next rent is due on ${formatBusinessDate(data.nextDueDate)}.`}</p>
      ) : null}
    </Letterhead>
  );
}

export const statementV1 = defineTemplate({
  key: 'tenancy.statement',
  version: 1,
  title: 'Account statement',
  schema: statementSchema,
  Component: Statement,
});
