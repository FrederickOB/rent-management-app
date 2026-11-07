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
 * The move-in report and the final statement (M8 plan 4.7 and 4.8). Amounts are integer pesewas,
 * formatted only here; dates are business dates in the company's time zone. Photos are named by
 * document id and fingerprint: the renderer supplies their thumbnails (branding.images) from
 * storage, and the full photos stay linked by fingerprint.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const photo = z.strictObject({
  documentId: z.string().uuid(),
  sha256,
  takenAt: z.string().datetime(),
});
const CONDITION_LABELS: Record<string, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
  missing: 'Missing',
  not_applicable: 'Not applicable',
};

const moveInReportSchema = z.strictObject({
  /** What the signing page and messages call it, and its reference (the unit code). */
  title: z.string().min(1).max(200),
  reference: z.string().min(1).max(60),
  inspectionId: z.string().uuid(),
  submittedAt: z.string().datetime(),
  timeZone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
  landlord: z.strictObject({ name: z.string().min(1).max(200) }),
  tenant: z.strictObject({ name: z.string().min(1).max(200) }),
  unit: z.strictObject({
    code: z.string().min(1).max(40),
    propertyName: z.string().min(1).max(200),
  }),
  leaseStart: isoDate,
  inspectedBy: z.string().max(200).nullable(),
  items: z
    .array(
      z.strictObject({
        roomLabel: z.string().min(1).max(80),
        itemLabel: z.string().min(1).max(80),
        condition: z.enum(['good', 'fair', 'poor', 'damaged', 'missing', 'not_applicable']),
        note: z.string().max(1000).nullable(),
        photos: z.array(photo).max(20),
      }),
    )
    .min(1)
    .max(600),
});
export type MoveInReportDocumentData = z.infer<typeof moveInReportSchema>;

