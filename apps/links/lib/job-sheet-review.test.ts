import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as code } from '../app/j/[token]/code/route';
import { POST as complete } from '../app/j/[token]/complete/route';
import { POST as respond } from '../app/j/[token]/respond/route';
import { ClosedScreen, SheetScreen } from '../app/j/[token]/screens';
import { POST as start } from '../app/j/[token]/start/route';
import { register } from '../instrumentation';
import { formWithin, JOB_SHEET_MAX_BODY_BYTES } from './body-limit';
import { jobSheetProblem } from './job-sheet';
import { forgetUploads, keepUploads, keptUploads } from './job-sheet-store';
import type { JobSheetView } from './links-api';
import { installLogRedaction, redactTokens } from './log-redaction';

// The M8 review round for the artisan's job sheet (MI-04, MI-06; decision 6, F1): posts of up to
// ten 10 MB photos arrive whole and never put a token in a log line (LT 1); a wrong code keeps the
// photos and a second tap does nothing twice (LT 6); a post with no answer accepts nothing, and
// a dead link names the job only (LT 9); the sheet lists the tenant's photos and videos only (F1)
// and never anything about the tenant, even when the view holds it (LT 10).

const TOKEN = 'r'.repeat(43);
const STORAGE = 'https://storage.example.test/rent-uploads';
const UPLOADS = ['0193a7c0-0000-7000-8000-0000000c0001', '0193a7c0-0000-7000-8000-0000000c0002'];
const FORM_ID = '0193a7c0-0000-4000-8000-0000000f0001';

function sheet(overrides: Partial<JobSheetView> = {}): JobSheetView {
  return {
    screen: 'sheet',
    ticket: 'MT-0042',
    status: 'in_progress',
    description: 'The kitchen sink leaks under the cabinet.',
    category: 'plumbing',
    priority: 'urgent',
    property: { name: 'East Legon flats', address: '12 Lagos Avenue, East Legon' },
    unitCode: 'ACC-ELG-B1-05',
    contact: { name: 'Kofi Manager', phone: '+233302000000' },
    artisan: { name: 'Yaw Plumber', response: 'accepted' },
    visitAt: null,
    attachments: [],
    timeZone: 'Africa/Accra',
    linkExpiresAt: '2026-12-05T10:00:00.000Z',
    actions: { accept: false, decline: false, start: false, complete: true },
    code: {
      destinationMasked: '+233 24 *** **77',
      sentAt: '2026-11-06T11:00:00.000Z',
      expiresAt: '2026-11-06T11:10:00.000Z',
      attemptsLeft: 4,
      sendsLeft: 2,
      lockedUntil: null,
    },
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
const render = (view: JobSheetView, kept = 0) =>
  renderToStaticMarkup(createElement(SheetScreen, { token: TOKEN, sheet: view, query: {}, kept }));

const jpeg = (name: string, size = 2_000) =>
  new File([new Uint8Array(size).fill(0xff)], name, { type: 'image/jpeg' });

type Call = { url: string; init: RequestInit | undefined };

/** The links API by path and storage by its URL; each upload gets the next id. */
function stubNetwork(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let uploads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === STORAGE) return new Response(null, { status: 204 });
      const path = new URL(url).pathname;
      if (path === '/job-sheets/uploads' && !answers[path]) {
        const uploadId = UPLOADS[uploads % UPLOADS.length]!;
        uploads += 1;
        return Response.json({ uploadId, url: STORAGE, fields: { key: 'k' }, expiresAt: 'x' });
      }
      const answer = answers[path];
      return answer ? answer() : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    }),
  );
  return calls;
}
const apiBodies = (calls: readonly Call[], path: string) =>
  calls
    .filter((call) => call.url.endsWith(path))
    .map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);
const stored = (calls: readonly Call[]) => calls.filter((call) => call.url === STORAGE);

function post(path: string, form: FormData) {
  return new Request(`http://links.test${path}`, {
    method: 'POST',
    body: form,
    headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Linux; Android 13)' },
  });
}
const params = { params: Promise.resolve({ token: TOKEN }) };

