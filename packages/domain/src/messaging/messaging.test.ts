import { describe, expect, it } from 'vitest';
import {
  chooseChannel,
  consentGranted,
  consentText,
  needsConsent,
  redactLinkTokens,
  type MessageChannel,
} from './messaging';

const reach = (addresses: MessageChannel[], consented: MessageChannel[]) => ({
  addresses: new Set(addresses),
  consented: new Set(consented),
});

describe('CM-09 consent groundwork', () => {
  it('sends a business-initiated message only on a channel with consent, SMS first', () => {
    expect(chooseChannel('signing_link', reach(['sms', 'email'], ['sms', 'email']))).toBe('sms');
    expect(chooseChannel('signing_link', reach(['sms', 'email'], ['email']))).toBe('email');
    expect(chooseChannel('signing_link', reach(['sms'], ['email']))).toBeNull();
    expect(chooseChannel('signing_link', reach(['sms', 'email'], []))).toBeNull();
  });

  it('moves to the next consented channel when one fails, and exempts staff notices', () => {
    const both = reach(['sms', 'email'], ['sms', 'email']);
    expect(chooseChannel('signing_reminder', both, new Set(['sms']))).toBe('email');
    expect(chooseChannel('signing_reminder', both, new Set(['sms', 'email']))).toBeNull();
    expect(needsConsent('staff_notice')).toBe(false);
    expect(chooseChannel('staff_notice', reach(['email'], []))).toBe('email');
    expect(needsConsent('signed_copy')).toBe(true);
  });

  it('takes the latest event on a channel as the current consent', () => {
    expect(consentGranted([])).toBe(false);
    expect(consentGranted([{ action: 'grant' }])).toBe(true);
    expect(consentGranted([{ action: 'grant' }, { action: 'withdraw' }])).toBe(false);
    expect(consentGranted([{ action: 'withdraw' }, { action: 'grant' }])).toBe(true);
  });

  it('names the channel in the versioned consent text', () => {
    expect(consentText('messages.v1', 'sms')).toContain('by SMS.');
    expect(consentText('messages.v1', 'email')).toContain('by email.');
    expect(() => consentText('messages.v0', 'sms')).toThrow();
  });

  it('never stores a live link token in a message body', () => {
    const token = 'Zq3s9X_aB-7cD2eF4gH6iJ8kL0mN1oP3qR5sT7uV9wY';
    expect(redactLinkTokens(`Sign here: https://links.example/l/${token} today`)).toBe(
      'Sign here: https://links.example/l/[link] today',
    );
    expect(redactLinkTokens('No link here')).toBe('No link here');
  });
});
