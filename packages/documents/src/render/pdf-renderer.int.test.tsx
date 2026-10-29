import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { format, money } from '@rent/domain/money';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sha256Hex, verifyFingerprint } from '../fingerprint';
import { defineTemplate, Letterhead, renderHtml, renderTemplateHtml } from '../templates';
import { sampleBranding, sampleData, TINY_PNG_BASE64 } from '../templates/test-fixtures';
import { PdfRenderer } from './index';

/** Text, embedded font names and page sizes, read back with pdfjs. */
async function readPdf(pdf: Buffer) {
  // A copy: pdfjs takes ownership of the bytes it is given.
  const task = getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: false,
    disableFontFace: true,
    fontExtraProperties: true,
  });
  const doc = await task.promise;
  try {
    const text: string[] = [];
    const fonts = new Set<string>();
    const sizes: number[][] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      sizes.push(page.view);
      const content = await page.getTextContent();
      await page.getOperatorList(); // loads the page's fonts, with their names
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text.push(item.str);
        fonts.add((page.commonObjs.get(item.fontName) as { name: string }).name);
      }
    }
    return { text: text.join(''), fonts: [...fonts], sizes };
  } finally {
    await task.destroy();
  }
}

const sampleHtml = (data = sampleData) =>
  renderTemplateHtml('system.sample', 1, data, sampleBranding);
const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString('latin1') === '%PDF-';

