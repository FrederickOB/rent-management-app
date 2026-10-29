import { formatInstant, instantFrom, isValidTimeZone } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { z } from 'zod';
import { Letterhead } from './letterhead';
import { defineTemplate, type TemplateProps } from './registry';

const schema = z.strictObject({
  title: z.string().min(1).max(200),
  recipientName: z.string().min(1).max(200),
  reference: z.string().min(1).max(60),
  /** Integer minor units (pesewas), as everywhere in the product (CLAUDE.md section 4). */
  amountMinor: z.int(),
  currency: z.literal('GHS'),
  /** An instant, shown in `timeZone` with the zone named (DO-04). */
  issuedAt: z.iso.datetime({ offset: true }),
  timeZone: z.string().refine(isValidTimeZone, 'Expected an IANA time zone such as Africa/Accra'),
});

export type SystemSampleData = z.infer<typeof schema>;

function SystemSample({ data, branding }: TemplateProps<SystemSampleData>) {
  return (
    <Letterhead branding={branding}>
      <h1>{data.title}</h1>
      <p>{`Prepared for ${data.recipientName}`}</p>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Reference</th>
            <td>{data.reference}</td>
          </tr>
          <tr>
            <th scope="row">Amount</th>
            <td className="amount">{format(money(data.amountMinor, data.currency))}</td>
          </tr>
          <tr>
            <th scope="row">Issued</th>
            <td>{formatInstant(instantFrom(data.issuedAt), data.timeZone)}</td>
          </tr>
        </tbody>
      </table>
      <p className="small">A sample document for testing the renderer. It has no legal effect.</p>
    </Letterhead>
  );
}

/** The M1 sample, for the renderer tests (docs/plans/M1.md section 4.13). */
export const systemSampleV1 = defineTemplate({
  key: 'system.sample',
  version: 1,
  title: 'Sample document',
  schema,
  Component: SystemSample,
});