function completion(photos: readonly File[], codeValue = '123456', formId?: string) {
  const form = new FormData();
  for (const photo of photos) form.append('photos', photo);
  form.set('completionNote', 'Replaced the trap and the seal.');
  form.set('code', codeValue);
  if (formId) form.set('form', formId);
  return form;
}

const wrongCode = () =>
  Response.json(
    { code: 'CODE_WRONG', message: 'Wrong code', data: { attemptsLeft: '3' } },
    { status: 400 },
  );

beforeEach(() => {
  forgetUploads(TOKEN);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MI-06 job-sheet photo posts of up to ten 10 MB photos arrive whole (review LT 1)', () => {
  it('a form declared over the limit is refused before a byte is read', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('the body must not be read');
      },
    });
    const request = {
      headers: new Headers({ 'content-length': String(JOB_SHEET_MAX_BODY_BYTES + 1) }),
      body,
    } as unknown as Request;
    expect(await formWithin(request, JOB_SHEET_MAX_BODY_BYTES)).toEqual({
      ok: false,
      error: 'BODY_TOO_LARGE',
    });
  });

  it('a form that passes the limit while it is read is refused, and the rest is not read', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1_000));
      },
    });
    const request = { headers: new Headers(), body } as unknown as Request;
    expect(await formWithin(request, 5_500)).toEqual({ ok: false, error: 'BODY_TOO_LARGE' });
    expect(pulled).toBeLessThan(10);
  });

  it('two 6 MB photos (12 MB, over the old 10 MB cut) reach storage whole', async () => {
    const calls = stubNetwork({
      '/job-sheets/open': () => Response.json(sheet()),
      '/job-sheets/complete': () => Response.json(sheet({ screen: 'done' })),
    });
    const photos = [jpeg('a.jpg', 6_000_000), jpeg('b.jpg', 6_000_000)];
    const done = await complete(post(`/j/${TOKEN}/complete`, completion(photos)), params);
    expect(done.headers.get('location')).toBe(`/j/${TOKEN}?done=completed`);
    expect(apiBodies(calls, '/job-sheets/uploads').map((b) => b.sizeBytes)).toEqual([
      6_000_000, 6_000_000,
    ]);
    const files = stored(calls).map((call) => (call.init!.body as FormData).get('file') as File);
    expect(files.map((file) => file.size)).toEqual([6_000_000, 6_000_000]);
    expect(apiBodies(calls, '/job-sheets/complete')[0]).toMatchObject({ uploadIds: UPLOADS });
  });

  it('a post over the limit says how much it may carry, sends nothing, and keeps the headers', async () => {
    const calls = stubNetwork({});
    const request = {
      headers: new Headers({
        'content-length': String(JOB_SHEET_MAX_BODY_BYTES + 1),
        'content-type': 'multipart/form-data; boundary=x',
      }),
      body: null,
    } as unknown as Request;
    for (const route of [complete, start]) {
      const refused = await route(request, params);
      expect(refused.status).toBe(303);
      expect(refused.headers.get('location')).toBe(`/j/${TOKEN}?error=BODY_TOO_LARGE#act`);
      expect(refused.headers.get('cache-control')).toBe('no-store');
      expect(refused.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(refused.headers.get('referrer-policy')).toBe('no-referrer');
      expect(refused.headers.get('x-frame-options')).toBe('DENY');
    }
    expect(calls).toEqual([]);
    expect(jobSheetProblem({ error: 'BODY_TOO_LARGE' })).toBe(
      'Send at most 10 photos at a time, each 10 MB or smaller.',
    );
  });

  it('a token in any line the server writes, Next.js’s warning included, is replaced', () => {
    const lines: string[] = [];
    const sink = {
      log: (...a: unknown[]) => lines.push(a.join(' ')),
      info: (...a: unknown[]) => lines.push(a.join(' ')),
      warn: (...a: unknown[]) => lines.push(a.join(' ')),
      error: (...a: unknown[]) => lines.push(a.join(' ')),
      debug: (...a: unknown[]) => lines.push(a.join(' ')),
      trace: (...a: unknown[]) => lines.push(a.join(' ')),
    };
    installLogRedaction(sink);
    installLogRedaction(sink);
    sink.warn(
      `Request body exceeded 10MB for /j/${TOKEN}/complete. Only the first 10MB will be available unless configured.`,
    );
    sink.error(new Error(`Failed to render /l/${TOKEN}`));
    sink.log('opened', { url: `http://links.test/p/${TOKEN}?x=1` });
    sink.info('a page %s', `/u/${TOKEN}`);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).toMatch(/\/[jlpu]\/\[link\]/);
    }
    expect(lines[0]).toContain('/j/[link]/complete');
    expect(redactTokens('/health and /j/short')).toBe('/health and /j/short');
  });

  it('the server installs the redaction when it starts', async () => {
    const original = { ...console };
    const written = vi.fn();
    const marker = Symbol.for('rent.links.log-redaction');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    console.warn = written;
    try {
      await register();
      console.warn(`Request body exceeded 10MB for /j/${TOKEN}/start`);
      expect(written).toHaveBeenCalledWith('Request body exceeded 10MB for /j/[link]/start');
    } finally {
      Object.assign(console, original);
      delete (console as unknown as Record<symbol, unknown>)[marker];
      vi.unstubAllEnvs();
    }
  });
});