function MoveInReport({ data, branding }: TemplateProps<MoveInReportDocumentData>) {
  const rooms = [...new Set(data.items.map((i) => i.roomLabel))];
  return (
    <Letterhead branding={branding}>
      <h1>Move-in report</h1>
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
            <th scope="row">Lease starts</th>
            <td>{formatBusinessDate(data.leaseStart)}</td>
          </tr>
          <tr>
            <th scope="row">Inspected</th>
            <td>
              {`${formatInstant(instantFrom(data.submittedAt), data.timeZone)}${data.inspectedBy ? ` by ${data.inspectedBy}` : ''}`}
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Every party signs this report to agree the condition of the unit when the tenancy began. It
        is compared with the move-out inspection when the tenancy ends.
      </p>
      {rooms.map((room) => (
        <section key={room}>
          <h2>{room}</h2>
          <table className="lines">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Condition</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {data.items
                .filter((i) => i.roomLabel === room)
                .map((i, n) => (
                  <tr key={n}>
                    <td>{i.itemLabel}</td>
                    <td>{CONDITION_LABELS[i.condition]}</td>
                    <td>
                      {i.note ?? ''}
                      {i.photos.length > 0 ? (
                        <div>
                          {i.photos.map((p) =>
                            branding.images?.[p.documentId] ? (
                              <img
                                key={p.documentId}
                                src={branding.images[p.documentId]}
                                alt={`${i.itemLabel}, photo taken ${formatInstant(instantFrom(p.takenAt), data.timeZone)}`}
                                width={160}
                              />
                            ) : (
                              <span key={p.documentId}>{`Photo ${p.sha256.slice(0, 12)}`}</span>
                            ),
                          )}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
      <p>
        {`Photos are shown as thumbnails. Each full photo is kept unchanged and identified by its SHA-256 fingerprint.`}
      </p>
    </Letterhead>
  );
}

export const moveInReportV1 = defineTemplate({
  key: 'inspection.move-in',
  version: 1,
  title: 'Move-in report',
  schema: moveInReportSchema,
  Component: MoveInReport,
});

const lineAmount = z.strictObject({
  label: z.string().min(1).max(200),
  amountMinor: z.int(),
});

const finalStatementSchema = z.strictObject({
  /** The move-out it settles, so the rendered PDF finds its way back to it. */
  moveOutId: z.string().uuid(),
  generatedOn: isoDate,
  timeZone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
  landlord: z.strictObject({ name: z.string().min(1).max(200) }),
  tenant: z.strictObject({ name: z.string().min(1).max(200) }),
  unit: z.strictObject({
    code: z.string().min(1).max(40),
    propertyName: z.string().min(1).max(200),
  }),
  lastDay: isoDate,
  early: z.boolean(),
  depositHeldMinor: z.int(),
  creditMinor: z.int(),
  arrearsMinor: z.int(),
  chargesMinor: z.int(),
  breakCreditMinor: z.int(),
  creditToArrears: z.array(lineAmount).max(200),
  depositToArrears: z.array(lineAmount).max(200),
  deductions: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(200),
        reason: z.string().max(500),
        amountMinor: z.int(),
      }),
    )
    .max(50),
  retainedMinor: z.int(),
  deductionsChargedMinor: z.int(),
  creditRefundMinor: z.int(),
  depositRefundMinor: z.int(),
  refundMinor: z.int(),
  stillOwedMinor: z.int(),
});
export type FinalStatementDocumentData = z.infer<typeof finalStatementSchema>;

const amount = (minor: number) => format(money(minor));

function FinalStatement({ data, branding }: TemplateProps<FinalStatementDocumentData>) {
  const row = (label: string, minor: number) => (
    <tr>
      <th scope="row">{label}</th>
      <td className="amount">{amount(minor)}</td>
    </tr>
  );
  return (
    <Letterhead branding={branding}>
      <h1>Final statement</h1>
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
            <th scope="row">Last day of the tenancy</th>
            <td>{`${formatBusinessDate(data.lastDay)}${data.early ? ' (ended early)' : ''}`}</td>
          </tr>
          <tr>
            <th scope="row">Prepared</th>
            <td>{formatBusinessDate(data.generatedOn)}</td>
          </tr>
        </tbody>
      </table>
      <h2>What was held and owed</h2>
      <table className="lines">
        <tbody>
          {row('Deposit held', data.depositHeldMinor)}
          {row('Rent paid ahead (credit)', data.creditMinor)}
          {row('Unpaid rent and charges', data.arrearsMinor)}
          {data.chargesMinor > 0 ? row('Agreed charges', data.chargesMinor) : null}
          {data.breakCreditMinor > 0
            ? row('Credit for unused days (break clause)', data.breakCreditMinor)
            : null}
        </tbody>
      </table>
      {data.creditToArrears.length + data.depositToArrears.length > 0 ? (
        <>
          <h2>How unpaid rent and charges were settled</h2>
          <table className="lines">
            <tbody>
              {data.creditToArrears.map((l, i) => (
                <tr key={`c${i}`}>
                  <td>{`${l.label}: from credit`}</td>
                  <td className="amount">{amount(l.amountMinor)}</td>
                </tr>
              ))}
              {data.depositToArrears.map((l, i) => (
                <tr key={`d${i}`}>
                  <td>{`${l.label}: from the deposit`}</td>
                  <td className="amount">{amount(l.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {data.deductions.length > 0 ? (
        <>
          <h2>Deductions from the deposit</h2>
          <table className="lines">
            <tbody>
              {data.deductions.map((d, i) => (
                <tr key={i}>
                  <td>{`${d.label}: ${d.reason}`}</td>
                  <td className="amount">{amount(d.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>{`Kept from the deposit: ${amount(data.retainedMinor)}.`}</p>
          {data.deductionsChargedMinor > 0 ? (
            <p>{`Deductions the deposit could not cover, charged to the tenant: ${amount(data.deductionsChargedMinor)}.`}</p>
          ) : null}
        </>
      ) : null}
      <h2>The result</h2>
      <table className="lines">
        <tbody>
          {row('Credit refunded', data.creditRefundMinor)}
          {row('Deposit refunded', data.depositRefundMinor)}
          {row('Total refund to the tenant', data.refundMinor)}
          {row('Still owed by the tenant', data.stillOwedMinor)}
        </tbody>
      </table>
    </Letterhead>
  );
}

export const finalStatementV1 = defineTemplate({
  key: 'tenancy.final-statement',
  version: 1,
  title: 'Final statement',
  schema: finalStatementSchema,
  Component: FinalStatement,
});
