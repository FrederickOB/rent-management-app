import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  return { logger: createLogger({ level: 'trace', destination }), output: () => lines.join('') };
}

const words = fc
  .array(fc.constantFrom('the', 'tap', 'in', 'my', 'kitchen', 'is', 'leaking', 'again', 'please'), {
    minLength: 4,
    maxLength: 12,
  })
  .map((w) => w.join(' '));

describe('CM-05 NFR-SEC messaging log redaction (plan section 6)', () => {
  it('never writes message text, a subject, a caption, a WhatsApp id or an address by field name', () => {
    fc.assert(
      fc.property(
        words,
        fc.constantFrom(
          'text',
          'subject',
          'caption',
          'preview',
          'fullBody',
          'TextBody',
          'StrippedTextReply',
          'filename',
          'whatsappPhone',
          'wa_id',
          'address',
        ),
        (value, key) => {
          const { logger, output } = capture();
          logger.info({ inbound: { [key]: value, channel: 'whatsapp' } }, 'inbound message');
          const written = output();
          expect(written).not.toContain(value);
          expect(written).toContain('whatsapp');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never writes a phone, an email, an email reply address or its token, wherever it appears', () => {
    const replyToken = fc.constant(null).map(() => randomBytes(32).toString('base64url'));
    const value = fc.oneof(
      replyToken.map((t) => `reply+${t}@inbound.rent.invalid`),
      replyToken,
      fc.constantFrom('+233241234567', '233241234567', '0241234567'),
      fc.constantFrom('ama.mensah@example.org', 'kofi@company.com.gh'),
    );
    fc.assert(
      fc.property(
        value,
        fc.constantFrom('message', 'field', 'nested', 'error', 'replyTo', 'replyToken'),
        (v, where) => {
          const { logger, output } = capture();
          if (where === 'message') logger.info(`routing ${v} now`);
          if (where === 'field') logger.info({ detail: `to=${v}` }, 'event');
          if (where === 'nested') logger.info({ outer: { inner: { note: `x ${v} y` } } }, 'event');
          if (where === 'error') logger.error({ err: new Error(`no route for ${v}`) }, 'failure');
          if (where === 'replyTo') logger.info({ replyTo: v }, 'event');
          if (where === 'replyToken') logger.info({ replyToken: v }, 'event');
          const written = output();
          expect(written).not.toContain(v);
          const token = v.startsWith('reply+') ? v.slice(6, v.indexOf('@')) : null;
          if (token) expect(written).not.toContain(token);
        },
      ),
      { numRuns: 300 },
    );
  });
});