describe('MI-06 completing the work: a wrong code costs no upload, a double tap does nothing twice (review LT 6)', () => {
  it('after a wrong code the photos are kept; the retry sends the code alone, with them', async () => {
    let answer: () => Response = wrongCode;
    const calls = stubNetwork({
      '/job-sheets/open': () => Response.json(sheet()),
      '/job-sheets/complete': () => answer(),
    });
    const photos = [jpeg('a.jpg'), jpeg('b.jpg')];
    const wrong = await complete(
      post(`/j/${TOKEN}/complete`, completion(photos, '111111')),
      params,
    );
    expect(wrong.headers.get('location')).toBe(`/j/${TOKEN}?error=CODE_WRONG&left=3#act`);
    expect(stored(calls)).toHaveLength(2);
    expect(keptUploads(TOKEN)).toEqual(UPLOADS);

    // The page says so, and the photo field is no longer required.
    const html = render(sheet(), keptUploads(TOKEN).length);
    expect(textOf(html)).toContain(
      'Your 2 photos of the finished work are kept from your last try. Choose photos only to replace them.',
    );
    expect(html).not.toMatch(/<input(?=[^>]*name="photos")(?=[^>]*required)[^>]*>/);

    answer = () => Response.json(sheet({ screen: 'done' }));
    const done = await complete(post(`/j/${TOKEN}/complete`, completion([], '123456')), params);
    expect(done.headers.get('location')).toBe(`/j/${TOKEN}?done=completed`);
    expect(stored(calls)).toHaveLength(2);
    expect(apiBodies(calls, '/job-sheets/uploads')).toHaveLength(2);
    expect(apiBodies(calls, '/job-sheets/complete')[1]).toMatchObject({
      code: '123456',
      uploadIds: UPLOADS,
    });
    expect(keptUploads(TOKEN)).toEqual([]);
    expect(render(sheet(), 0)).toMatch(/<input(?=[^>]*name="photos")(?=[^>]*required)[^>]*>/);
  });

  it('new photos replace the kept ones; files the API refuses are not kept', async () => {
    keepUploads(TOKEN, ['0193a7c0-0000-7000-8000-0000000c00ff']);
    let answer: () => Response = () =>
      Response.json({ code: 'MEDIA_TYPE_MISMATCH', message: 'Not a photo' }, { status: 400 });
    const calls = stubNetwork({
      '/job-sheets/open': () => Response.json(sheet()),
      '/job-sheets/complete': () => answer(),
    });
    await complete(post(`/j/${TOKEN}/complete`, completion([jpeg('new.jpg')])), params);
    expect(apiBodies(calls, '/job-sheets/complete')[0]).toMatchObject({ uploadIds: [UPLOADS[0]] });
    expect(keptUploads(TOKEN)).toEqual([]);

    answer = wrongCode;
    const none = await complete(post(`/j/${TOKEN}/complete`, completion([])), params);
    expect(none.headers.get('location')).toBe(`/j/${TOKEN}?error=PHOTO_REQUIRED#act`);
  });

  it('a second tap on the same form uploads nothing more and gets the same answer', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const calls = stubNetwork({
      '/job-sheets/open': () => Response.json(sheet()),
      '/job-sheets/complete': async () => {
        await held;
        return Response.json(sheet({ screen: 'done' }));
      },
    });
    const first = complete(
      post(`/j/${TOKEN}/complete`, completion([jpeg('a.jpg')], '123456', FORM_ID)),
      params,
    );
    const second = complete(
      post(`/j/${TOKEN}/complete`, completion([jpeg('a.jpg')], '123456', FORM_ID)),
      params,
    );
    await vi.waitFor(() => expect(apiBodies(calls, '/job-sheets/complete')).toHaveLength(1));
    release();
    const answers = await Promise.all([first, second]);
    expect(answers.map((a) => [a.status, a.headers.get('location')])).toEqual([
      [303, `/j/${TOKEN}?done=completed`],
      [303, `/j/${TOKEN}?done=completed`],
    ]);
    expect(apiBodies(calls, '/job-sheets/uploads')).toHaveLength(1);
    expect(stored(calls)).toHaveLength(1);
    expect(apiBodies(calls, '/job-sheets/complete')).toHaveLength(1);

    // A later post of the same form, a reload of the post for one, gets the answer again.
    const again = await complete(
      post(`/j/${TOKEN}/complete`, completion([jpeg('a.jpg')], '123456', FORM_ID)),
      params,
    );
    expect(again.headers.get('location')).toBe(`/j/${TOKEN}?done=completed`);
    expect(apiBodies(calls, '/job-sheets/complete')).toHaveLength(1);
  });

  it('a double tap on Start or on Send me a code acts once', async () => {
    const formId = '0193a7c0-0000-4000-8000-0000000f0002';
    const calls = stubNetwork({
      '/job-sheets/open': () => Response.json(sheet()),
      '/job-sheets/start': () => Response.json(sheet()),
      '/job-sheets/code': () => Response.json(sheet()),
    });
    const starting = () => {
      const form = new FormData();
      form.append('photos', jpeg('before.jpg'));
      form.set('form', formId);
      return start(post(`/j/${TOKEN}/start`, form), params);
    };
    await Promise.all([starting(), starting()]);
    expect(apiBodies(calls, '/job-sheets/start')).toHaveLength(1);
    expect(stored(calls)).toHaveLength(1);

    const codeForm = () => {
      const form = new FormData();
      form.set('form', '0193a7c0-0000-4000-8000-0000000f0003');
      return code(post(`/j/${TOKEN}/code`, form), params);
    };
    const sent = await Promise.all([codeForm(), codeForm()]);
    expect(sent.map((s) => s.headers.get('location'))).toEqual([
      `/j/${TOKEN}?sent=1#act`,
      `/j/${TOKEN}?sent=1#act`,
    ]);
    expect(apiBodies(calls, '/job-sheets/code')).toHaveLength(1);
  });

  it('each form on the sheet carries an id of its own, new at each rendering', () => {
    const ids = (html: string) =>
      [...html.matchAll(/name="form" value="([^"]+)"/g)].map((m) => m[1]);
    const started = render(
      sheet({ actions: { accept: false, decline: false, start: true, complete: true } }),
    );
    const first = ids(started);
    expect(first).toHaveLength(3);
    for (const id of first) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(first).size).toBe(3);
    const second = ids(
      render(sheet({ actions: { accept: false, decline: false, start: true, complete: true } })),
    );
    expect(second.some((id) => first.includes(id))).toBe(false);
  });
});

