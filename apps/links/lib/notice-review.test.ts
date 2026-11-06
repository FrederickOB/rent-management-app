import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CopyScreen, Explanation } from '../app/l/[token]/screens';
import type { SigningPage } from './links-api';

// M7 review round (LT 2; data S8): after signing, a notice's ordinary link offers only what the
// API allows. The signed acknowledgement, with its certificate page (the signer's address and
// device), comes only through the signed-copy link.

const TOKEN = 'r'.repeat(43);

const signed = (downloadable: boolean): SigningPage => ({
  screen: 'signed',
  reason: null,
  subject: 'notice',
  canDecline: false,
  notice: {
    number: 'N-000007',
    type: 'entry',
    typeLabel: 'Notice of entry',
    issuedAt: '2026-11-04T09:00:00.000Z',
    effectiveDate: null,
    statement: NOTICE_SIGNING_STATEMENT,
    supersededBy: null,
    acknowledgedByAnother: false,
  },
  purpose: 'sign',
  landlord: { name: 'Osu Ridge', contactName: null, phone: null, email: null },
  timeZone: 'Africa/Accra',
  linkExpiresAt: '2026-12-04T09:00:00.000Z',
  document: {
    title: 'Notice',
    reference: 'N-000007',
    sha256: 'a'.repeat(64),
    finalSha256: 'b'.repeat(64),
    html: null,
    downloadable,
  },
  signer: {
    name: 'Abena',
    role: 'tenant',
    roleLabel: 'Tenant',
    status: 'signed',
    signedAt: '2026-11-04T09:10:00.000Z',
    declinedAt: null,
  },
  signers: [],
  code: null,
  consent: null,
});

describe('LN-04 after signing, a notice’s link offers only what the API allows', () => {
  it('no download when the API says the link may not download', () => {
    const html = renderToStaticMarkup(
      createElement(Explanation, { token: TOKEN, page: signed(false), done: 'signed' }),
    );
    expect(html).toContain('Thank you: you have acknowledged receipt');
    expect(html).not.toContain(`/l/${TOKEN}/document`);
    expect(html).not.toContain('b'.repeat(64));
  });

  it('the notice itself, never the acknowledgement, when it may', () => {
    const html = renderToStaticMarkup(
      createElement(Explanation, { token: TOKEN, page: signed(true) }),
    );
    expect(html).toContain('Download the notice (PDF)');
    expect(html).not.toMatch(/acknowledgement \(PDF\)|certificate/i);
    expect(html).not.toContain('b'.repeat(64));
  });

  it('the signed acknowledgement only on the signed-copy link', () => {
    const copy = { ...signed(true), screen: 'copy' as const, purpose: 'signed_copy' as const };
    const html = renderToStaticMarkup(createElement(CopyScreen, { token: TOKEN, page: copy }));
    expect(html).toContain('Download the signed acknowledgement (PDF)');
    expect(html).toContain('b'.repeat(64));
  });
});
