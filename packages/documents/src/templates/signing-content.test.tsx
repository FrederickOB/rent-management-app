import { describe, expect, it } from 'vitest';
import { renderHtml, renderTemplateContent } from './index';
import { leaseV1 } from './lease';
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
  signers: [{ role: 'Tenant', name: 'Kofi Tenant' }],
};

describe('TL-05 TL-07 the signing page shows the words of the PDF', () => {
  it('renders the same content as the PDF, without the letterhead, fonts or styles', () => {
    const content = renderTemplateContent(leaseV1.key, leaseV1.version, lease, sampleBranding);
    const pdfHtml = renderHtml(leaseV1, lease, sampleBranding);
    // Every word of the content is in the PDF's HTML, in the same markup.
    expect(pdfHtml).toContain(content);
    expect(content).toContain('<h1>Residential tenancy agreement</h1>');
    expect(content).toContain('<h3>2. Rent</h3>');
    expect(content).toContain('<th scope="row">Tenant</th><td>Kofi Tenant</td>');
    // Nothing a strict, nonce-based policy would refuse, and nothing heavy.
    expect(content).not.toMatch(/\sstyle="/);
    expect(content).not.toContain('<main');
    expect(content).not.toContain('@font-face');
    expect(content).not.toContain('data:image');
    expect(content.length).toBeLessThan(10_000);
  });

  it('escapes clause text', () => {
    const content = renderTemplateContent(
      leaseV1.key,
      leaseV1.version,
      {
        ...lease,
        sections: [
          { heading: 'X', clauses: [{ title: null, text: '<main><script>alert(1)</script>' }] },
        ],
      },
      sampleBranding,
    );
    expect(content).not.toContain('<script>');
    expect(content).toContain('&lt;main&gt;&lt;script&gt;');
  });
});