describe('MI-04 an answer must be given, and a dead link names the job only (review LT 9)', () => {
  it('a post with no answer, or another word, accepts nothing', async () => {
    const calls = stubNetwork({ '/job-sheets/respond': () => Response.json(sheet()) });
    for (const value of [null, '', 'yes', 'ACCEPTED ']) {
      const form = new FormData();
      if (value !== null) form.set('response', value);
      const answer = await respond(post(`/j/${TOKEN}/respond`, form), params);
      expect(answer.headers.get('location')).toBe(`/j/${TOKEN}?error=RESPONSE_REQUIRED#act`);
    }
    expect(calls).toEqual([]);
    expect(jobSheetProblem({ error: 'RESPONSE_REQUIRED' })).toBe(
      'Choose whether you can take the job.',
    );

    const accepted = new FormData();
    accepted.set('response', 'accepted');
    const answer = await respond(post(`/j/${TOKEN}/respond`, accepted), params);
    expect(answer.headers.get('location')).toBe(`/j/${TOKEN}?done=accepted`);
    expect(apiBodies(calls, '/job-sheets/respond')).toMatchObject([{ response: 'accepted' }]);
  });

  it('an expired or replaced link shows no property, address or contact, even if sent one', () => {
    for (const screen of ['expired', 'revoked'] as const) {
      const html = renderToStaticMarkup(createElement(ClosedScreen, { sheet: sheet({ screen }) }));
      const text = textOf(html);
      expect(text).toContain('Job MT-0042: Plumbing.');
      expect(text).not.toContain('East Legon flats');
      expect(text).not.toContain('Lagos Avenue');
      expect(text).not.toContain('Kofi Manager');
      expect(html).not.toContain('tel:');
    }
    const closed = textOf(
      renderToStaticMarkup(createElement(ClosedScreen, { sheet: sheet({ screen: 'closed' }) })),
    );
    expect(closed).toContain('Job MT-0042: Plumbing at East Legon flats.');
  });

  it('the view a dead link gets (no description, contact or files) still renders', () => {
    const dead = sheet({
      screen: 'closed',
      description: null,
      contact: null,
      visitAt: null,
      code: null,
      attachments: [],
      property: { name: 'East Legon flats', address: null },
      actions: { accept: false, decline: false, start: false, complete: false },
    });
    const text = textOf(renderToStaticMarkup(createElement(ClosedScreen, { sheet: dead })));
    expect(text).toContain('This job is closed');
    expect(text).not.toContain('Questions about this job?');
    // And a live sheet without a description or contact leaves those parts out.
    const live = textOf(render(sheet({ description: null, contact: null })));
    expect(live).toContain('Yaw Plumber, East Legon flats has a job for you.');
    expect(live).not.toContain('What needs doing');
    expect(live).not.toContain('Questions about this job?');
  });
});

