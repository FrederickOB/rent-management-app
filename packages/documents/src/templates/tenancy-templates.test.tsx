import { describe, expect, it } from 'vitest';
import { TemplateRegistry, renderHtml } from './index';
import { leaseV1 } from './lease';
import { signingCertificateV1 } from './signing-certificate';
import { sampleBranding } from './test-fixtures';

const lease = {
  title: 'Residential tenancy agreement',
  reference: 'L-0001',
  sections: [
    {
      heading: 'Tenancy agreement',
      clauses: [
        { title: 'The parties', text: 'This agreement is between Ama Owner and Kofi Tenant.' },
        { title: 'Rent', text: 'The rent is GH₵1,500.00 a month.\n\nIt is billed monthly.' },
      ],
    },
  ],
  signers: [
    { role: 'Tenant', name: 'Kofi Tenant' },
    { role: 'Witness', name: 'Esi Witness' },
  ],
};

const certificate = {
  documentTitle: 'Residential tenancy agreement',
  reference: 'L-0001',
  documentSha256: 'a'.repeat(64),
  completedAt: '2026-11-02T10:15:00Z',
  timeZone: 'Africa/Accra',
  signers: [
    {
      role: 'Tenant',
      name: 'Kofi Tenant',
      signedAt: '2026-11-02T10:15:00Z',
      method: 'typed' as const,
      verification: 'Code sent to +233 ** *** 0021',
      ipAddress: '203.0.113.7',
      device: 'Mozilla/5.0 (Linux; Android 12)',
      consentVersion: 'consent.v1',
    },
  ],
};

describe('TL-07 lease document and signing certificate', () => {
  it('renders the filled clauses as plain paragraphs, and the signature block', () => {
    const html = renderHtml(leaseV1, lease, sampleBranding);
    expect(html).toContain('<h3>2. Rent</h3>');
    expect(html).toContain('<p><span>It is billed monthly.</span></p>');
    expect(html).toContain('<th scope="row">Witness</th><td>Esi Witness</td>');
  });

  it('escapes clause text, so a template can never inject markup', () => {
    const html = renderHtml(
      leaseV1,
      {
        ...lease,
        sections: [{ heading: 'X', clauses: [{ title: null, text: '<script>alert(1)</script>' }] }],
      },
      sampleBranding,
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows each signature with its time zone, verification, address, device and the fingerprint', () => {
    const html = renderHtml(signingCertificateV1, certificate, sampleBranding);
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('(Africa/Accra)');
    expect(html).toContain('Code sent to +233 ** *** 0021');
    expect(html).toContain('203.0.113.7');
  });

  it('refuses data the template does not define', () => {
    expect(() =>
      renderHtml(signingCertificateV1, { ...certificate, extra: 1 }, sampleBranding),
    ).toThrow();
    expect(() => new TemplateRegistry([leaseV1, signingCertificateV1])).not.toThrow();
  });
});
