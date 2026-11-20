import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as attachment } from '../app/j/[token]/attachment/[attachmentId]/route';
import { SheetScreen } from '../app/j/[token]/screens';
import { jobSheetProblem, scanOf } from './job-sheet';
import type { JobSheetView } from './links-api';

// Malware scanning on the job sheet (M11 decision 6; MI-04): the tenant's photos and videos are
// served only once scanned clean. One still being checked shows as such, with no link; one found
// infected is never offered.

const TOKEN = 'v'.repeat(43);
const ids = {
  clean: '0193a7c0-0000-7000-8000-0000000e0001',
  pending: '0193a7c0-0000-7000-8000-0000000e0002',
  infected: '0193a7c0-0000-7000-8000-0000000e0003',
  older: '0193a7c0-0000-7000-8000-0000000e0004',
};

function sheet(): JobSheetView {
  const file = (id: string, scan?: string) =>
    ({
      id,
      kind: 'image',
      stage: 'report',
      contentType: 'image/jpeg',
      ...(scan ? { scan } : {}),
    }) as JobSheetView['attachments'][number];
  return {
    screen: 'sheet',
    ticket: 'MT-0042',
    status: 'assigned',
    description: 'The kitchen sink leaks.',
    category: 'plumbing',
    priority: 'urgent',
    property: { name: 'East Legon flats', address: null },
    unitCode: 'ACC-ELG-B1-05',
    contact: { name: 'Kofi Manager', phone: '+233302000000' },
    artisan: { name: 'Yaw Plumber', response: null },
    visitAt: null,
    attachments: [
      file(ids.clean, 'clean'),
      file(ids.pending, 'pending'),
      file(ids.infected, 'infected'),
      file(ids.older),
    ],
    timeZone: 'Africa/Accra',
    linkExpiresAt: '2026-12-05T10:00:00.000Z',
    actions: { accept: true, decline: true, start: false, complete: false },
    code: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('NFR-SEC scan states on the job sheet (MI-04, decision 6)', () => {
  it('a clean file has its link, one being checked says so with none, an infected one is not there', () => {
    const html = renderToStaticMarkup(
      createElement(SheetScreen, { token: TOKEN, sheet: sheet(), query: {} }),
    );
    expect(html).toContain(`href="/j/${TOKEN}/attachment/${ids.clean}"`);
    expect(html).not.toContain(`/attachment/${ids.pending}`);
    expect(html).toContain('Photo 2: being checked for viruses.');
    expect(html).not.toContain(ids.infected);
    // A file from before scanning began, with no scan field, is served as before.
    expect(html).toContain(`href="/j/${TOKEN}/attachment/${ids.older}"`);
    expect(scanOf(sheet().attachments[3]!)).toBe('clean');
  });

  it('asking for a file still being checked brings the sheet back with a word, not the file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ code: 'SCAN_PENDING', message: 'Being checked' }, { status: 409 }),
      ),
    );
    const answer = await attachment(
      new Request(`http://links.test/j/${TOKEN}/attachment/${ids.pending}`),
      { params: Promise.resolve({ token: TOKEN, attachmentId: ids.pending }) },
    );
    expect(answer.status).toBe(303);
    expect(answer.headers.get('location')).toBe(`/j/${TOKEN}?error=SCAN_PENDING`);
    expect(jobSheetProblem({ error: 'SCAN_PENDING' })).toBe(
      'That file is still being checked for viruses. Try again in a minute.',
    );
  });

  // An infected file is the API's 410 DOCUMENT_QUARANTINED, in the next describe.
  it('a file the API does not know (its 404) is not found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code: 'NOT_FOUND' }, { status: 404 })),
    );
    const answer = await attachment(
      new Request(`http://links.test/j/${TOKEN}/attachment/${ids.infected}`),
      { params: Promise.resolve({ token: TOKEN, attachmentId: ids.infected }) },
    );
    expect(answer.status).toBe(404);
  });
});

describe('NFR-SEC the scan answers the API gives (MI-04, decision 6)', () => {
  it('409 DOCUMENT_SCAN_PENDING says the file is being checked; 410 DOCUMENT_QUARANTINED, that it is not available', async () => {
    for (const [status, code, error] of [
      [409, 'DOCUMENT_SCAN_PENDING', 'SCAN_PENDING'],
      [410, 'DOCUMENT_QUARANTINED', 'FILE_NOT_AVAILABLE'],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ code, message: 'No' }, { status })),
      );
      const answer = await attachment(
        new Request(`http://links.test/j/${TOKEN}/attachment/${ids.pending}`),
        { params: Promise.resolve({ token: TOKEN, attachmentId: ids.pending }) },
      );
      expect(answer.headers.get('location')).toBe(`/j/${TOKEN}?error=${error}`);
      vi.unstubAllGlobals();
    }
    expect(jobSheetProblem({ error: 'FILE_NOT_AVAILABLE' })).toBe('That file is not available.');
  });
});
