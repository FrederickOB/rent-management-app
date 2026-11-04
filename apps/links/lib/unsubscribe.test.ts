import { DEV_LINKS_API_KEY, LINKS_API_KEY_HEADER, type UnsubscribePage } from '@rent/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/u/[token]/confirm/route';
import { ConfirmScreen, DoneScreen, ExpiredScreen } from '../app/u/[token]/screens';
import type { ApiResult } from './links-api';
import {
  confirmResponse,
  isOneClick,
  unsubscribeProblemText,
  unsubscribeView,
  type UnsubscribeView,
} from './unsubscribe';

const TOKEN = 'u'.repeat(43);
const LANDLORD = 'Osu Ridge Property Managers';
const EMAIL = 'a•••@example.com';
const DONE: UnsubscribePage = { screen: 'done', landlordName: LANDLORD, emailMasked: EMAIL };

const page = (screen: UnsubscribePage['screen']): ApiResult<UnsubscribePage> => ({
  ok: true,
  value: {
    screen,
    landlordName: screen === 'invalid' ? null : LANDLORD,
    emailMasked: screen === 'invalid' ? null : EMAIL,
  },
});
const failed = (status: number, code = 'ERROR'): ApiResult<UnsubscribePage> => ({
  ok: false,
  status,
  code,
  data: null,
});

