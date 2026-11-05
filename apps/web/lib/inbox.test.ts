import type { ConversationDetail, ConversationSummary, ThreadMessage } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  authorLabel,
  backoffMs,
  conversationTitle,
  durationText,
  eventTouches,
  isInboxView,
  mergeMessages,
  parseStreamEvent,
  responseDueText,
  smsAlternative,
  startingChannel,
  statusReasonText,
  windowStatus,
} from './inbox';
import { replyProblem } from './inbox-reply';

const CONVERSATION = '019a3000-0000-7000-8000-00000000c001';
const MERGED = '019a3000-0000-7000-8000-00000000c002';
const ZONE = 'Africa/Accra';

function message(id: string, createdAt: string, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    conversationId: CONVERSATION,
    direction: 'inbound',
    channel: 'whatsapp',
    authorType: 'tenant',
    authorName: 'Kwame Monthly (demo)',
    purpose: 'inbound',
    subject: null,
    body: `Message ${id}`,
    templateKey: null,
    status: 'received',
    statusReason: null,
    statusAt: createdAt,
    attachments: [],
    attachmentCount: 0,
    costMinor: null,
    currency: null,
    createdAt,
    ...extra,
  };
}

const id = (n: number) => `019a3000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;

describe('CM-05 the thread shows every message once, oldest first', () => {
  it('orders by time, then id, whatever order the pages came in', () => {
    const merged = mergeMessages(
      [message(id(3), '2026-11-04T10:02:00.000Z')],
      [message(id(2), '2026-11-04T10:01:00.000Z'), message(id(1), '2026-11-04T10:01:00.000Z')],
    );
    expect(merged.map((m) => m.id)).toEqual([id(1), id(2), id(3)]);
  });

  it('replaces a message fetched again, such as a new delivery status, and never drops one', () => {
    const sent = message(id(1), '2026-11-04T10:00:00.000Z', {
      direction: 'outbound',
      status: 'sent',
    });
    const delivered = { ...sent, status: 'delivered' as const };
    const merged = mergeMessages([sent, message(id(2), '2026-11-04T10:05:00.000Z')], [delivered]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.status).toBe('delivered');
  });
});

describe('CM-07 the WhatsApp window as the API reported it', () => {
  const now = new Date('2026-11-04T10:00:00.000Z');

  it('counts down to when it closes, naming the time zone', () => {
    const open = windowStatus('2026-11-04T13:12:00.000Z', now, ZONE);
    expect(open.open).toBe(true);
    expect(open.text).toContain('3 h 12 min more');
    expect(open.text).toContain('(Africa/Accra)');
  });

  it('is closed when the API sends none, or the time has passed', () => {
    expect(windowStatus(null, now, ZONE)).toEqual({
      open: false,
      text: 'The WhatsApp window is closed.',
    });
    expect(windowStatus('2026-11-04T09:59:00.000Z', now, ZONE).open).toBe(false);
  });

  it('writes durations for people', () => {
    expect(durationText(0)).toBe('less than a minute');
    expect(durationText(45)).toBe('45 min');
    expect(durationText(120)).toBe('2 h');
    expect(durationText(1_439)).toBe('23 h 59 min');
  });
});

type Channels = Pick<ConversationDetail, 'channels' | 'defaultChannel'>;
const channel = (
  name: ConversationDetail['channels'][number]['channel'],
  mode: ConversationDetail['channels'][number]['mode'],
): ConversationDetail['channels'][number] => ({
  channel: name,
  addressMasked: name === 'email' ? 'k***@example.com' : '+233 20 *** **31',
  consent: name === 'in_app' ? null : { granted: true, source: 'staff', recordedAt: null },
  lastInboundAt: null,
  windowClosesAt: null,
  mode,
  reason: mode === 'unavailable' ? 'no_consent' : mode === 'template_only' ? 'window_closed' : null,
});

describe('plan 4.6 the composer starts on the channel the tenant last used', () => {
  const detail: Channels = {
    channels: [channel('whatsapp', 'template_only'), channel('sms', 'free_text')],
    defaultChannel: 'whatsapp',
  };

  it('starts on the API’s default channel, even when it takes only the template', () => {
    expect(startingChannel(detail, null)).toBe('whatsapp');
  });

  it('keeps the channel the person chose while it is offered', () => {
    expect(startingChannel(detail, 'sms')).toBe('sms');
    expect(startingChannel(detail, 'email')).toBe('whatsapp');
  });

  it('falls back to a free-text channel when there is no default', () => {
    expect(startingChannel({ ...detail, defaultChannel: null }, null)).toBe('sms');
    expect(startingChannel({ channels: [], defaultChannel: null }, null)).toBeNull();
  });

  it('offers SMS outside the window only when SMS takes free text', () => {
    expect(smsAlternative(detail)?.channel).toBe('sms');
    expect(smsAlternative({ channels: [channel('sms', 'unavailable')] })).toBeNull();
  });
});

describe('CM-06 the response target', () => {
  const now = new Date('2026-11-04T10:00:00.000Z');

  it('says how long is left, or since when it is overdue', () => {
    expect(
      responseDueText(
        { firstResponseDueAt: '2026-11-04T12:30:00.000Z', overdue: false },
        now,
        ZONE,
      ),
    ).toMatch(/^Reply due in 2 h 30 min \(by .+\(Africa\/Accra\)\)$/);
    expect(
      responseDueText({ firstResponseDueAt: '2026-11-04T09:00:00.000Z', overdue: true }, now, ZONE),
    ).toMatch(/^Reply overdue since .+\(Africa\/Accra\)$/);
    expect(responseDueText({ firstResponseDueAt: null, overdue: false }, now, ZONE)).toBeNull();
  });
});

describe('plan 4.6 the live stream sends ids only', () => {
  const event = { kind: 'message', conversationId: CONVERSATION, messageId: id(1) };

  it('reads an event and ignores anything else', () => {
    expect(parseStreamEvent(JSON.stringify(event))).toEqual(event);
    expect(parseStreamEvent('')).toBeNull();
    expect(parseStreamEvent('ping')).toBeNull();
    expect(parseStreamEvent(JSON.stringify({ kind: 'other', conversationId: 'x' }))).toBeNull();
    expect(parseStreamEvent(`${JSON.stringify(event)}${' '.repeat(3_000)}`)).toBeNull();
    expect(parseStreamEvent({ data: event })).toBeNull();
  });

  it('matches the thread and the triage conversations merged into it', () => {
    const parsed = parseStreamEvent(JSON.stringify({ ...event, conversationId: MERGED }));
    expect(parsed && eventTouches(parsed, CONVERSATION)).toBe(false);
    expect(parsed && eventTouches(parsed, CONVERSATION, [MERGED])).toBe(true);
  });

  it('reconnects after 1, 2, 4 … seconds, never more than 30, with a little jitter', () => {
    const middle = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffMs(n, middle))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 0.999)).toBeLessThanOrEqual(1_200);
  });
});

describe('CM-05 messages and conversations in words', () => {
  it('names an unknown sender by channel and masked address only', () => {
    const triage = {
      tenant: null,
      triage: { channel: 'whatsapp', addressMasked: '+233 24 *** **56' },
    } as unknown as ConversationSummary;
    expect(conversationTitle(triage)).toBe('Unknown sender on WhatsApp (+233 24 *** **56)');
  });

  it('names the author', () => {
    expect(authorLabel(message(id(1), '2026-11-04T10:00:00.000Z'))).toBe('Kwame Monthly (demo)');
    expect(
      authorLabel(
        message(id(2), '2026-11-04T10:00:00.000Z', {
          direction: 'outbound',
          authorType: 'bot',
          authorName: null,
        }),
      ),
    ).toBe('Assistant');
  });

  it('explains why a message did not go', () => {
    expect(statusReasonText('no_consent')).toBe('no consent on this channel');
    expect(statusReasonText('window_closed')).toBe('the WhatsApp 24-hour window had closed');
    expect(statusReasonText('carrier_rejected')).toBe('carrier rejected');
    expect(statusReasonText(null)).toBeNull();
  });

  it('says a lost answer is safe to send again, and a refusal is not retried as the same', () => {
    expect(replyProblem(new TypeError('fetch failed'))).toContain('it will not go twice');
    expect(
      replyProblem({ status: 422, data: { body: { code: 'window_closed', message: 'Closed.' } } }),
    ).toBe('Closed.');
  });

  it('knows the inbox views', () => {
    expect(isInboxView('mine')).toBe(true);
    expect(isInboxView('everything')).toBe(false);
    expect(isInboxView(undefined)).toBe(false);
  });
});
