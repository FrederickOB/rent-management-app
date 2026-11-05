import { formatInstant, instantFrom, isValidTimeZone } from '@rent/domain/dates';
import { z } from 'zod';
import { Letterhead } from './letterhead';
import { defineTemplate, type TemplateProps } from './registry';

/**
 * The signing certificate appended to a signed document (TL-07; CLAUDE.md section 9): who signed,
 * when (server time, zone named), how they were verified, from which address and device, and the
 * fingerprint of the exact document they signed.
 */
const schema = z.strictObject({
  documentTitle: z.string().min(1).max(200),
  reference: z.string().min(1).max(60),
  /** SHA-256 of the frozen document the signers saw. */
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  completedAt: z.iso.datetime({ offset: true }),
  timeZone: z.string().refine(isValidTimeZone, 'Expected an IANA time zone such as Africa/Accra'),
  signers: z
    .array(
      z.strictObject({
        role: z.string().min(1).max(60),
        name: z.string().min(1).max(200),
        signedAt: z.iso.datetime({ offset: true }),
        method: z.enum(['typed', 'drawn']),
        /** For example "Code sent to +233 ** *** 0021". Never the full phone number or email. */
        verification: z.string().min(1).max(200),
        ipAddress: z.string().min(1).max(64),
        device: z.string().min(1).max(300),
        consentVersion: z.string().min(1).max(40),
      }),
    )
    .min(1)
    .max(20),
});

export type SigningCertificateData = z.infer<typeof schema>;

function SigningCertificate({ data, branding }: TemplateProps<SigningCertificateData>) {
  const at = (iso: string) => formatInstant(instantFrom(iso), data.timeZone);
  return (
    <Letterhead branding={branding}>
      <h1>Signing certificate</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Document</th>
            <td>{`${data.documentTitle} (reference ${data.reference})`}</td>
          </tr>
          <tr>
            <th scope="row">Document fingerprint (SHA-256)</th>
            <td className="fingerprint">{data.documentSha256}</td>
          </tr>
          <tr>
            <th scope="row">Completed</th>
            <td>{at(data.completedAt)}</td>
          </tr>
        </tbody>
      </table>
      {data.signers.map((s, i) => (
        <section key={i}>
          <h2>{`${s.role}: ${s.name}`}</h2>
          <table className="summary">
            <tbody>
              <tr>
                <th scope="row">Signed</th>
                <td>{at(s.signedAt)}</td>
              </tr>
              <tr>
                <th scope="row">Signature</th>
                <td>{s.method === 'typed' ? 'Typed name' : 'Drawn signature'}</td>
              </tr>
              <tr>
                <th scope="row">Verified by</th>
                <td>{s.verification}</td>
              </tr>
              <tr>
                <th scope="row">IP address</th>
                <td>{s.ipAddress}</td>
              </tr>
              <tr>
                <th scope="row">Device</th>
                <td>{s.device}</td>
              </tr>
              <tr>
                <th scope="row">Consent</th>
                <td>{s.consentVersion}</td>
              </tr>
            </tbody>
          </table>
        </section>
      ))}
      <p className="small">
        The fingerprint above identifies the exact document each person signed. Any change to it,
        however small, gives a different fingerprint.
      </p>
    </Letterhead>
  );
}

export const signingCertificateV1 = defineTemplate({
  key: 'esign.certificate',
  version: 1,
  title: 'Signing certificate',
  schema,
  Component: SigningCertificate,
});

/**
 * Version 2 (M7 review data S9; plan 4.5; LN-04): each signer's typed name or drawn signature,
 * every time in UTC and in the company's zone, and the hashes: the frozen document's, and for each
 * signer the document and the consent text they accepted. A notice's certificate says that
 * receipt was acknowledged, never that the notice was agreed. The finished PDF's own hash cannot
 * be printed inside it: it goes into the audit chain with the frozen document's.
 */
