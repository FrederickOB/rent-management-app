import {
  CURRENT_NOTICE_CONSENT,
  NOTICE_SIGNING_STATEMENT,
  SIGNING_CONSENT,
} from '@rent/domain/esign';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as decline } from '../app/l/[token]/decline/route';
import { CopyScreen, Explanation, NoticeReadOnly, SignScreen } from '../app/l/[token]/screens';
import type { SigningPage } from './links-api';
import { canDecline, declineProblem, readOnlyBanner, readOnlyReason } from './notice';
import { problemText } from './problems';

// M7 plan 4.5 and 4.8 (LN-02, LN-04; CLAUDE.md section 9): a notice's signing page.

const TOKEN = 'n'.repeat(43);
const ISSUED = '2026-11-04T09:00:00.000Z';

function page(overrides: Partial<SigningPage> = {}): SigningPage {
  return {
    screen: 'sign',
    reason: null,
    subject: 'notice',
    canDecline: false,
    notice: {
      number: 'N-000007',
      type: 'entry',
      typeLabel: 'Notice of entry',
      issuedAt: ISSUED,
      effectiveDate: '2026-11-20',
      statement: NOTICE_SIGNING_STATEMENT,
      supersededBy: null,
      acknowledgedByAnother: false,
    },
    purpose: 'sign',
    landlord: {
      name: 'Osu Ridge Property Managers',
      contactName: 'Kofi Manager',
      phone: '+233302000000',
      email: 'office@example.test',
    },
    timeZone: 'Africa/Accra',
    linkExpiresAt: '2026-12-04T09:00:00.000Z',
    document: {
      title: 'Notice of entry N-000007',
      reference: 'N-000007',
      sha256: 'a'.repeat(64),
      finalSha256: null,
      html: '<h1>Notice of entry</h1><p>We will inspect the flat on 20 November 2026.</p>',
      downloadable: true,
    },
    signer: {
      name: 'Abena Mensah',
      role: 'tenant',
      roleLabel: 'Tenant',
      status: 'pending',
      signedAt: null,
      declinedAt: null,
    },
    signers: [{ name: 'Abena Mensah', roleLabel: 'Tenant', status: 'pending', required: true }],
    code: {
      channel: 'sms',
      destinationMasked: '+233 24 *** **56',
      sentAt: '2026-11-04T09:05:00.000Z',
      expiresAt: '2026-11-04T09:15:00.000Z',
      attemptsLeft: 5,
      sendsLeft: 2,
      lockedUntil: null,
    },
    consent: { version: CURRENT_NOTICE_CONSENT, text: SIGNING_CONSENT[CURRENT_NOTICE_CONSENT]! },
    ...overrides,
  };
}

const lease = (): SigningPage =>
  page({
    subject: 'lease',
    canDecline: true,
    notice: null,
    consent: { version: 'consent.v1', text: SIGNING_CONSENT['consent.v1']! },
    document: { ...page().document, title: 'Tenancy agreement: ACC-ELG-B1-07', reference: 'L-1' },
  });

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const signScreen = (p: SigningPage, query: Record<string, string> = {}) =>
  renderToStaticMarkup(createElement(SignScreen, { token: TOKEN, page: p, query }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LN-04 a notice’s signing page acknowledges receipt, not agreement', () => {
  it('names the notice, and states above the signature box that signing acknowledges receipt', () => {
    const html = signScreen(page());
    const text = textOf(html);
    expect(text).toContain('Notice N-000007: Notice of entry');
    expect(text).toContain('Notice N-000007 Type Notice of entry');
    expect(text).toContain('Issued 4 Nov 2026, 09:00 (Africa/Accra)');
    expect(text).toContain('Effective date 20 November 2026');
    expect(text).toContain('Acknowledge receipt');
    // The statement comes before the code box, the signature and the button.
    const statement = text.indexOf(NOTICE_SIGNING_STATEMENT);
    expect(statement).toBeGreaterThan(-1);
    expect(statement).toBeLessThan(text.indexOf('Your 6-digit code'));
    expect(statement).toBeLessThan(text.indexOf('Type your full name to sign'));
    expect(text).toContain('Sign to acknowledge receipt');
    // The notice's own consent, sent by the API.
    expect(html).toContain(`name="consentVersion" value="${CURRENT_NOTICE_CONSENT}"`);
    expect(text).toContain('it does not mean that I agree with the notice');
  });

  it('offers no way to decline, even when the address asks for it', () => {
    const queries: Record<string, string>[] = [{}, { step: 'decline' }];
    for (const query of queries) {
      const html = signScreen(page(), query);
      expect(html).not.toContain('/decline');
      expect(textOf(html)).not.toMatch(/I do not want to sign|Decline to sign/);
      expect(html).not.toContain('name="reason"');
      // The page still signs.
      expect(html).toContain(`action="/l/${TOKEN}/sign"`);
    }
    expect(canDecline(page())).toBe(false);
    expect(canDecline(page({ canDecline: true }))).toBe(false);
    expect(canDecline(page({ subject: undefined }))).toBe(false);
  });

  it('a lease keeps its page as it was: decline offered, no notice statement', () => {
    const html = signScreen(lease());
    expect(html).toContain('I do not want to sign');
    expect(textOf(html)).not.toContain(NOTICE_SIGNING_STATEMENT);
    expect(textOf(html)).toMatch(/asks you, Abena Mensah, to sign this document as tenant/);
    expect(canDecline(lease())).toBe(true);
    expect(canDecline({ ...lease(), canDecline: false })).toBe(false);
  });

  it('says when another signatory has already acknowledged for the company (LN-07)', () => {
    const notice = { ...page().notice!, acknowledgedByAnother: true };
    expect(textOf(signScreen(page({ notice })))).toContain(
      'Someone else has already acknowledged this notice for your company.',
    );
    const closed = renderToStaticMarkup(
      createElement(Explanation, {
        token: TOKEN,
        page: page({ screen: 'closed', reason: 'signed_by_all', notice, code: null }),
      }),
    );
    expect(textOf(closed)).toContain(
      'Someone else has already acknowledged notice N-000007 for your company.',
    );
  });

  it('after signing: acknowledged receipt, with the notice to download', () => {
    const signed = page({
      screen: 'signed',
      code: null,
      signer: { ...page().signer, status: 'signed', signedAt: '2026-11-04T09:10:00.000Z' },
    });
    const html = renderToStaticMarkup(
      createElement(Explanation, { token: TOKEN, page: signed, done: 'signed' }),
    );
    const text = textOf(html);
    expect(text).toContain('Thank you: you have acknowledged receipt');
    expect(text).toContain(
      'You acknowledged notice N-000007 on 4 Nov 2026, 09:10 (Africa/Accra). This confirms that you received it, not that you agree with it.',
    );
    expect(html).toContain(`href="/l/${TOKEN}/document"`);
    expect(text).not.toMatch(/signed copy|everyone has signed/i);
  });

  it('the signed acknowledgement, once ready', () => {
    const copy = page({
      screen: 'copy',
      purpose: 'signed_copy',
      document: { ...page().document, finalSha256: 'b'.repeat(64), html: null },
    });
    const text = textOf(
      renderToStaticMarkup(createElement(CopyScreen, { token: TOKEN, page: copy })),
    );
    expect(text).toContain('Your signed acknowledgement is ready');
    expect(text).toContain('not that you agree with it');
    expect(text).toContain('b'.repeat(64));
  });

  it('an expired notice link names the notice and who to ask, and offers no download', () => {
    const html = renderToStaticMarkup(
      createElement(Explanation, {
        token: TOKEN,
        page: page({
          screen: 'expired',
          code: null,
          document: { ...page().document, downloadable: false },
        }),
      }),
    );
    expect(textOf(html)).toContain(
      'Links to a notice work until its notice period ends. Ask Osu Ridge Property Managers for a copy of notice N-000007.',
    );
    expect(html).not.toContain('/document');
  });
});