describe('PLATFORM documents', () => {
  let renderer: PdfRenderer;
  let server: Server;
  let origin: string;
  const blocked: string[] = [];
  const hits: string[] = [];

  beforeAll(async () => {
    // Stands in for any outside server: a request reaching it means the block failed.
    server = createServer((request, response) => {
      hits.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from(TINY_PNG_BASE64, 'base64'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    renderer = await PdfRenderer.launch({
      poolSize: 2,
      onBlockedRequest: (url) => blocked.push(url),
    });
  });

  afterAll(async () => {
    await renderer?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(() => {
    blocked.length = 0;
    hits.length = 0;
  });

  describe('PDF rendering', () => {
    it('renders system.sample to an A4 PDF whose fingerprint matches its bytes', async () => {
      const pdf = await renderer.render(sampleHtml());
      expect(isPdf(pdf)).toBe(true);
      const fingerprint = sha256Hex(pdf);
      expect(fingerprint).toBe(createHash('sha256').update(pdf).digest('hex'));
      expect(verifyFingerprint(pdf, fingerprint)).toBe(true);
      const { sizes } = await readPdf(pdf);
      expect(sizes).toHaveLength(1);
      const [, , width = 0, height = 0] = sizes[0] ?? [];
      // A4 is 210 × 297 mm, 595.3 × 841.9 points.
      expect(Math.abs(width - 595.3)).toBeLessThan(1);
      expect(Math.abs(height - 841.9)).toBeLessThan(1);
    });

    it('detects one changed byte anywhere in a rendered PDF', async () => {
      const pdf = await renderer.render(sampleHtml());
      const fingerprint = sha256Hex(pdf);
      for (const index of [0, pdf.length >> 1, pdf.length - 1]) {
        const changed = Buffer.from(pdf);
        changed[index] = (changed[index] ?? 0) ^ 0x01;
        expect(verifyFingerprint(changed, fingerprint)).toBe(false);
      }
    });

    it('the cedi sign renders, drawn with the embedded Noto Sans', async () => {
      const { text, fonts } = await readPdf(await renderer.render(sampleHtml()));
      expect(text).toContain(format(money(150_000)));
      expect(text).toContain('GH₵1,500.00');
      expect(text).toContain('Esi Ɔforiwaa');
      expect(text).toContain('Demo Lettings Ltd');
      // Only the embedded fonts appear, so no character fell back to a system font.
      expect(fonts.length).toBeGreaterThan(0);
      for (const name of fonts) expect(name).toMatch(/^[A-Z]{6}\+NotoSans-(?:Regular|Bold)$/);
    });

    it('a template that references a remote image still renders, and the request is blocked', async () => {
      const remoteImage = defineTemplate({
        key: 'test.remote-image',
        version: 1,
        title: 'Remote image',
        schema: z.strictObject({ src: z.string() }),
        Component: ({ data, branding }) => (
          <Letterhead branding={branding}>
            <h1>Remote image</h1>
            <img src={data.src} alt="remote" />
          </Letterhead>
        ),
      });
      const html = renderHtml(remoteImage, { src: `${origin}/remote-logo.png` }, sampleBranding);
      const pdf = await renderer.render(html);
      expect(isPdf(pdf)).toBe(true);
      expect((await readPdf(pdf)).text).toContain('Remote image');
      expect(hits).toEqual([]);
    });

    it('refuses every request except data: URIs, even in HTML without the templates’ CSP', async () => {
      const html = `<!doctype html><html><head><meta charset="utf-8">
        <link rel="stylesheet" href="${origin}/style.css">
        <style>body { background: url(${origin}/background.png); }</style></head>
        <body><p>Raw page</p><img src="${origin}/logo.png" alt="">
        <iframe src="${origin}/frame.html"></iframe>
        <img src="data:image/png;base64,${TINY_PNG_BASE64}" alt=""></body></html>`;
      const pdf = await renderer.render(html);
      expect(isPdf(pdf)).toBe(true);
      expect(hits).toEqual([]);
      expect(blocked).toEqual(
        expect.arrayContaining([
          `${origin}/style.css`,
          `${origin}/logo.png`,
          `${origin}/frame.html`,
        ]),
      );
      for (const url of blocked) expect(url.startsWith(origin)).toBe(true);
    });

    it('starts every render from a fresh document, so nothing carries over from the last one', async () => {
      const own = await PdfRenderer.launch({
        poolSize: 1,
        onBlockedRequest: (url) => blocked.push(url),
      });
      try {
        // The template brings a strict Content-Security-Policy. On a reused document it would
        // still apply to the next render and hide that render's requests from the block below.
        await own.render(sampleHtml());
        await own.render(`<!doctype html><body><img src="${origin}/after.png" alt=""></body>`);
        expect(blocked).toEqual([`${origin}/after.png`]);
        expect(hits).toEqual([]);
      } finally {
        await own.close();
      }
    });

    it('renders several documents at once through the pool, each with its own content', async () => {
      const references = ['ACC-LEG-01', 'ACC-LEG-02', 'ACC-OSU-03', 'ACC-OSU-04', 'ACC-TEM-05'];
      const pdfs = await Promise.all(
        references.map((reference) => renderer.render(sampleHtml({ ...sampleData, reference }))),
      );
      for (const [index, pdf] of pdfs.entries()) {
        const { text } = await readPdf(pdf);
        expect(text).toContain(references[index]);
        for (const other of references.filter((_, i) => i !== index))
          expect(text).not.toContain(other);
      }
    });

    it('abandons a render that runs over its timeout, and the next render succeeds', async () => {
      await expect(renderer.render(sampleHtml(), { timeoutMs: 1 })).rejects.toMatchObject({
        name: 'PdfRenderError',
        code: 'timeout',
      });
      expect(isPdf(await renderer.render(sampleHtml()))).toBe(true);
    });

    it('refuses to render once closed', async () => {
      const own = await PdfRenderer.launch({ poolSize: 1 });
      expect(isPdf(await own.render(sampleHtml()))).toBe(true);
      await own.close();
      await own.close();
      await expect(own.render(sampleHtml())).rejects.toMatchObject({ code: 'closed' });
    });

    it('checks its options', async () => {
      await expect(PdfRenderer.launch({ poolSize: 0 })).rejects.toThrow(RangeError);
      await expect(PdfRenderer.launch({ timeoutMs: -1 })).rejects.toThrow(RangeError);
    });
  });
});
