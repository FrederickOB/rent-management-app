import { describe, expect, it } from 'vitest';
import { renderHtml } from './index';
import { signingCertificateV2 } from './signing-certificate';
import { sampleBranding } from './test-fixtures';

/** M7 review data S9 (plan 4.5; LN-04): the certificate's evidence, version 2. */
const PNG = `data:image/png;base64,${Buffer.from('fake png').toString('base64')}`;
const signer = {
  role: 'Tenant',
  name: 'Kofi Tenant',
  signedAt: '2026-11-09T10:05:00.000Z',
  method: 'typed' as const,
  typedName: 'Kofi A. Tenant',
  drawingDataUri: null,
  verification: 'Code sent to +233 ** *** 0021',
  ipAddress: '203.0.113.7',
  device: 'Mozilla/5.0',
  consentVersion: 'notice_ack.v1',
  consentSha256: 'c'.repeat(64),
  documentSha256: 'a'.repeat(64),
};
const certificate = {
  subject: 'notice' as const,
  documentTitle: 'Breach of tenancy notice',
  reference: 'N-000003',
  documentSha256: 'a'.repeat(64),
  completedAt: '2026-11-09T10:05:00.000Z',
  timeZone: 'Europe/London',
  signers: [signer],
};

describe('LN-04 the signing certificate, version 2', () => {
  it('certifies acknowledged receipt of a notice, with the typed name, both clocks and the hashes', () => {
    const html = renderHtml(signingCertificateV2, certificate, sampleBranding);
    expect(html).toContain('<h1>Acknowledgement of receipt</h1>');
    expect(html).toContain('does not mean agreeing with it');
    expect(html).toContain('Acknowledged receipt');
    expect(html).not.toContain('<h1>Signing certificate</h1>');
    expect(html).toContain('Kofi A. Tenant');
    expect(html).toContain('(Europe/London)');
    expect(html).toContain('(UTC)');
    expect(html).toContain('c'.repeat(64));
    expect(html).toContain('a'.repeat(64));
  });

  it('embeds a drawn signature, and keeps the lease wording for a lease', () => {
    const html = renderHtml(
      signingCertificateV2,
      {
        ...certificate,
        subject: 'lease',
        signers: [{ ...signer, method: 'drawn', typedName: null, drawingDataUri: PNG }],
      },
      sampleBranding,
    );
    expect(html).toContain('<h1>Signing certificate</h1>');
    expect(html).toContain(`src="${PNG}"`);
    expect(html).not.toContain('Acknowledged receipt');
  });

  it('refuses a drawing that is not an embedded PNG', () => {
    expect(() =>
      renderHtml(
        signingCertificateV2,
        {
          ...certificate,
          signers: [{ ...signer, drawingDataUri: 'https://example.com/x.png' }],
        },
        sampleBranding,
      ),
    ).toThrow();
  });
});
