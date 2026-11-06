import { describe, expect, it } from 'vitest';
import { payLinkOutcome, payLinkRoute, PAY_LINK_PROBLEM_LABELS } from './collection';
import { msUntil, plainClick, refreshedRows, tagChoices } from './inbox';
import { replyContent, replyProblem, replyRefusal } from './inbox-reply';
import { fallbackPollMs } from './inbox-stream';
import { consentHistoryText } from './messaging-consent';
import { deliveryLine } from './receipt-delivery';
import { sseParser, streamVerdict, type SseEvent } from './sse';
import { timelineDetail } from './tenancy-format';
import { messageHeadline, messageOfEvent, type TimelineEvent } from './timeline';

// The M6 review round's fixes in apps/web (review findings W1 to W13, E2, C1 to C5).

const ACCRA = 'Africa/Accra';

describe('plan 4.6 and review W9 the live stream is read with fetch', () => {
  it('dispatches each event once, whatever its name, across chunks and line endings', () => {
    const events: SseEvent[] = [];
    const parser = sseParser((event) => events.push(event));
    parser.push(': connected\n\n');
    parser.push('event: message\ndata: {"a"');
    parser.push(':1}\n\nevent: conversation\r\ndata: x\r');
    parser.push('\n\r\n');
    parser.push('data: one\ndata: two\n\n');
    parser.push('retry: 3000\nid: 7\n\n');
    expect(events).toEqual([
      { type: 'message', data: '{"a":1}' },
      { type: 'conversation', data: 'x' },
      { type: 'message', data: 'one\ntwo' },
    ]);
  });

  it('stops on a refusal, follows the session states, and retries anything else', () => {
    expect(streamVerdict(200, null)).toBe('open');
    expect(streamVerdict(401, null)).toBe('sign_in');
    expect(streamVerdict(403, 'NOT_ON_PLAN')).toBe('stop');
    expect(streamVerdict(403, 'not_on_plan')).toBe('stop');
    expect(streamVerdict(403, 'forbidden')).toBe('stop');
    expect(streamVerdict(403, 'enrolment_required')).toBe('enrol');
    expect(streamVerdict(403, 'COMPANY_REQUIRED')).toBe('choose_company');
    expect(streamVerdict(502, null)).toBe('retry');
    expect(streamVerdict(429, null)).toBe('retry');
  });

  it('polls only while (re)connecting, backing off to a minute', () => {
    expect(fallbackPollMs('live', 0)).toBeNull();
    expect(fallbackPollMs('paused', 3)).toBeNull();
    expect(fallbackPollMs('stopped', 3)).toBeNull();
    expect(fallbackPollMs('connecting', 0)).toBe(5_000);
    expect(fallbackPollMs('reconnecting', 1)).toBe(5_000);
    expect(fallbackPollMs('reconnecting', 2)).toBe(10_000);
    expect(fallbackPollMs('reconnecting', 3)).toBe(20_000);
    expect(fallbackPollMs('reconnecting', 30)).toBe(60_000);
  });
});

describe('review W4 and C5 a reply’s clientMessageId stands for one reply', () => {
  const base = { channel: 'whatsapp', template: false, body: 'Hello', subject: '' };

  it('is the same for a retry, and new for a changed text, channel or template', () => {
    const key = replyContent(base);
    expect(replyContent({ ...base, body: ' Hello ' })).toBe(key);
    expect(replyContent({ ...base, body: 'Hello!' })).not.toBe(key);
    expect(replyContent({ ...base, channel: 'sms' })).not.toBe(key);
    expect(replyContent({ ...base, template: true })).not.toBe(key);
    expect(replyContent({ ...base, subject: 'Rent' })).not.toBe(key);
  });

  it('names the refusals that change what the composer does', () => {
    const reused = { status: 422, data: { body: { code: 'IDEMPOTENCY_KEY_REUSED' } } };
    const resolved = { status: 409, code: 'CONVERSATION_RESOLVED' };
    const closed = { status: 409, data: { body: { code: 'channel_unavailable' } } };
    expect(replyRefusal(reused)).toBe('key_reused');
    expect(replyRefusal(resolved)).toBe('stale');
    expect(replyRefusal(closed)).toBe('stale');
    expect(replyRefusal({ status: 409, code: 'CONFLICT' })).toBe('other');
    expect(replyProblem(reused)).toContain('nothing new was sent');
    expect(replyProblem(resolved)).toContain('Reopen it to reply');
    expect(replyProblem(closed)).toContain('can no longer take this reply');
  });
});

describe('review W12 the composer is refreshed when the WhatsApp window closes', () => {
  const now = new Date('2026-11-04T10:00:00.000Z');

  it('waits until a second after the API’s closing time', () => {
    expect(msUntil('2026-11-04T10:30:00.000Z', now)).toBe(30 * 60_000 + 1_000);
    expect(msUntil('2026-11-04T09:00:00.000Z', now)).toBeNull();
    expect(msUntil(null, now)).toBeNull();
    expect(msUntil('2026-11-06T10:00:00.000Z', now)).toBeNull();
  });
});

