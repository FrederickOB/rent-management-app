import { formatInstant, instantFrom } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineTemplate,
  DocumentError,
  renderTemplateHtml,
  systemSampleV1,
  TemplateRegistry,
  templates,
} from './index';
import { sampleBranding, sampleData } from './test-fixtures';

const render = (data: unknown = sampleData, branding = sampleBranding) =>
  renderTemplateHtml('system.sample', 1, data, branding);

function failure(run: () => unknown): DocumentError {
  try {
    run();
  } catch (error) {
    if (error instanceof DocumentError) return error;
    throw error;
  }
  throw new Error('expected a DocumentError');
}

describe('PLATFORM documents', () => {
  describe('templates', () => {
    it('system.sample shows the amount with money.format and the instant with formatInstant', () => {
      const html = render();
      expect(format(money(150_000))).toBe('GH₵1,500.00');
      expect(html).toContain('<td class="amount">GH₵1,500.00</td>');
      expect(html).toContain(formatInstant(instantFrom('2026-10-28T14:05:00Z'), 'Africa/Accra'));
      expect(html).toContain('(Africa/Accra)');
      expect(html).toContain('Prepared for Esi Ɔforiwaa');
    });

    it('the letterhead carries the logo, the colours and the sender name', () => {
      const html = render();
      expect(html).toContain(`src="${sampleBranding.logoDataUri}"`);
      expect(html).toContain('alt="Demo Lettings Ltd logo"');
      expect(html).toContain('<div class="sender">Demo Lettings Ltd</div>');
      expect(html).toContain('style="--brand-primary:#0F766E;--brand-accent:#F59E0B"');
      const withoutLogo = render(sampleData, { ...sampleBranding, logoDataUri: undefined });
      expect(withoutLogo).not.toContain('<img');
    });

    it('embeds both fonts as base64 and A4 print CSS', () => {
      const html = render();
      expect(html.match(/@font-face\{font-family:'Noto Sans'/g)).toHaveLength(2);
      expect(html).toContain('src:url(data:font/ttf;base64,');
      expect(html).toContain('@page { size: A4;');
      expect(html).toContain('print-color-adjust: exact');
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('<title>Sample document</title>');
    });

    it('refers to nothing outside the document', () => {
      const html = render();
      expect(html).not.toMatch(/https?:|file:|ftp:|\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
      const references = [
        ...html.matchAll(
          /(?:url\(\s*['"]?|\b(?:src|href|srcset|poster|action)\s*=\s*['"]?)([^'")\s>]*)/gi,
        ),
      ].map((match) => match[1] ?? '');
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references)
        expect(reference.startsWith('data:'), reference).toBe(true);
      expect(html).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">`,
      );
    });

    it('escapes text from the data', () => {
      const html = render({ ...sampleData, recipientName: '<script>alert("x")</script>' });
      expect(html).not.toContain('<script>');
      expect(html).toContain('Prepared for &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    });

    it.each([
      ['a fractional amount', { amountMinor: 1500.5 }, 'amountMinor'],
      ['an amount as text', { amountMinor: '150000' }, 'amountMinor'],
      ['an amount beyond the safe integers', { amountMinor: 2 ** 53 }, 'amountMinor'],
      ['another currency', { currency: 'USD' }, 'currency'],
      ['a time without an instant', { issuedAt: '28 October 2026' }, 'issuedAt'],
      ['an unknown time zone', { timeZone: 'Mars/Olympus_Mons' }, 'timeZone'],
      ['an empty name', { recipientName: '' }, 'recipientName'],
      ['a field the template does not know', { note: 'extra' }, 'note'],
    ])('rejects %s', (_, change, field) => {
      const error = failure(() => render({ ...sampleData, ...change }));
      expect(error.code).toBe('invalid_data');
      expect(error.issues.join(' ')).toContain(field);
      // Data holds names and amounts, so errors (which reach logs) describe fields, not values.
      for (const value of Object.values(change).map(String)) {
        if (value.length > 0) expect(error.message).not.toContain(value);
      }
    });

    it('rejects data with a field missing', () => {
      const { issuedAt: _, ...withoutIssuedAt } = sampleData;
      const error = failure(() => render(withoutIssuedAt));
      expect(error.code).toBe('invalid_data');
      expect(error.issues.join(' ')).toContain('issuedAt');
    });

    it.each([
      ['a colour that would escape into CSS', { primaryColour: 'red;}body{display:none' }],
      ['a named colour', { accentColour: 'orange' }],
      ['a logo on another server', { logoDataUri: 'https://example.com/logo.png' }],
      [
        'an SVG logo, which can carry script',
        { logoDataUri: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
      ],
      ['an empty sender name', { senderName: '' }],
    ])('rejects branding with %s', (_, change) => {
      expect(failure(() => render(sampleData, { ...sampleBranding, ...change })).code).toBe(
        'invalid_branding',
      );
    });

    it('finds a template by key and version only', () => {
      expect(templates.get('system.sample', 1)).toBe(systemSampleV1);
      expect(
        failure(() => renderTemplateHtml('system.sample', 2, sampleData, sampleBranding)).code,
      ).toBe('template_not_found');
      expect(
        failure(() => renderTemplateHtml('system.missing', 1, sampleData, sampleBranding)).code,
      ).toBe('template_not_found');
      expect(templates.list()).toContainEqual({
        key: 'system.sample',
        version: 1,
        title: 'Sample document',
      });
    });

    it('a registry refuses a second template with the same key and version', () => {
      expect(failure(() => new TemplateRegistry([systemSampleV1, systemSampleV1])).code).toBe(
        'template_exists',
      );
    });

    it('template keys and versions are checked', () => {
      const definition = {
        key: 'test.sample',
        version: 1,
        title: 'Test',
        schema: z.strictObject({}),
        Component: () => <p>test</p>,
      };
      expect(defineTemplate(definition).key).toBe('test.sample');
      expect(failure(() => defineTemplate({ ...definition, key: 'Test Sample' })).code).toBe(
        'invalid_template',
      );
      expect(failure(() => defineTemplate({ ...definition, key: 'sample' })).code).toBe(
        'invalid_template',
      );
      expect(failure(() => defineTemplate({ ...definition, version: 0 })).code).toBe(
        'invalid_template',
      );
      expect(failure(() => defineTemplate({ ...definition, version: 1.5 })).code).toBe(
        'invalid_template',
      );
    });
  });
});
