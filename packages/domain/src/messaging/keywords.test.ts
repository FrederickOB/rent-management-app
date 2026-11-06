import { describe, expect, it } from 'vitest';
import { instantFrom } from '../dates';
import { isAffirmative, keywordEffect, optOutConfirmationText, parseKeyword } from './keywords';
import { landlordChoice, landlordQuestion, routeInbound } from './routing';

describe('CM-09 STOP, STOP ALL, UNSUBSCRIBE and START (decision 7)', () => {
  it('recognises the keywords on their own, in any case, with stray punctuation', () => {
    expect(parseKeyword('STOP')).toEqual({ kind: 'stop', scope: 'channel' });
    expect(parseKeyword('  stop. ')).toEqual({ kind: 'stop', scope: 'channel' });
    expect(parseKeyword('Unsubscribe!')).toEqual({ kind: 'stop', scope: 'channel' });
    expect(parseKeyword('stop   all')).toEqual({ kind: 'stop', scope: 'all' });
    expect(parseKeyword('UNSUBSCRIBE ALL')).toEqual({ kind: 'stop', scope: 'all' });
    expect(parseKeyword('Start')).toEqual({ kind: 'start' });
  });

  it('does not treat a sentence that mentions stop as an opt-out', () => {
    for (const text of ['please stop the noise', 'STOPPED', 'stop it now', '', null, 'start date?'])
      expect(parseKeyword(text), String(text)).toBeNull();
  });

  it('withdraws the channel it came on, every channel for STOP ALL, and START grants it back', () => {
    expect(keywordEffect({ kind: 'stop', scope: 'channel' }, 'whatsapp')).toEqual({
      action: 'withdraw',
      channels: ['whatsapp'],
    });
    expect(keywordEffect({ kind: 'stop', scope: 'all' }, 'sms')).toEqual({
      action: 'withdraw',
      channels: ['push', 'whatsapp', 'sms', 'email'],
    });
    expect(keywordEffect({ kind: 'start' }, 'sms')).toEqual({ action: 'grant', channels: ['sms'] });
    // Typed in the app: push is the app's own toggle (decision 5).
    expect(keywordEffect({ kind: 'stop', scope: 'channel' }, 'in_app').channels).toEqual([]);
    expect(keywordEffect({ kind: 'start' }, 'in_app').channels).toEqual([]);
  });

  it('confirms once, saying how to stop the other channels and how to start again', () => {
    const text = optOutConfirmationText({
      companyName: 'Osu Properties',
      keyword: { kind: 'stop', scope: 'channel' },
      arrivedOn: 'whatsapp',
    });
    expect(text).toContain('Osu Properties on WhatsApp');
    expect(text).toContain('STOP ALL');
    expect(text).toContain('START');
    expect(
      optOutConfirmationText({
        companyName: 'Osu Properties',
        keyword: { kind: 'stop', scope: 'all' },
        arrivedOn: 'sms',
      }),
    ).toContain('any channel');
  });

  it('reads YES as agreement to WhatsApp messages (plan 4.8), and nothing else', () => {
    expect(isAffirmative('yes')).toBe(true);
    expect(isAffirmative('Y')).toBe(true);
    expect(isAffirmative('Yes please!')).toBe(true);
    expect(isAffirmative('yes but not now')).toBe(false);
    expect(isAffirmative(null)).toBe(false);
  });
});

describe('CM-01 shared-number routing (decision 4; TL-12)', () => {
  const now = instantFrom('2026-11-04T08:00:00Z');
  const hoursAgo = (h: number) => now.subtract({ hours: h });

  it('gives a company number’s messages to that company', () => {
    expect(
      routeInbound({
        number: { kind: 'company', companyId: 'c-agency' },
        recentOutbound: [{ companyId: 'c-other', at: hoursAgo(1) }],
        knownIn: ['c-other'],
        now,
      }),
    ).toEqual({ kind: 'company', companyId: 'c-agency', basis: 'company_number' });
  });

  it('on the shared number, first the company that messaged this phone in the last 24 hours', () => {
    expect(
      routeInbound({
        number: { kind: 'shared' },
        recentOutbound: [
          { companyId: 'c-a', at: hoursAgo(5) },
          { companyId: 'c-b', at: hoursAgo(2) },
        ],
        knownIn: ['c-a', 'c-b'],
        now,
      }),
    ).toEqual({ kind: 'company', companyId: 'c-b', basis: 'recent_outbound' });
  });

  it('then the only company that knows the phone; then asks among only those that do', () => {
    expect(
      routeInbound({
        number: { kind: 'shared' },
        recentOutbound: [{ companyId: 'c-a', at: hoursAgo(25) }],
        knownIn: ['c-a'],
        now,
      }),
    ).toEqual({ kind: 'company', companyId: 'c-a', basis: 'only_company' });
    expect(
      routeInbound({
        number: { kind: 'shared' },
        recentOutbound: [{ companyId: 'c-a', at: hoursAgo(30) }],
        knownIn: ['c-b', 'c-a', 'c-b'],
        now,
      }),
    ).toEqual({ kind: 'ask', companyIds: ['c-a', 'c-b'] });
  });

  it('sends an unknown phone on the shared number to the platform triage, naming no company', () => {
    expect(
      routeInbound({ number: { kind: 'shared' }, recentOutbound: [], knownIn: [], now }),
    ).toEqual({ kind: 'triage', companyId: null });
  });

  it('asks which landlord with only the offered names, and accepts only an offered answer', () => {
    const offered = [
      { companyId: 'c-a', name: 'Osu Properties' },
      { companyId: 'c-b', name: 'Kwame Mensah' },
    ];
    const question = landlordQuestion(offered);
    expect(question.text).toContain('1 Osu Properties');
    expect(question.text).toContain('2 Kwame Mensah');
    expect(question.choices.map((c) => c.id)).toEqual(['landlord:c-a', 'landlord:c-b']);
    const ids = offered.map((o) => o.companyId);
    expect(landlordChoice({ text: '2' }, ids)).toBe('c-b');
    expect(landlordChoice({ choiceId: 'landlord:c-a' }, ids)).toBe('c-a');
    expect(landlordChoice({ choiceId: 'landlord:c-z' }, ids)).toBeNull();
    expect(landlordChoice({ text: '3' }, ids)).toBeNull();
    expect(landlordChoice({ text: '1 please' }, ids)).toBeNull();
  });
});
