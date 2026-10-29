import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkGhanaCard, checkPassport, checkTin } from '@rent/domain/tenancy';
import { createLogger } from './logger';
import { scrubString } from './redact';

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

  it('never writes a passport number or a TIN, wherever it appears (M3 plan 4.4)', () => {
    const letters = (min: number, max: number) =>
      fc.stringMatching(new RegExp(`^[A-Z]{${min},${max}}$`));
    const passport = fc
      .tuple(letters(1, 2), fc.integer({ min: 6, max: 9 }))
      .chain(([prefix, n]) => digits(n).map((d) => `${prefix}${d}`));
    const tin = fc
      .tuple(fc.constantFrom('C', 'P', 'G', 'Q', 'V'), digits(10))
      .map(([prefix, d]) => `${prefix}${d}`);
    fc.assert(
      fc.property(
        fc.oneof(passport, tin),
        fc.constantFrom('message', 'field', 'nested', 'error', 'array'),
        (value, where) => {
          const { logger, output } = capture();
          if (where === 'message') logger.info(`checking ${value} now`);
          if (where === 'field') logger.info({ detail: `number=${value}` }, 'event');
          if (where === 'nested')
            logger.info({ outer: { inner: { note: `x ${value} y` } } }, 'event');
          if (where === 'error') logger.error({ err: new Error(`failed for ${value}`) }, 'failure');
          if (where === 'array') logger.info({ list: ['a', `b ${value}`] }, 'event');
          expect(output()).not.toContain(value);
        },
      ),
      { numRuns: 400 },
    );
    const { logger, output } = capture();
    logger.info({ passport: 'A1234567', tin: 'C0012345678', passportNumber: 'x' }, 'event');
    const written = JSON.parse(output()) as Record<string, unknown>;
    for (const key of ['passport', 'tin', 'passportNumber'])
      expect(written[key]).toBe('[REDACTED]');
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

describe('TL-02 log redaction covers every ID number and TIN the domain accepts', () => {
  /** What the logger wrote, without the time pino adds itself (it is not scrubbed and can contain anything). */
  function written(output: string): string {
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const { time: _time, ...rest } = JSON.parse(line) as Record<string, unknown>;
        return JSON.stringify(rest);
      })
      .join('\n');
  }

  // Generated from everything the domain's own checks accept, in the form they return it: the
  // number the product stores, masks and could put in a message.
  const ghanaCardInput = fc
    .tuple(digits(9), digits(1), fc.constantFrom('GHA-%-#', 'gha%#', 'GHA %-#', 'Gha-% #'))
    .map(([nine, check, shape]) => shape.replace('%', nine).replace('#', check));
  const ghanaCard = ghanaCardInput.map((input) => checkGhanaCard(input));
  const passport = fc
    .stringMatching(/^[A-Za-z0-9]{6,12}$/)
    .map((input) => checkPassport(input, 'NG').number);
  // An ISO date is also a valid TIN ("2026-10-29"); dates must survive in logs, so the property
  // leaves out the TINs that are written exactly like one. No real TIN is.
  const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const tin = fc
    .oneof(fc.stringMatching(/^[A-Za-z0-9-]{6,20}$/), ghanaCardInput)
    .map((input) => checkTin(input))
    .filter((value) => !ISO_DATE.test(value));
  const idNumber = fc.oneof(passport, tin, ghanaCard);
  const contexts = [
    (v: string) => `checking ${v} now`,
    (v: string) => `number=${v}`,
    (v: string) => `(${v}).`,
    (v: string) => `"${v}",`,
    (v: string) => `id:${v};`,
  ];

  it('never writes one, wherever it appears in free text (property-based)', () => {
    fc.assert(
      fc.property(
        idNumber,
        fc.constantFrom(0, 1, 2, 3, 4),
        fc.constantFrom('message', 'field', 'nested', 'error', 'array'),
        (value, shape, where) => {
          const text = contexts[shape]!(value);
          const { logger, output } = capture();
          if (where === 'message') logger.info(text);
          if (where === 'field') logger.info({ detail: text }, 'event');
          if (where === 'nested') logger.info({ outer: { inner: { note: text } } }, 'event');
          if (where === 'error') logger.error({ err: new Error(`failed for ${text}`) }, 'failure');
          if (where === 'array') logger.info({ list: ['a', text] }, 'event');
          expect(written(output())).not.toContain(value);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('keeps the UUIDs, ISO dates and timestamps logs need, next to what it scrubs (property-based)', () => {
    const instant = fc.date({
      min: new Date('1990-01-01T00:00:00Z'),
      max: new Date('2099-12-31T23:59:59Z'),
      noInvalidDate: true,
    });
    const timestamp = fc
      .tuple(instant, fc.constantFrom('iso', 'seconds', 'offset', 'postgres'))
      .map(([d, shape]) => {
        const iso = d.toISOString();
        if (shape === 'seconds') return `${iso.slice(0, 19)}Z`;
        if (shape === 'offset') return `${iso.slice(0, 23)}+00:00`;
        if (shape === 'postgres') return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00`;
        return iso;
      });
    const uuid = fc.oneof(
      fc.uuid(),
      fc.uuid().map((u) => u.toUpperCase()),
    );
    fc.assert(
      fc.property(
        uuid,
        instant.map((d) => d.toISOString().slice(0, 10)),
        timestamp,
        fc.oneof(idNumber, phone, email, otp),
        (id, date, at, secret) => {
          const { logger, output } = capture();
          logger.info(
            { requestId: id, note: `on ${date} at ${at} for ${secret}`, job: `job:${id}:${date}` },
            `job ${id} ran at ${at} (${date})`,
          );
          const out = written(output());
          for (const kept of [id, date, at]) expect(out).toContain(kept);
          expect(out).not.toContain(secret);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('scrubs text the same way twice, so its own placeholders survive a second pass', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(idNumber, phone, email, otp, token), { maxLength: 4 }),
        (values) => {
          const text = `a ${values.join(' b ')} c [REDACTED] d`;
          const once = scrubString(text);
          expect(scrubString(once)).toBe(once);
        },
      ),
    );
  });
});
