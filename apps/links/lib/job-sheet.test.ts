import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as attachment } from '../app/j/[token]/attachment/[attachmentId]/route';
import { POST as complete } from '../app/j/[token]/complete/route';
import { POST as respond } from '../app/j/[token]/respond/route';
import { ClosedScreen, DoneScreen, SheetScreen } from '../app/j/[token]/screens';
import { POST as start } from '../app/j/[token]/start/route';
import { proxy } from '../proxy';
import { jobSheetProblem, photosFrom } from './job-sheet';
import type { JobSheetView } from './links-api';

// The artisan's job sheet, /j/[token] (MI-04, MI-06; M8 decision 6 and plan 4.5).

const TOKEN = 'j'.repeat(43);
const STORAGE = 'https://storage.example.test/rent-uploads';
const UPLOAD = '0193a7c0-0000-7000-8000-0000000b0001';
const PHOTO_ID = '0193a7c0-0000-7000-8000-0000000b00a1';

function sheet(overrides: Partial<JobSheetView> = {}): JobSheetView {
  return {
    screen: 'sheet',
    ticket: 'MT-0042',
    status: 'assigned',
    description: 'The kitchen sink leaks under the cabinet.',
    category: 'plumbing',
    priority: 'urgent',
    property: { name: 'East Legon flats', address: '12 Lagos Avenue, East Legon' },
    unitCode: 'ACC-ELG-B1-05',
    contact: { name: 'Kofi Manager', phone: '+233302000000' },
    artisan: { name: 'Yaw Plumber', response: null },
    visitAt: '2026-11-06T10:00:00.000Z',
    attachments: [{ id: PHOTO_ID, kind: 'image', stage: 'report', contentType: 'image/jpeg' }],
    timeZone: 'Africa/Accra',
    linkExpiresAt: '2026-12-05T10:00:00.000Z',
    actions: { accept: true, decline: true, start: false, complete: false },
    code: null,
    ...overrides,
  };
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const render = (view: JobSheetView, query: Record<string, string> = {}) =>
  renderToStaticMarkup(createElement(SheetScreen, { token: TOKEN, sheet: view, query }));

const jpeg = (name = 'before.jpg', size = 2_000) =>
  new File([new Uint8Array(size).fill(0xff)], name, { type: 'image/jpeg' });

/** The API and storage, as the routes call them: the links API by path, storage by its URL. */
function stubNetwork(answers: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === STORAGE) return new Response(null, { status: 204 });
      const path = new URL(url).pathname;
      const answer = answers[path];
      return answer ? answer() : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    }),
  );
  return calls;
}
const apiBody = (calls: { url: string; init: RequestInit | undefined }[], path: string) =>
  calls
    .filter((call) => call.url.endsWith(path))
    .map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);

