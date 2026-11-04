import { z } from 'zod';
import { Letterhead } from './letterhead';
import { defineTemplate, type TemplateProps } from './registry';

/**
 * A legal notice, frozen (LN-01, LN-04; M7 plan 4.5, decision 1; ADR-006). The data snapshot holds
 * every word already filled from the notice's own facts, so the PDF, the signing page and the
 * service pack show the same notice, and the template version plus the snapshot reproduce it.
 * Every legal sentence is counsel's; until counsel supplies it, the snapshot carries the
 * placeholder "Wording to be supplied by your lawyer." and says whether counsel reviewed it.
 */
const line = z.strictObject({ label: z.string().min(1).max(120), value: z.string().max(4000) });

const schema = z.strictObject({
  /** For example "Notice to quit". */
  title: z.string().min(1).max(200),
  /** The notice number, N-000001, printed on every page. */
  reference: z.string().min(1).max(60),
  landlordName: z.string().min(1).max(200),
  /** The issue date, as words (4 November 2026). */
  issuedOn: z.string().min(1).max(60),
  propertyName: z.string().min(1).max(200),
  /** The unit, or the blocks, for a building-wide notice. */
  premises: z.string().max(400),
  /** Who it is addressed to. */
  recipients: z.array(z.string().min(1).max(200)).min(1).max(500),
  /** The notice's facts: its kind, dates, amounts and particulars, as staff entered them. */
  facts: z.array(line).max(40),
  /** The legal wording, section by section; counsel's placeholder until supplied. */
  sections: z
    .array(z.strictObject({ heading: z.string().min(1).max(200), text: z.string().max(12_000) }))
    .max(20),
  /** The notice this one corrects and replaces (plan 4.8). */
  replaces: z.string().max(60).nullable(),
  /** Decision 1: whether counsel has reviewed this template version's wording. */
  counselReviewed: z.boolean(),
  /** Signing acknowledges receipt, not agreement (CLAUDE.md section 9). */
  acknowledgement: z.string().min(1).max(600),
});

export type NoticeDocumentData = z.infer<typeof schema>;

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
    </>
  );
}

function Notice({ data, branding }: TemplateProps<NoticeDocumentData>) {
  return (
    <Letterhead branding={branding}>
      <h1>{data.title}</h1>
      <p className="small">{`Notice ${data.reference} · Issued ${data.issuedOn}`}</p>
      {data.replaces ? <p>{`This notice corrects and replaces notice ${data.replaces}.`}</p> : null}
      {data.counselReviewed ? null : (
        <p className="small">The wording of this notice has not yet been reviewed by a lawyer.</p>
      )}
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">From</th>
            <td>{data.landlordName}</td>
          </tr>
          <tr>
            <th scope="row">To</th>
            <td>{data.recipients.join(', ')}</td>
          </tr>
          <tr>
            <th scope="row">Premises</th>
            <td>{data.premises ? `${data.propertyName}, ${data.premises}` : data.propertyName}</td>
          </tr>
          {data.facts.map((f, i) => (
            <tr key={i}>
              <th scope="row">{f.label}</th>
              <td>{f.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.sections.map((section, i) => (
        <section key={i}>
          <h2>{section.heading}</h2>
          <Paragraphs text={section.text} />
        </section>
      ))}
      <p className="small">{data.acknowledgement}</p>
    </Letterhead>
  );
}

export const noticeV1 = defineTemplate({
  key: 'notices.notice',
  version: 1,
  title: 'Notice',
  schema,
  Component: Notice,
});

/**
 * The physical service pack (LN-05; plan 4.7): a cover sheet and a service affidavit with the
 * notice's details filled in. The frozen notice is appended to it as it is. The affidavit's
 * wording is counsel's (OQ-10): the placeholder until then, with blanks for the server to fill.
 */
const packSchema = z.strictObject({
  title: z.string().min(1).max(200),
  reference: z.string().min(1).max(60),
  landlordName: z.string().min(1).max(200),
  issuedOn: z.string().min(1).max(60),
  propertyName: z.string().min(1).max(200),
  premises: z.string().max(400),
  /** Each person to serve, with their unit. */
  recipients: z
    .array(z.strictObject({ name: z.string().min(1).max(200), premises: z.string().max(200) }))
    .min(1)
    .max(500),
  /** SHA-256 of the frozen notice that follows. */
  noticeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  instructions: z.array(z.string().min(1).max(600)).max(10),
  affidavit: z.strictObject({
    heading: z.string().min(1).max(200),
    text: z.string().max(4000),
    /** The blanks the server fills in by hand. */
    blanks: z.array(z.string().min(1).max(120)).max(20),
  }),
});

export type ServicePackData = z.infer<typeof packSchema>;

function ServicePack({ data, branding }: TemplateProps<ServicePackData>) {
  return (
    <Letterhead branding={branding}>
      <h1>{`Service pack: ${data.title}`}</h1>
      <p className="small">{`Notice ${data.reference} · Issued ${data.issuedOn}`}</p>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">From</th>
            <td>{data.landlordName}</td>
          </tr>
          <tr>
            <th scope="row">Premises</th>
            <td>{data.premises ? `${data.propertyName}, ${data.premises}` : data.propertyName}</td>
          </tr>
          <tr>
            <th scope="row">Notice fingerprint (SHA-256)</th>
            <td className="fingerprint">{data.noticeSha256}</td>
          </tr>
        </tbody>
      </table>
      <h2>To serve</h2>
      <table className="summary">
        <tbody>
          {data.recipients.map((r, i) => (
            <tr key={i}>
              <th scope="row">{r.name}</th>
              <td>{r.premises}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>How to serve it</h2>
      {data.instructions.map((text, i) => (
        <p key={i}>{text}</p>
      ))}
      <section>
        <h2>{data.affidavit.heading}</h2>
        <Paragraphs text={data.affidavit.text} />
        <table className="summary">
          <tbody>
            {data.affidavit.blanks.map((label, i) => (
              <tr key={i}>
                <th scope="row">{label}</th>
                <td>{'_______________________________'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="small">The notice to be served follows on the next pages, as it was issued.</p>
    </Letterhead>
  );
}

export const servicePackV1 = defineTemplate({
  key: 'notices.service-pack',
  version: 1,
  title: 'Service pack',
  schema: packSchema,
  Component: ServicePack,
});
