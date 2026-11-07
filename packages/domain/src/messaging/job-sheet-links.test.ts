import { describe, expect, it } from 'vitest';
import { redactLinkTokens } from './messaging';

describe('MI-04 an artisan’s job-sheet link is never stored live (M8 decision 6)', () => {
  it('redacts the token of a /j/ link as it does the other secure links', () => {
    const token = 'Zq3s9X_aB-7cD2eF4gH6iJ8kL0mN1oP3qR5sT7uV9wY';
    expect(
      redactLinkTokens(`See the job and reply at https://links.example/j/${token} please`),
    ).toBe('See the job and reply at https://links.example/j/[link] please');
    // A short path that is not a token, and other letters, stay as they are.
    expect(redactLinkTokens('Go to /j/help or /x/' + token)).toBe('Go to /j/help or /x/' + token);
  });
});
