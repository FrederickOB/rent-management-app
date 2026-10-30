import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../fingerprint';
import { PdfRenderer } from '../render';
import { leaseV1, renderHtml, signingCertificateV1 } from '../templates';
import { sampleBranding } from '../templates/test-fixtures';
import { appendPdfPages, startsWith } from './append';

async function pdfText(pdf: Uint8Array): Promise<{ pages: number; text: string }> {
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false });
  const doc = await task.promise;
  try {
    const text: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const content = await (await doc.getPage(n)).getTextContent();
      for (const item of content.items) if ('str' in item) text.push(item.str);
    }
    // Without spaces: text extraction splits ligatures such as "fi" into items of their own.
    return { pages: doc.numPages, text: text.join('').replace(/\s+/g, '') };
  } finally {
    await task.destroy();
  }
}

let renderer: PdfRenderer;

beforeAll(async () => {
  renderer = await PdfRenderer.launch({ poolSize: 1 });
});

afterAll(async () => {
  await renderer?.close();
});

describe('TL-07 signed copy from Chromium PDFs', () => {
  it('appends the rendered certificate to the rendered lease, keeping the lease bytes intact', async () => {
    const lease = await renderer.render(
      renderHtml(
        leaseV1,
        {
          title: 'Residential tenancy agreement',
          reference: 'L-0001',
          sections: [
            { heading: 'Tenancy agreement', clauses: [{ title: 'Rent', text: 'GH₵1,500.00' }] },
          ],
          signers: [{ role: 'Tenant', name: 'Kofi Tenant' }],
        },
        sampleBranding,
      ),
    );
    const certificate = await renderer.render(
      renderHtml(
        signingCertificateV1,
        {
          documentTitle: 'Residential tenancy agreement',
          reference: 'L-0001',
          documentSha256: sha256Hex(lease),
          completedAt: '2026-11-02T10:15:00Z',
          timeZone: 'Africa/Accra',
          signers: [
            {
              role: 'Tenant',
              name: 'Kofi Tenant',
              signedAt: '2026-11-02T10:15:00Z',
              method: 'typed',
              verification: 'One-time code sent by SMS to +233 ** *** 0021',
              ipAddress: '203.0.113.7',
              device: 'Mozilla/5.0 (Linux; Android 12)',
              consentVersion: 'consent.v1',
            },
          ],
        },
        sampleBranding,
      ),
    );
    const signed = await appendPdfPages(lease, certificate);
    expect(startsWith(signed, lease)).toBe(true);
    const before = await pdfText(lease);
    const after = await pdfText(signed);
    expect(after.pages).toBe(before.pages + (await pdfText(certificate)).pages);
    for (const words of [
      'Residential tenancy agreement',
      'Signing certificate',
      sha256Hex(lease),
      '203.0.113.7',
      'Mozilla/5.0 (Linux; Android 12)',
      '2 Nov 2026, 10:15 GMT (Africa/Accra)',
    ])
      expect(after.text).toContain(words.replace(/\s+/g, ''));
  });
});