/** The visible text of rendered markup, without its tags. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function rendered(view: UnsubscribeView): string {
  switch (view.kind) {
    case 'confirm':
      return renderToStaticMarkup(
        createElement(ConfirmScreen, {
          token: TOKEN,
          landlordName: view.landlordName,
          emailMasked: view.emailMasked,
          problem: null,
        }),
      );
    case 'done':
      return renderToStaticMarkup(
        createElement(DoneScreen, {
          landlordName: view.landlordName,
          emailMasked: view.emailMasked,
        }),
      );
    case 'expired':
      return renderToStaticMarkup(
        createElement(ExpiredScreen, { landlordName: view.landlordName }),
      );
    default:
      throw new Error(`nothing to render for ${view.kind}`);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CM-09 email unsubscribe page: opening the link', () => {
  it('names the landlord and the address, says what stops by email, and asks once', () => {
    const view = unsubscribeView(page('confirm'));
    expect(view).toEqual({
      kind: 'confirm',
      landlordName: LANDLORD,
      emailMasked: EMAIL,
    });
    const html = rendered(view);
    const text = textOf(html);
    expect(text).toContain(`Stop emails from ${LANDLORD}?`);
    expect(text).toContain(`stop sending emails to ${EMAIL} about your tenancy`);
    expect(text).toMatch(/rent reminders, receipts, building notices and links to sign documents/);
    expect(text).toContain('Nothing changes until you press the button.');
    // One form, posting to this link's confirm route, with one button.
    expect(html.match(/<form/g)).toHaveLength(1);
    const form = /<form([^>]*)>/.exec(html)?.[1] ?? '';
    expect(form).toContain(`action="/u/${TOKEN}/confirm"`);
    expect(form).toContain('method="post"');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(text).toContain('Stop emails');
    // The token is in the form's address only, never in what the person reads.
    expect(text).not.toContain(TOKEN);
  });

  it('says how to stop the other channels, without promising STOP by SMS', () => {
    const text = textOf(rendered(unsubscribeView(page('confirm'))));
    expect(text).toContain('This link stops emails only.');
    expect(text).toMatch(/WhatsApp: reply STOP to one of their WhatsApp messages/);
    expect(text).toMatch(/Reply STOP ALL to stop their WhatsApp messages, text messages, emails/);
    expect(text).toMatch(/App notifications: in the tenant app, open Profile/);
    expect(text).toMatch(/Text messages \(SMS\): reply STOP ALL on WhatsApp, or ask/);
  });

  it('shows the problem with the last press, and only the problems it knows', () => {
    expect(unsubscribeProblemText({})).toBeNull();
    expect(unsubscribeProblemText({ error: 'RATE_LIMITED' })).toMatch(/Too many requests/);
    expect(unsubscribeProblemText({ error: 'UNAVAILABLE' })).toMatch(/could not stop the emails/);
    expect(unsubscribeProblemText({ error: 'constructor' })).toMatch(/could not stop the emails/);
    const html = renderToStaticMarkup(
      createElement(ConfirmScreen, {
        token: TOKEN,
        landlordName: LANDLORD,
        emailMasked: null,
        problem: 'Too many requests. Wait a few minutes and try again.',
      }),
    );
    expect(html).toContain('role="alert"');
    // Without an address on record the sentence still reads.
    expect(textOf(html)).toContain(`${LANDLORD} will stop sending emails about your tenancy`);
  });

  it('is not found for an unknown token, and explains a busy or failing API', () => {
    expect(unsubscribeView(page('invalid'))).toEqual({ kind: 'not_found' });
    expect(unsubscribeView(failed(404, 'NOT_FOUND'))).toEqual({ kind: 'not_found' });
    expect(unsubscribeView(failed(429, 'RATE_LIMITED'))).toEqual({ kind: 'trouble', busy: true });
    expect(unsubscribeView(failed(503, 'UNAVAILABLE'))).toEqual({ kind: 'trouble', busy: false });
  });
});

describe('CM-09 email unsubscribe page: confirmed', () => {
  it('says emails have stopped, and how to stop the rest', () => {
    const view = unsubscribeView(page('done'));
    expect(view.kind).toBe('done');
    const html = rendered(view);
    const text = textOf(html);
    expect(text).toContain(`You will no longer get emails from ${LANDLORD}`);
    expect(text).toContain(`you do not want emails to ${EMAIL} from ${LANDLORD}`);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<form');
    expect(text).toContain('This link stops emails only.');
  });

  it('answers the button with a 303 back to the page, which then shows what the API says', () => {
    for (const result of [page('done'), page('expired'), failed(404, 'NOT_FOUND')]) {
      const response = confirmResponse(TOKEN, result, false);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`/u/${TOKEN}`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(confirmResponse(TOKEN, failed(429), false).headers.get('location')).toBe(
      `/u/${TOKEN}?error=RATE_LIMITED`,
    );
    expect(confirmResponse(TOKEN, failed(503), false).headers.get('location')).toBe(
      `/u/${TOKEN}?error=UNAVAILABLE`,
    );
  });

  it('answers a mail client’s one-click post (RFC 8058) with a plain status', async () => {
    const oneClick = await new Request('http://links.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }).formData();
    expect(isOneClick(oneClick)).toBe(true);
    expect(isOneClick(new FormData())).toBe(false);
    expect(isOneClick(null)).toBe(false);

    const statuses = [
      [page('done'), 200],
      [page('confirm'), 200],
      [page('expired'), 410],
      [page('invalid'), 404],
      [failed(404), 404],
      [failed(429), 429],
      [failed(500), 503],
    ] as const;
    for (const [result, status] of statuses) {
      const response = confirmResponse(TOKEN, result, true);
      expect(response.status).toBe(status);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('confirms through the links API with the links key, the token and the browser', async () => {
    const fetchMock = vi.fn(async () => Response.json(DONE));
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(
      new Request(`http://links.test/u/${TOKEN}/confirm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '203.0.113.9',
          'user-agent': 'Mozilla/5.0 (Linux; Android 13)',
        },
        body: '',
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/u/${TOKEN}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/links\/unsubscribe\/confirm$/);
    expect((init.headers as Record<string, string>)[LINKS_API_KEY_HEADER]).toBe(
      process.env.LINKS_API_KEY ?? DEV_LINKS_API_KEY,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      token: TOKEN,
      client: { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (Linux; Android 13)' },
    });
  });
});

describe('CM-09 email unsubscribe page: expired or unknown links', () => {
  it('shows the standard screen for an expired link, with how to stop emails without it', () => {
    const view = unsubscribeView(page('expired'));
    expect(view).toEqual({ kind: 'expired', landlordName: LANDLORD });
    const text = textOf(rendered(view));
    expect(text).toContain('This link is not valid or has expired');
    expect(text).toContain(`Use the link in a newer email from ${LANDLORD}`);
    expect(text).not.toContain('Stop emails from');
  });

  it('never unsubscribes on a GET, which link scanners send, and never asks the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new Request(`http://links.test/u/${TOKEN}/confirm`), {
      params: Promise.resolve({ token: TOKEN }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/u/${TOKEN}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes only well-formed tokens on', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const token of ['short', `${TOKEN}x`, '../../etc']) {
      const posted = await POST(
        new Request('http://links.test/u/x/confirm', { method: 'POST', body: '' }),
        { params: Promise.resolve({ token }) },
      );
      expect(posted.status).toBe(404);
      const got = await GET(new Request('http://links.test/u/x/confirm'), {
        params: Promise.resolve({ token }),
      });
      expect(got.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
