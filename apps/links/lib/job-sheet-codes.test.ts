import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as code } from '../app/j/[token]/code/route';
import { POST as complete } from '../app/j/[token]/complete/route';
import { SheetScreen } from '../app/j/[token]/screens';
import { jobSheetProblem } from './job-sheet';
import { forgetUploads } from './job-sheet-store';
import type { JobSheetView } from './links-api';

// The one-time code on the job sheet (MI-06; decision 6), as M3's signing page words it: a wrong
// code says how many tries are left (`code_wrong`, attemptsLeft), and too many lock the code until
// a time the API gives (`code_locked`, 429, lockedUntil), shown in the job's own zone.

const TOKEN = 'k'.repeat(43);
const STORAGE = 'https://storage.example.test/rent-uploads';
const UNTIL = '2026-11-06T11:40:00.000Z';
const params = { params: Promise.resolve({ token: TOKEN }) };

function sheet(overrides: Partial<JobSheetView> = {}): JobSheetView {
  return {
    screen: 'sheet',
    ticket: 'MT-0042',
    status: 'in_progress',
    description: 'The kitchen sink leaks under the cabinet.',
    category: 'plumbing',
    priority: 'urgent',
    property: { name: 'East Legon flats', address: null },
    unitCode: 'ACC-ELG-B1-05',
    contact: { name: 'Kofi Manager', phone: '+233302000000' },
    artisan: { name: 'Yaw Plumber', response: 'accepted' },
    visitAt: null,
    attachments: [],
    timeZone: 'Africa/Accra',
    linkExpiresAt: '2026-12-05T10:00:00.000Z',
    actions: { accept: false, decline: false, start: false, complete: true },
    code: null,
    ...overrides,
  };
}

function stubApi(path: string, answer: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === STORAGE) return new Response(null, { status: 204 });
      const at = new URL(url).pathname;
      if (at === '/job-sheets/uploads')
        return Response.json({
          uploadId: '0193a7c0-0000-7000-8000-0000000c0001',
          url: STORAGE,
          fields: {},
          expiresAt: 'x',
        });
      return at === path ? answer() : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    }),
  );
}

function completion() {
  const form = new FormData();
  form.append(
    'photos',
    new File([new Uint8Array(2_000).fill(0xff)], 'after.jpg', { type: 'image/jpeg' }),
  );
  form.set('completionNote', 'Replaced the trap and the seal.');
  form.set('code', '123456');
  return new Request(`http://links.test/j/${TOKEN}/complete`, { method: 'POST', body: form });
}

const locked = () =>
  Response.json(
    { code: 'CODE_LOCKED', message: 'Too many wrong codes', data: { lockedUntil: UNTIL } },
    { status: 429 },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  forgetUploads(TOKEN);
});

describe('MI-06 the job sheet’s code problems, as the signing page words them', () => {
  it('a locked code says until when, in the job’s zone', async () => {
    stubApi('/job-sheets/complete', locked);
    const answer = await complete(completion(), params);
    expect(answer.headers.get('location')).toBe(
      `/j/${TOKEN}?error=CODE_LOCKED&until=${encodeURIComponent(UNTIL)}#act`,
    );
    const query = Object.fromEntries(
      new URL(answer.headers.get('location')!, 'http://links.test').searchParams,
    );
    expect(jobSheetProblem(query, 'Africa/Accra')).toBe(
      'Too many wrong codes. Try again after 6 Nov 2026, 11:40 GMT (Africa/Accra).',
    );
    expect(jobSheetProblem(query, 'Europe/London')).toBe(
      'Too many wrong codes. Try again after 6 Nov 2026, 11:40 GMT (Europe/London).',
    );
    const html = renderToStaticMarkup(
      createElement(SheetScreen, { token: TOKEN, sheet: sheet(), query }),
    );
    expect(html).toContain(
      'Too many wrong codes. Try again after 6 Nov 2026, 11:40 GMT (Africa/Accra).',
    );
  });

  it('asking for a code while it is locked says the same', async () => {
    stubApi('/job-sheets/code', locked);
    const answer = await code(
      new Request(`http://links.test/j/${TOKEN}/code`, { method: 'POST', body: new FormData() }),
      params,
    );
    expect(answer.headers.get('location')).toBe(
      `/j/${TOKEN}?error=CODE_LOCKED&until=${encodeURIComponent(UNTIL)}#act`,
    );
  });

  it('a wrong code says how many tries are left', async () => {
    stubApi('/job-sheets/complete', () =>
      Response.json(
        { code: 'CODE_WRONG', message: 'Wrong code', data: { attemptsLeft: '1' } },
        { status: 400 },
      ),
    );
    const answer = await complete(completion(), params);
    expect(answer.headers.get('location')).toBe(`/j/${TOKEN}?error=CODE_WRONG&left=1#act`);
    expect(jobSheetProblem({ error: 'CODE_WRONG', left: '1' })).toBe(
      'That code is not right. You have 1 try left.',
    );
  });

  it('a lock without a well-formed time, and any other 429, stay plain', async () => {
    expect(jobSheetProblem({ error: 'CODE_LOCKED', until: '<script>' })).toBe(
      'Too many wrong codes. Wait a while before you try again.',
    );
    expect(jobSheetProblem({ error: 'CODE_LOCKED' })).toBe(
      'Too many wrong codes. Wait a while before you try again.',
    );
    stubApi('/job-sheets/complete', () =>
      Response.json({ code: 'TOO_MANY_REQUESTS', message: 'Slow down' }, { status: 429 }),
    );
    const answer = await complete(completion(), params);
    expect(answer.headers.get('location')).toBe(`/j/${TOKEN}?error=RATE_LIMITED#act`);
  });
});
