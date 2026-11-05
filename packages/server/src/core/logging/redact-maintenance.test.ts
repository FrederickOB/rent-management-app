import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
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

describe('MI-04 NFR-SEC log redaction for artisans and job sheets (M8 plan section 6)', () => {
  it('never writes an artisan’s phone or a job-sheet token, by field name or inside a message', () => {
    const { logger, output } = capture();
    const token = randomBytes(32).toString('base64url');
    const phone = '+233244111222';
    logger.info({ phone, token, artisan: { phone } }, 'artisan added');
    logger.info({ url: `https://links.example/j/${token}` }, `job sheet sent to ${phone}`);
    logger.warn(`code for the job sheet at /j/${token} went to ${phone}`);
    const text = output();
    expect(text).not.toContain(token);
    expect(text).not.toContain(phone);
    expect(text).not.toContain('244111222');
  });
});