const schemaV2 = z.strictObject({
  subject: z.enum(['lease', 'notice']),
  documentTitle: z.string().min(1).max(200),
  reference: z.string().min(1).max(60),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  completedAt: z.iso.datetime({ offset: true }),
  timeZone: z.string().refine(isValidTimeZone, 'Expected an IANA time zone such as Africa/Accra'),
  signers: z
    .array(
      z.strictObject({
        role: z.string().min(1).max(60),
        name: z.string().min(1).max(200),
        signedAt: z.iso.datetime({ offset: true }),
        method: z.enum(['typed', 'drawn']),
        typedName: z.string().min(1).max(200).nullable(),
        /** The drawn signature as stored (PNG), embedded; null for a typed one. */
        drawingDataUri: z
          .string()
          .max(1_500_000)
          .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
          .nullable(),
        verification: z.string().min(1).max(200),
        ipAddress: z.string().min(1).max(64),
        device: z.string().min(1).max(300),
        consentVersion: z.string().min(1).max(40),
        consentSha256: z.string().regex(/^[0-9a-f]{64}$/),
        /** The hash of the document this signer saw and signed. */
        documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(20),
});

export type SigningCertificateV2Data = z.infer<typeof schemaV2>;

function SigningCertificateV2({ data, branding }: TemplateProps<SigningCertificateV2Data>) {
  const both = (iso: string) =>
    `${formatInstant(instantFrom(iso), data.timeZone)} (${formatInstant(instantFrom(iso), 'UTC')})`;
  const notice = data.subject === 'notice';
  return (
    <Letterhead branding={branding}>
      <h1>{notice ? 'Acknowledgement of receipt' : 'Signing certificate'}</h1>
      {notice ? (
        <p>
          Each person below acknowledged that they received this notice. Acknowledging receipt does
          not mean agreeing with it.
        </p>
      ) : null}
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">{notice ? 'Notice' : 'Document'}</th>
            <td>{`${data.documentTitle} (reference ${data.reference})`}</td>
          </tr>
          <tr>
            <th scope="row">Document fingerprint (SHA-256)</th>
            <td className="fingerprint">{data.documentSha256}</td>
          </tr>
          <tr>
            <th scope="row">{notice ? 'Receipt acknowledged' : 'Completed'}</th>
            <td>{both(data.completedAt)}</td>
          </tr>
        </tbody>
      </table>
      {data.signers.map((s, i) => (
        <section key={i}>
          <h2>{`${s.role}: ${s.name}`}</h2>
          <table className="summary">
            <tbody>
              <tr>
                <th scope="row">{notice ? 'Acknowledged receipt' : 'Signed'}</th>
                <td>{both(s.signedAt)}</td>
              </tr>
              <tr>
                <th scope="row">{s.method === 'typed' ? 'Typed name' : 'Drawn signature'}</th>
                <td>
                  {s.drawingDataUri ? (
                    <img
                      style={{ maxHeight: 60, maxWidth: 240 }}
                      src={s.drawingDataUri}
                      alt={`Signature drawn by ${s.name}`}
                    />
                  ) : (
                    (s.typedName ?? s.name)
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Verified by</th>
                <td>{s.verification}</td>
              </tr>
              <tr>
                <th scope="row">IP address</th>
                <td>{s.ipAddress}</td>
              </tr>
              <tr>
                <th scope="row">Device</th>
                <td>{s.device}</td>
              </tr>
              <tr>
                <th scope="row">Consent</th>
                <td>{s.consentVersion}</td>
              </tr>
              <tr>
                <th scope="row">Consent text fingerprint (SHA-256)</th>
                <td className="fingerprint">{s.consentSha256}</td>
              </tr>
              <tr>
                <th scope="row">Document seen (SHA-256)</th>
                <td className="fingerprint">{s.documentSha256}</td>
              </tr>
            </tbody>
          </table>
        </section>
      ))}
      <p className="small">
        The fingerprint above identifies the exact document each person saw. Any change to it,
        however small, gives a different fingerprint. The fingerprint of this finished document,
        with this page, is recorded in the audit log.
      </p>
    </Letterhead>
  );
}

export const signingCertificateV2 = defineTemplate({
  key: 'esign.certificate',
  version: 2,
  title: 'Signing certificate',
  schema: schemaV2,
  Component: SigningCertificateV2,
});
