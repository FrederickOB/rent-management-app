import type { Broadcast } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  audienceOf,
  broadcastErrors,
  draftKey,
  EMPTY_BROADCAST,
  isAudienceChanged,
  reachText,
  sendLabel,
  statRows,
  type BroadcastDraft,
} from './broadcasts';

const PROPERTY = '019a3000-0000-7000-8000-0000000000c1';
const BLOCK = '019a3000-0000-7000-8000-0000000000d1';
const GROUP = '019a3000-0000-7000-8000-0000000000e1';

const ready: BroadcastDraft = {
  ...EMPTY_BROADCAST,
  propertyId: PROPERTY,
  topic: 'Water supply',
  body: 'The water will be off on Saturday from 9 to 12.',
};

describe('CM-08 a broadcast needs an audience, a topic and a message before its preview', () => {
  it('names what is missing', () => {
    expect(broadcastErrors(EMPTY_BROADCAST)).toEqual({
      audience: 'Choose a property',
      topic: 'Say what it is about in 2 to 60 characters, such as “water supply”',
      body: 'Write the message',
    });
    expect(broadcastErrors({ ...ready, kind: 'blocks' })).toEqual({
      audience: 'Choose at least one block',
    });
    expect(broadcastErrors({ ...ready, kind: 'group' })).toEqual({
      audience: 'Choose a tenant group',
    });
    expect(broadcastErrors({ ...ready, body: 'x'.repeat(1_001) })).toEqual({
      body: 'Use at most 1,000 characters',
    });
    expect(broadcastErrors(ready)).toEqual({});
  });

  it('sends the audience the API takes, and nothing while it is incomplete', () => {
    expect(audienceOf(ready)).toEqual({ kind: 'property', propertyId: PROPERTY });
    expect(audienceOf({ ...ready, kind: 'blocks', blockIds: [BLOCK] })).toEqual({
      kind: 'blocks',
      propertyId: PROPERTY,
      blockIds: [BLOCK],
    });
    expect(audienceOf({ ...ready, kind: 'group', groupId: GROUP })).toEqual({
      kind: 'group',
      groupId: GROUP,
    });
    expect(audienceOf({ ...ready, kind: 'blocks' })).toBeNull();
  });

  it('needs a new preview when the audience or the text changes', () => {
    const key = draftKey(ready);
    expect(draftKey({ ...ready, topic: ' Water supply ' })).toBe(key);
    expect(draftKey({ ...ready, body: `${ready.body} Sorry.` })).not.toBe(key);
    expect(draftKey({ ...ready, kind: 'group', groupId: GROUP })).not.toBe(key);
    // A group chosen earlier does not matter while the audience is a property.
    expect(draftKey({ ...ready, groupId: GROUP })).toBe(key);
  });

  it('recognises the 409 for a preview that is out of date', () => {
    expect(isAudienceChanged({ status: 409, data: { body: { code: 'audience_changed' } } })).toBe(
      true,
    );
    expect(isAudienceChanged({ status: 409, code: 'CONFLICT' })).toBe(false);
  });

  it('says who it reaches', () => {
    expect(reachText({ audienceCount: 14, reachableCount: 12 })).toBe(
      '12 of 14 tenants can be reached.',
    );
    expect(reachText({ audienceCount: 1, reachableCount: 0 })).toBe(
      '0 of 1 tenant can be reached.',
    );
    expect(sendLabel(12)).toBe('Send to 12 tenants');
    expect(sendLabel(1)).toBe('Send to 1 tenant');
  });
});

const counts = (over: Partial<Broadcast['stats']['byChannel']['sms']> = {}) => ({
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  notSent: 0,
  ...over,
});

describe('CM-08 delivery stats per channel', () => {
  it('lists the channels used, then a total that adds up to the audience', () => {
    const stats: Broadcast['stats'] = {
      ...counts({ delivered: 3, read: 4, failed: 1, notSent: 2 }),
      byChannel: {
        push: counts(),
        whatsapp: counts({ delivered: 2, read: 4 }),
        sms: counts({ delivered: 1, failed: 1 }),
        email: counts({ notSent: 2 }),
      },
    };
    const rows = statRows(stats);
    expect(rows.map((r) => r.label)).toEqual(['WhatsApp', 'SMS', 'Email', 'Total']);
    const total = rows.at(-1)!;
    expect(total.delivered + total.read + total.failed + total.notSent).toBe(10);
  });
});
