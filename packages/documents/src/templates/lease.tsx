import { z } from 'zod';
import { Letterhead } from './letterhead';
import { defineTemplate, type TemplateProps } from './registry';

/**
 * A lease, frozen (TL-05, TL-07; ADR-006). The data snapshot holds the clauses already filled
 * from the lease's terms, so the PDF and the signing page show exactly the same words, and the
 * template version plus the snapshot reproduce the document.
 */
const clause = z.strictObject({
  title: z.string().max(200).nullable(),
  /** Plain text: paragraphs separated by blank lines. */
  text: z.string().max(12_000),
});

const schema = z.strictObject({
  title: z.string().min(1).max(200),
  /** A short reference printed on every page, such as the lease's id. */
  reference: z.string().min(1).max(60),
  sections: z
    .array(
      z.strictObject({ heading: z.string().min(1).max(200), clauses: z.array(clause).max(200) }),
    )
    .min(1)
    .max(50),
  /** Who signs, in order, for the signature block. */
  signers: z
    .array(z.strictObject({ role: z.string().min(1).max(60), name: z.string().min(1).max(200) }))
    .min(1)
    .max(20),
});

export type LeaseDocumentData = z.infer<typeof schema>;

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p, i) => (
          <p key={i}>
            {p.split('\n').map((line, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                {line}
              </span>
            ))}
          </p>
        ))}
    </>
  );
}

function Lease({ data, branding }: TemplateProps<LeaseDocumentData>) {
  return (
    <Letterhead branding={branding}>
      <h1>{data.title}</h1>
      <p className="small">{`Reference ${data.reference}`}</p>
      {data.sections.map((section, s) => (
        <section key={s}>
          <h2>{section.heading}</h2>
          {section.clauses.map((c, i) => (
            <div key={i} className="clause">
              {c.title ? <h3>{`${i + 1}. ${c.title}`}</h3> : null}
              <Paragraphs text={c.text} />
            </div>
          ))}
        </section>
      ))}
      <h2>Signatures</h2>
      <table className="summary">
        <tbody>
          {data.signers.map((signer, i) => (
            <tr key={i}>
              <th scope="row">{signer.role}</th>
              <td>{signer.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        Signed electronically. The signing certificate at the end of the signed copy records each
        signature and this document’s fingerprint.
      </p>
    </Letterhead>
  );
}

export const leaseV1 = defineTemplate({
  key: 'tenancy.lease',
  version: 1,
  title: 'Lease',
  schema,
  Component: Lease,
});
