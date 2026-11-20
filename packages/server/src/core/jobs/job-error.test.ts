import { describe, expect, it } from 'vitest';
import { jobErrorSummary } from './job-error';

/** M11 decision 9: why a job failed, as the console and the inbox row show it. */
describe('NFR-SEC a failed job’s error is a code and a short message, never personal data', () => {
  it('takes the code, else the error’s name, and the first line of the message', () => {
    expect(
      jobErrorSummary({ name: 'AppError', code: 'provider_unavailable', message: 'Down' }),
    ).toBe('provider_unavailable: Down');
    expect(
      jobErrorSummary({ name: 'ProviderError', message: 'request failed (TimeoutError)\nat x' }),
    ).toBe('ProviderError: request failed (TimeoutError)');
    expect(jobErrorSummary({ message: 'no name' })).toBe('error: no name');
    expect(jobErrorSummary({ name: 'Error' })).toBe('Error');
    expect(jobErrorSummary('plain text')).toBe('plain text');
    expect(jobErrorSummary(null)).toBeNull();
  });

  it('scrubs phones, emails and tokens, and stays short', () => {
    const summary = jobErrorSummary({
      name: 'Error',
      message: `could not reach +233 20 000 0101 or ama@example.com with ${'a'.repeat(40)}`,
      stack: 'Error: secret stack',
    })!;
    expect(summary).not.toMatch(/233|ama@|aaaa|stack/);
    expect(summary).toContain('[PHONE]');
    expect(summary).toContain('[EMAIL]');
    expect(
      jobErrorSummary({ name: 'Error', message: 'x'.repeat(1_000) })!.length,
    ).toBeLessThanOrEqual(200);
  });
});
