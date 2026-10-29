import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

/** Captures everything the logger writes. */
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

const digits = (n: number) =>
  fc.array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n }).map((d) => d.join(''));

// Ghanaian mobile numbers in the forms people type: E.164, with spaces, and local 0XX.
const phone = fc
  .tuple(fc.constantFrom('20', '24', '26', '27', '50', '54', '55', '59'), digits(7))
  .chain(([prefix, rest]) =>
    fc.constantFrom(
      `+233${prefix}${rest}`,
      `+233 ${prefix} ${rest.slice(0, 3)} ${rest.slice(3)}`,
      `0${prefix}${rest}`,
      `0${prefix} ${rest.slice(0, 3)} ${rest.slice(3)}`,
      `233${prefix}${rest}`,
    ),
  );
const email = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9.]{2,12}$/),
    fc.constantFrom('gmail.com', 'example.org', 'company.com.gh'),
  )
  .map(([user, domain]) => `${user}@${domain}`);
const otp = digits(6);
const ghanaCard = digits(9).chain((d) => digits(1).map((check) => `GHA-${d}-${check}`));
const token = fc.constant(null).map(() => randomBytes(32).toString('base64url'));
const secret = fc.oneof(phone, email, otp, ghanaCard, token);

describe('NFR-SEC log redaction', () => {
  it('never writes a phone number, email, one-time code, token or Ghana Card number, wherever it appears', () => {
    fc.assert(
      fc.property(
        secret,
        fc.constantFrom('message', 'field', 'nested', 'error', 'path', 'array'),
        (value, where) => {
          const { logger, output } = capture();
          if (where === 'message') logger.info(`sending to ${value} now`);
          if (where === 'field') logger.info({ detail: `value=${value}` }, 'event');
          if (where === 'nested')
            logger.info({ outer: { inner: { note: `x ${value} y` } } }, 'event');
          if (where === 'error') logger.error({ err: new Error(`failed for ${value}`) }, 'failure');
          if (where === 'path') logger.info({ route: `/l/${value}` }, 'request');
          if (where === 'array') logger.info({ list: ['a', `b ${value}`] }, 'event');
          const written = output();
          expect(written).not.toContain(value);
          // Digits-only forms must not survive either (for example a phone number without its +).
          expect(written).not.toContain(
            value.replace(/[^0-9]/g, '').length >= 9 ? value.replace(/[^0-9]/g, '') : '\u0000',
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it('drops sensitive fields by name, whatever their value', () => {
    const { logger, output } = capture();
    logger.info(
      {
        phoneNumber: 'abc',
        password: 'hunter2hunter2',
        body: { anything: 1 },
        authorization: 'Bearer x',
        code: 'zzz',
        idNumber: '123',
      },
      'event',
    );
    const written = JSON.parse(output()) as Record<string, unknown>;
    for (const key of ['phoneNumber', 'password', 'body', 'authorization', 'code', 'idNumber'])
      expect(written[key]).toBe('[REDACTED]');
  });

  it('keeps ids, routes and amounts that are not personal data', () => {
    const { logger, output } = capture();
    const requestId = '01a1841a-0137-7246-bed9-bc7edf0351c8';
    logger.info({ requestId, route: '/me', status: 200, amountMinor: 150000 }, 'request');
    const written = JSON.parse(output()) as Record<string, unknown>;
    expect(written).toMatchObject({ requestId, route: '/me', status: 200, amountMinor: 150000 });
  });
});
