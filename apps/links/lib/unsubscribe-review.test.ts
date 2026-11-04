import type { UnsubscribePage } from '@rent/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/u/[token]/confirm/route';
import { AddressChangedScreen } from '../app/u/[token]/screens';
import { confirmResponse, unsubscribeView } from './unsubscribe';

// M6 review round, C6: a link sent to an email address that is no longer the one on record.

const TOKEN = 'a'.repeat(43);
const LANDLORD = 'Osu Ridge Property Managers';
const CHANGED: UnsubscribePage = {
  screen: 'address_changed',
  landlordName: LANDLORD,
  emailMasked: null,
};

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CM-09 email unsubscribe page: a link for an address no longer on record (C6)', () => {
  it('shows a neutral screen that names the landlord, no address, and asks nothing', () => {
    const view = unsubscribeView({ ok: true, value: CHANGED });
    expect(view).toEqual({ kind: 'address_changed', landlordName: LANDLORD });
    const html = renderToStaticMarkup(
      createElement(AddressChangedScreen, { landlordName: LANDLORD }),
    );
    const text = textOf(html);
    expect(text).toContain('This link cannot be used');
    expect(text).toContain(`no longer has on record, so it changes nothing`);
    expect(text).not.toMatch(/@/);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });

  it('answers the button with a 303 back to the page, and a one-click post with 409', () => {
    const result = { ok: true as const, value: CHANGED };
    const form = confirmResponse(TOKEN, result, false);
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe(`/u/${TOKEN}`);
    const oneClick = confirmResponse(TOKEN, result, true);
    expect(oneClick.status).toBe(409);
    expect(oneClick.headers.get('location')).toBeNull();
    expect(oneClick.headers.get('cache-control')).toBe('no-store');
  });

  it('a one-click post through the route gets the 409 too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(CHANGED)),
    );
    const response = await POST(
      new Request(`http://links.test/u/${TOKEN}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    expect(response.status).toBe(409);
  });
});