describe('MI-04 what the sheet lists: the tenant’s photos and videos, never the tenant (F1, review LT 2 and LT 10)', () => {
  it('lists the report’s photos and videos only, even if the view held other files', () => {
    const files = [
      { id: '0193a7c0-0000-7000-8000-0000000d0001', kind: 'image', stage: 'report' },
      { id: '0193a7c0-0000-7000-8000-0000000d0002', kind: 'video', stage: 'report' },
      { id: '0193a7c0-0000-7000-8000-0000000d0003', kind: 'audio', stage: 'report' },
      { id: '0193a7c0-0000-7000-8000-0000000d0004', kind: 'image', stage: 'before' },
      { id: '0193a7c0-0000-7000-8000-0000000d0005', kind: 'image', stage: 'other' },
    ].map((f) => ({ ...f, contentType: 'x' })) as unknown as JobSheetView['attachments'];
    const html = render(
      sheet({
        attachments: files,
        actions: { accept: true, decline: true, start: false, complete: false },
      }),
    );
    const links = [...html.matchAll(/href="\/j\/[^/]+\/attachment\/([^"]+)">([^<]+)</g)].map(
      (m) => [m[1], m[2]],
    );
    expect(links).toEqual([
      ['0193a7c0-0000-7000-8000-0000000d0001', 'Photo 1'],
      ['0193a7c0-0000-7000-8000-0000000d0002', 'Video 2'],
    ]);
    expect(textOf(html)).not.toContain('Voice note');
  });

  it('a view that carried the tenant’s name and phone shows neither', () => {
    const leaky = {
      ...sheet({ actions: { accept: true, decline: true, start: false, complete: false } }),
      tenant: { name: 'Abena Mensah', phone: '+233244000111', email: 'abena@example.test' },
      tenantPhone: '+233244000111',
    } as unknown as JobSheetView;
    const html = render(leaky);
    expect(html).not.toContain('Abena');
    expect(html).not.toContain('233244000111');
    expect(html).not.toContain('abena@example.test');
    expect(html).toContain('href="tel:+233302000000"');
  });
});