function post(path: string, form: FormData) {
  return new Request(`http://links.test${path}`, {
    method: 'POST',
    body: form,
    headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Linux; Android 13)' },
  });
}
const params = { params: Promise.resolve({ token: TOKEN }) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MI-04 the artisan’s job sheet: what it shows', () => {
  it('the unit, the description, the tenant’s photos and the property contact; never the tenant', () => {
    const html = render(sheet());
    const text = textOf(html);
    expect(text).toContain('Job MT-0042: Plumbing');
    expect(text).toContain('Priority Urgent');
    expect(text).toContain('Property East Legon flats');
    expect(text).toContain('Address 12 Lagos Avenue, East Legon');
    expect(text).toContain('Unit ACC-ELG-B1-05');
    expect(text).toContain('Visit 6 Nov 2026, 10:00 GMT (Africa/Accra)');
    expect(text).toContain('The kitchen sink leaks under the cabinet.');
    expect(html).toContain(`href="/j/${TOKEN}/attachment/${PHOTO_ID}"`);
    expect(text).toContain('Photo 1');
    expect(html).toContain('href="tel:+233302000000"');
    expect(text).toContain('Call Kofi Manager.');
    expect(text).not.toMatch(/tenant’s phone|tenant name/i);
  });

  it('accept, or decline with a reason', () => {
    const html = render(sheet());
    expect(html).toContain(`action="/j/${TOKEN}/respond"`);
    expect(html).toContain('name="response" value="accepted"');
    expect(textOf(html)).toContain('I cannot take this job');
    const declining = render(sheet(), { step: 'decline' });
    expect(declining).toContain('name="response" value="declined"');
    expect(declining).toContain('name="reason"');
    expect(declining).not.toContain('value="accepted"');
  });

  it('start: a before photo, or a reason for none', () => {
    const html = render(
      sheet({ actions: { accept: false, decline: false, start: true, complete: false } }),
    );
    const form = /<form[^>]*\/start"[^>]*>/.exec(html)?.[0] ?? '';
    expect(form).toMatch(/enctype="multipart\/form-data"/i);
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('name="beforePhotoReason"');
    expect(html).not.toContain('/respond');
  });

  it('complete: first a code, then after photos, the note and the code', () => {
    const before = render(
      sheet({
        actions: { accept: false, decline: false, start: false, complete: true },
        code: {
          destinationMasked: '+233 24 *** **77',
          sentAt: null,
          expiresAt: null,
          attemptsLeft: 5,
          sendsLeft: 3,
          lockedUntil: null,
        },
      }),
    );
    expect(before).toContain(`action="/j/${TOKEN}/code"`);
    expect(textOf(before)).toContain('We will send it by SMS to +233 24 *** **77');
    expect(before).not.toContain('/complete"');

    const after = render(
      sheet({
        actions: { accept: false, decline: false, start: false, complete: true },
        code: {
          destinationMasked: '+233 24 *** **77',
          sentAt: '2026-11-06T11:00:00.000Z',
          expiresAt: '2026-11-06T11:10:00.000Z',
          attemptsLeft: 5,
          sendsLeft: 2,
          lockedUntil: null,
        },
      }),
    );
    const form = /<form[^>]*\/complete"[^>]*>/.exec(after)?.[0] ?? '';
    expect(form).toMatch(/enctype="multipart\/form-data"/i);
    expect(after).toMatch(/<input(?=[^>]*name="photos")(?=[^>]*required)[^>]*>/);
    expect(after).toMatch(/<textarea(?=[^>]*name="completionNote")(?=[^>]*required)[^>]*>/);
    expect(after).toContain('name="code"');
    expect(textOf(after)).toContain('It works until 6 Nov 2026, 11:10 GMT (Africa/Accra)');
  });

  it('done, closed, expired and replaced links explain themselves and offer nothing', () => {
    const done = textOf(
      renderToStaticMarkup(
        createElement(DoneScreen, { sheet: sheet({ screen: 'done' }), done: true }),
      ),
    );
    expect(done).toContain('Thank you: the work is recorded as done');
    expect(done).toContain('waiting for the tenant to confirm it');
    for (const [screen, heading] of [
      ['closed', 'This job is closed'],
      ['expired', 'This link has expired'],
      ['revoked', 'This link no longer works'],
    ] as const) {
      const html = renderToStaticMarkup(createElement(ClosedScreen, { sheet: sheet({ screen }) }));
      expect(textOf(html)).toContain(heading);
      expect(html).not.toContain('<form');
    }
  });

  it('words its own problems, and the code problems as the signing page does', () => {
    expect(jobSheetProblem({ error: 'PHOTO_REQUIRED' })).toBe(
      'Add at least one photo of the finished work.',
    );
    expect(jobSheetProblem({ error: 'MAINTENANCE_BEFORE_PHOTO_REQUIRED' })).toMatch(/before/);
    expect(jobSheetProblem({ error: 'CODE_WRONG', left: '2' })).toBe(
      'That code is not right. You have 2 tries left.',
    );
    expect(jobSheetProblem({ error: 'constructor' })).toBe(
      'Something went wrong on our side. Try again in a minute.',
    );
    expect(jobSheetProblem({})).toBeNull();
  });
});

describe('MI-06 photos on the job sheet keep the job-media limits (decision 2)', () => {
  it('takes JPEG, PNG and WebP up to 10 MB, at most 10, and leaves out the empty part', () => {
    const form = new FormData();
    form.append('photos', new File([], '', { type: 'application/octet-stream' }));
    expect(photosFrom(form, 'photos')).toEqual({ ok: true, photos: [] });
    form.append('photos', jpeg());
    expect(photosFrom(form, 'photos')).toMatchObject({
      ok: true,
      photos: [{ name: 'before.jpg' }],
    });

    const gif = new FormData();
    gif.append('photos', new File(['GIF89a'], 'a.gif', { type: 'image/gif' }));
    expect(photosFrom(gif, 'photos')).toEqual({ ok: false, error: 'PHOTO_TYPE' });
    const big = new FormData();
    big.append('photos', jpeg('big.jpg', 10_000_001));
    expect(photosFrom(big, 'photos')).toEqual({ ok: false, error: 'PHOTO_TOO_LARGE' });
    const many = new FormData();
    for (let i = 0; i < 11; i += 1) many.append('photos', jpeg(`p${i}.jpg`));
    expect(photosFrom(many, 'photos')).toEqual({ ok: false, error: 'PHOTO_TOO_MANY' });
  });
});