describe('review notes: lists keep what was loaded, tabs open in new tabs, retired tags', () => {
  const row = (id: string) => ({ id });

  it('keeps rows past the first 100 on a live refresh, with their cursor', () => {
    const shown = { items: Array.from({ length: 130 }, (_, i) => row(`r${i}`)), cursor: 'c130' };
    const fresh = {
      items: [row('new'), ...shown.items.slice(0, 99)],
      nextCursor: 'c99',
    };
    const next = refreshedRows(shown, fresh, 100);
    expect(next.items).toHaveLength(131);
    expect(next.items[0]?.id).toBe('new');
    expect(next.nextCursor).toBe('c130');
    // Under the limit, the fresh page is the list.
    expect(refreshedRows({ items: [row('a')], cursor: null }, fresh, 100).nextCursor).toBe('c99');
    expect(refreshedRows(null, fresh, 100).items).toHaveLength(100);
  });

  it('lets a ctrl-, cmd-, shift- or middle-click through to the browser', () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(plainClick(click)).toBe(true);
    expect(plainClick({ ...click, metaKey: true })).toBe(false);
    expect(plainClick({ ...click, ctrlKey: true })).toBe(false);
    expect(plainClick({ ...click, button: 1 })).toBe(false);
  });

  it('offers the company’s tags, and drops those taken off its list on save', () => {
    expect(tagChoices(['payment', 'repair'], ['repair', 'water'])).toEqual({
      offered: ['payment', 'repair'],
      kept: ['repair'],
      retired: ['water'],
    });
  });
});

describe('E2 and C2 a pay link goes on the first channel that works', () => {
  it('says the order when there is more than one channel', () => {
    expect(payLinkRoute(['sms'])).toBe('by SMS');
    expect(payLinkRoute(['whatsapp', 'sms'])).toBe('by WhatsApp (by SMS if that fails)');
    expect(payLinkRoute(['push', 'whatsapp', 'sms'])).toBe(
      'by app notification (if that fails, by WhatsApp, then SMS)',
    );
    expect(payLinkOutcome({ channels: ['whatsapp', 'sms'], notSentReason: null })).toEqual({
      sent: true,
      text: 'Pay link on its way by WhatsApp (by SMS if that fails). It works until the invoice is paid, or for 60 days.',
    });
    expect(payLinkOutcome({ channels: ['whatsapp'], notSentReason: null }).text).toBe(
      'Pay link sent by WhatsApp. It works until the invoice is paid, or for 60 days.',
    );
    expect(PAY_LINK_PROBLEM_LABELS.no_consent).toContain('WhatsApp');
  });
});

describe('E2 and C1 a receipt sent by WhatsApp or app notification', () => {
  it('names the channel', () => {
    const sent = { status: 'sent' as const, sentAt: null, latencyMs: null };
    expect(deliveryLine({ ...sent, channel: 'whatsapp' }, ACCRA).label).toBe('Sent by WhatsApp');
    expect(deliveryLine({ ...sent, channel: 'push' }, ACCRA).label).toBe(
      'Sent by app notification',
    );
  });
});

describe('review W7, C3 and decision 8 a consent reset is not a withdrawal', () => {
  it('says the phone or email changed, on the card', () => {
    const reset = { granted: false, source: 'staff' as const, reason: 'address_changed' as const };
    expect(consentHistoryText({ ...reset, channel: 'sms' })).toBe(
      'Reset: the phone number changed',
    );
    expect(consentHistoryText({ ...reset, channel: 'email' })).toBe(
      'Reset: the email address changed',
    );
    expect(consentHistoryText({ ...reset, channel: 'sms', reason: null })).toBe(
      'Withdrawn: recorded by staff',
    );
    expect(
      consentHistoryText({
        channel: 'whatsapp',
        granted: true,
        source: 'tenant_reply',
        reason: null,
      }),
    ).toBe('Agreed: replied YES on WhatsApp');
  });

  it('says so on the timeline too', () => {
    expect(
      timelineDetail('consent_event.insert', {
        after: { channel: 'whatsapp', action: 'withdraw', text_version: 'address_changed.v1' },
      }),
    ).toBe('WhatsApp: consent reset because the phone number changed');
    expect(
      timelineDetail('consent_event.insert', {
        after: { channel: 'email', action: 'withdraw', text_version: 'address_changed.v1' },
      }),
    ).toBe('Email: consent reset because the email address changed');
    expect(
      timelineDetail('consent_event.insert', {
        after: { channel: 'sms', action: 'withdraw', text_version: 'staff_withdraw.v1' },
      }),
    ).toBe('SMS: withdrew consent');
  });
});

describe('review W2 and decision 9 messages come with the API’s timeline', () => {
  const event = (over: Partial<TimelineEvent>): TimelineEvent => ({
    at: '2026-11-04T10:00:00.000Z',
    action: 'message.inbound',
    recordType: 'message',
    recordId: '019a3000-0000-7000-8000-000000000001',
    actorName: null,
    data: {
      channel: 'whatsapp',
      purpose: 'inbound',
      authorType: 'tenant',
      subject: null,
      preview: 'The tap is leaking',
      status: 'received',
      conversationId: '019a3000-0000-7000-8000-00000000c001',
    },
    ...over,
  });

  it('reads a message event as a message, with its words', () => {
    const message = messageOfEvent(event({}));
    expect(message).toMatchObject({
      direction: 'inbound',
      channel: 'whatsapp',
      authorType: 'tenant',
      preview: 'The tap is leaking',
      status: 'received',
    });
    expect(messageHeadline(message!)).toBe('WhatsApp message from the tenant');
  });

  it('names a staff reply’s author, and still says what it was without the words', () => {
    const reply = messageOfEvent(
      event({
        action: 'message.outbound',
        actorName: 'Kofi Manager (demo)',
        data: { channel: 'sms', authorType: 'staff', preview: 'On it', status: 'delivered' },
      }),
    );
    expect(messageHeadline(reply!)).toBe('SMS message to the tenant from Kofi Manager (demo)');
    const hidden = messageOfEvent(
      event({ action: 'message.outbound', actorName: 'Assistant', data: null }),
    );
    expect(hidden).toMatchObject({ authorType: 'bot', preview: null, channel: null, status: null });
    expect(messageOfEvent(event({ action: 'tenant.update' }))).toBeNull();
  });
});
