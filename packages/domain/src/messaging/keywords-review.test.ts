import { describe, expect, it } from 'vitest';
import {
  appKeywordEffect,
  appOptOutConfirmationText,
  parseKeyword,
  sharedOptOutConfirmationText,
} from './keywords';

describe('CM-09 keywords in the app and on the shared number (M6 review M2, MF-1)', () => {
  it('stops SMS from the app with STOP, every channel with STOP ALL, and gives SMS back with START', () => {
    expect(appKeywordEffect(parseKeyword('stop')!)).toEqual({
      action: 'withdraw',
      channels: ['sms'],
    });
    expect(appKeywordEffect(parseKeyword('STOP ALL')!)).toEqual({
      action: 'withdraw',
      channels: ['push', 'whatsapp', 'sms', 'email'],
    });
    expect(appKeywordEffect(parseKeyword('Start')!)).toEqual({
      action: 'grant',
      channels: ['sms'],
    });
    expect(
      appOptOutConfirmationText({ companyName: 'Osu Ridge', keyword: parseKeyword('STOP')! }),
    ).toContain('Osu Ridge');
  });

  it('names no landlord in the shared confirmation', () => {
    for (const word of ['STOP', 'STOP ALL', 'START'])
      for (const channel of ['whatsapp', 'sms'] as const) {
        const text = sharedOptOutConfirmationText({
          keyword: parseKeyword(word)!,
          arrivedOn: channel,
        });
        expect(text).not.toMatch(/Osu|Ridge|Kwabena/);
        expect(text.length).toBeGreaterThan(20);
      }
  });
});