describe('MI-04 and MI-06 the job sheet’s steps', () => {
  it('declining passes the reason on', async () => {
    const calls = stubNetwork({ '/job-sheets/respond': () => Response.json(sheet()) });
    const form = new FormData();
    form.set('response', 'declined');
    form.set('reason', 'Away this week');
    const response = await respond(post(`/j/${TOKEN}/respond`, form), params);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/j/${TOKEN}?done=declined`);
    expect(apiBody(calls, '/job-sheets/respond')[0]).toMatchObject({
      token: TOKEN,
      response: 'declined',
      reason: 'Away this week',
      client: { ip: '203.0.113.9' },
    });
  });

  it('start: the before photo goes to storage, then the start names its upload', async () => {
    const calls = stubNetwork({
      '/job-sheets/open': () => Response.json(sheet()),
      '/job-sheets/uploads': () =>
        Response.json({
          uploadId: UPLOAD,
          url: STORAGE,
          fields: { key: 'k', policy: 'p' },
          expiresAt: 'x',
        }),
      '/job-sheets/start': () => Response.json(sheet()),
    });
    const form = new FormData();
    form.append('photos', jpeg());
    const response = await start(post(`/j/${TOKEN}/start`, form), params);
    expect(response.headers.get('location')).toBe(`/j/${TOKEN}?done=started`);
    expect(apiBody(calls, '/job-sheets/uploads')[0]).toMatchObject({
      contentType: 'image/jpeg',
      sizeBytes: 2_000,
    });
    const stored = calls.find((call) => call.url === STORAGE)!;
    expect([...(stored.init!.body as FormData).keys()]).toEqual(['key', 'policy', 'file']);
    expect(apiBody(calls, '/job-sheets/start')[0]).toMatchObject({
      uploadIds: [UPLOAD],
      beforePhotoReason: null,
    });
  });

  it('start: with no photo and no reason, nothing is sent', async () => {
    const calls = stubNetwork({ '/job-sheets/open': () => Response.json(sheet()) });
    const response = await start(post(`/j/${TOKEN}/start`, new FormData()), params);
    expect(response.headers.get('location')).toBe(`/j/${TOKEN}?error=BEFORE_REQUIRED#act`);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/job-sheets/open']);
    const reason = new FormData();
    reason.set('beforePhotoReason', 'Emergency: no time for a photo');
    const answered = stubNetwork({
      '/job-sheets/open': () => Response.json(sheet()),
      '/job-sheets/start': () => Response.json(sheet()),
    });
    await start(post(`/j/${TOKEN}/start`, reason), params);
    expect(apiBody(answered, '/job-sheets/start')[0]).toMatchObject({
      uploadIds: [],
      beforePhotoReason: 'Emergency: no time for a photo',
    });
  });

  it('complete: needs an after photo and a note before anything is sent', async () => {
    const calls = stubNetwork({ '/job-sheets/open': () => Response.json(sheet()) });
    const noPhoto = new FormData();
    noPhoto.set('completionNote', 'Replaced the trap');
    noPhoto.set('code', '123456');
    expect(
      (await complete(post(`/j/${TOKEN}/complete`, noPhoto), params)).headers.get('location'),
    ).toBe(`/j/${TOKEN}?error=PHOTO_REQUIRED#act`);
    const noNote = new FormData();
    noNote.append('photos', jpeg('after.jpg'));
    noNote.set('code', '123456');
    expect(
      (await complete(post(`/j/${TOKEN}/complete`, noNote), params)).headers.get('location'),
    ).toBe(`/j/${TOKEN}?error=NOTE_REQUIRED#act`);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/job-sheets/open',
      '/job-sheets/open',
    ]);
  });

  it('complete: the photos, the note and the code go together; a wrong code says how many tries are left', async () => {
    let answer = () => Response.json(sheet({ screen: 'done' }));
    const calls = stubNetwork({
      '/job-sheets/open': () => Response.json(sheet()),
      '/job-sheets/uploads': () =>
        Response.json({ uploadId: UPLOAD, url: STORAGE, fields: {}, expiresAt: 'x' }),
      '/job-sheets/complete': () => answer(),
    });
    const form = () => {
      const f = new FormData();
      f.append('photos', jpeg('after.jpg'));
      f.set('completionNote', 'Replaced the trap and the seal.');
      f.set('code', ' 123 456 ');
      return f;
    };
    const done = await complete(post(`/j/${TOKEN}/complete`, form()), params);
    expect(done.headers.get('location')).toBe(`/j/${TOKEN}?done=completed`);
    expect(apiBody(calls, '/job-sheets/complete')[0]).toMatchObject({
      code: '123456',
      uploadIds: [UPLOAD],
      completionNote: 'Replaced the trap and the seal.',
    });

    answer = () =>
      Response.json(
        { code: 'CODE_WRONG', message: 'Wrong code', data: { attemptsLeft: '2' } },
        { status: 400 },
      );
    const wrong = await complete(post(`/j/${TOKEN}/complete`, form()), params);
    expect(wrong.headers.get('location')).toBe(`/j/${TOKEN}?error=CODE_WRONG&left=2#act`);
  });

  it('opens a file of the job through a fresh short link, and only a well-formed one', async () => {
    stubNetwork({
      '/job-sheets/attachment': () =>
        Response.json({ url: 'https://storage.example.test/a.jpg?sig=1' }),
    });
    const opened = await attachment(
      new Request(`http://links.test/j/${TOKEN}/attachment/${PHOTO_ID}`),
      {
        params: Promise.resolve({ token: TOKEN, attachmentId: PHOTO_ID }),
      },
    );
    expect(opened.status).toBe(303);
    expect(opened.headers.get('location')).toBe('https://storage.example.test/a.jpg?sig=1');
    const refused = await attachment(new Request('http://links.test/j/x/attachment/y'), {
      params: Promise.resolve({ token: TOKEN, attachmentId: '../../etc' }),
    });
    expect(refused.status).toBe(404);
  });

  it('the job sheet is never cached', () => {
    const response = proxy(new NextRequest(`http://links.test/j/${TOKEN}`));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