describe('LN-02 a corrected or closed notice opens read-only (plan 4.8)', () => {
  const superseded = () =>
    page({
      screen: 'closed',
      reason: 'notice_superseded',
      code: null,
      consent: null,
      notice: { ...page().notice!, supersededBy: { number: 'N-000009' } },
    });

  it('a superseded notice: a banner naming the new notice, the notice itself, its PDF, no signing', () => {
    expect(readOnlyReason(superseded())).toBe('superseded');
    const html = renderToStaticMarkup(
      createElement(NoticeReadOnly, { token: TOKEN, page: superseded() }),
    );
    const text = textOf(html);
    expect(text).toContain('Notice N-000007: Notice of entry');
    expect(text).toContain(
      'This notice has been replaced by notice N-000009. Osu Ridge Property Managers sends you the new notice with a link of its own. You can still read and download this one.',
    );
    expect(text).toContain('We will inspect the flat on 20 November 2026.');
    expect(html).toContain(`href="/l/${TOKEN}/document"`);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('/decline');
  });

  it('a closed notice: its banner, still downloadable', () => {
    const closed = page({ screen: 'closed', reason: 'notice_closed', code: null, consent: null });
    expect(readOnlyReason(closed)).toBe('closed');
    expect(readOnlyBanner(closed)).toBe(
      'Osu Ridge Property Managers has closed this notice. You can still read and download it here.',
    );
    const html = renderToStaticMarkup(
      createElement(NoticeReadOnly, { token: TOKEN, page: closed }),
    );
    expect(html).toContain(`href="/l/${TOKEN}/document"`);
    expect(html).not.toContain('<form');
  });

  it('is read-only whatever screen the link reports, and a live or lease link is not', () => {
    expect(readOnlyReason({ ...superseded(), screen: 'sign' })).toBe('superseded');
    expect(readOnlyReason(page())).toBeNull();
    expect(readOnlyReason({ ...lease(), reason: 'notice_closed' })).toBeNull();
    expect(
      readOnlyBanner({ ...superseded(), notice: { ...superseded().notice!, supersededBy: null } }),
    ).toMatch(/^This notice has been replaced by a later notice\./);
  });
});

describe('LN-02 a notice cannot be declined', () => {
  it('the decline route answers the API’s 409 with its own words, and no decline form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { code: 'NOTICE_NOT_DECLINABLE', message: 'A notice cannot be declined' },
          { status: 409 },
        ),
      ),
    );
    const response = await decline(
      new Request(`http://links.test/l/${TOKEN}/decline`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'reason=No',
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/l/${TOKEN}?error=NOTICE_NOT_DECLINABLE#sign`);
    expect(problemText({ error: 'NOTICE_NOT_DECLINABLE' })).toBe(
      'A notice cannot be declined. Signing only acknowledges that you received it.',
    );
  });

  it('keeps a lease’s refusals as the API words them', () => {
    expect(declineProblem({ status: 409, code: 'LINK_NOT_USABLE' })).toBe('LINK_NOT_USABLE');
    expect(declineProblem({ status: 400, code: 'REASON_REQUIRED' })).toBe('REASON_REQUIRED');
    expect(declineProblem({ status: 409, code: 'NOTICE_CANNOT_BE_DECLINED' })).toBe(
      'NOTICE_NOT_DECLINABLE',
    );
  });
});
