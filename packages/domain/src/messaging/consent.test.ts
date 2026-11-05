import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { instantFrom, type Instant } from '../dates';
import { CONSENT_CHANNELS, type ConsentChannel } from './channels';
import {
  CONSENT_SOURCES,
  consentAllows,
  consentFactsOf,
  consentRequirement,
  consentTextVersion,
  REPLY_WINDOW_HOURS,
  shouldAskWhatsAppConsent,
  sourceAllows,
  sourceChannels,
  withinReplyWindow,
  type ConsentFacts,
} from './consent';
import { CONSENT_TEXTS, consentText, MESSAGE_PURPOSES, type MessagePurpose } from './messaging';
import { planOutbound, planReply, type ChannelReach } from './outbound';

const T0 = instantFrom('2026-11-04T08:00:00Z');
const at = (minutes: number): Instant => T0.add({ minutes });
const HOUR = 60;

const BUSINESS: readonly MessagePurpose[] = MESSAGE_PURPOSES.filter(
  (p) => consentRequirement(p) === 'consent',
);
const REPLIES: readonly MessagePurpose[] = MESSAGE_PURPOSES.filter(
  (p) => consentRequirement(p) === 'consent_or_reply',
);

/** A consent history on one channel: events at minute offsets, in time order. */
const historyArb = fc
  .array(
    fc.record({
      action: fc.constantFrom<'grant' | 'withdraw'>('grant', 'withdraw'),
      minute: fc.integer({ min: 0, max: 72 * HOUR }),
    }),
    { maxLength: 6 },
  )
  .map((events) =>
    [...events]
      .sort((a, b) => a.minute - b.minute)
      .map((e) => ({ action: e.action, at: at(e.minute) })),
  );

/** The consent in force at `now`: the latest event at or before it. */
const factsAt = (history: readonly { action: 'grant' | 'withdraw'; at: Instant }[], now: Instant) =>
  consentFactsOf(history.filter((e) => e.at.epochMilliseconds <= now.epochMilliseconds));

describe('CM-09 consent', () => {
  it('never lets a business-initiated message go on a channel without consent in force (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BUSINESS),
        historyArb,
        fc.option(fc.integer({ min: 0, max: 72 * HOUR }), { nil: null }),
        fc.integer({ min: 0, max: 96 * HOUR }),
        (purpose, history, inboundMinute, nowMinute) => {
          const now = at(nowMinute);
          const facts = factsAt(history, now);
          const outcome = consentAllows({
            purpose,
            consent: facts,
            lastInboundAt: inboundMinute === null ? null : at(inboundMinute),
            now,
          });
          expect(outcome.allowed).toBe(facts.latest?.action === 'grant');
        },
      ),
    );
  });

  it('withdraws at once on STOP: after a withdrawal nothing business-initiated goes until a new grant (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BUSINESS),
        historyArb,
        fc.integer({ min: 0, max: 72 * HOUR }),
        fc.integer({ min: 0, max: 24 * HOUR }),
        (purpose, history, stopMinute, after) => {
          const stopped = [
            ...history.filter((e) => e.at.epochMilliseconds < at(stopMinute).epochMilliseconds),
            { action: 'withdraw' as const, at: at(stopMinute) },
          ];
          const outcome = consentAllows({
            purpose,
            consent: consentFactsOf(stopped),
            lastInboundAt: at(stopMinute),
            now: at(stopMinute + after),
          });
          expect(outcome).toEqual({ allowed: false, reason: 'opted_out' });
        },
      ),
    );
  });

  it('exempts a conversation reply only within 24 hours of the tenant’s message, and not after a STOP that followed it (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REPLIES),
        historyArb,
        fc.integer({ min: 0, max: 72 * HOUR }),
        fc.integer({ min: 0, max: 48 * HOUR }),
        (purpose, history, inboundMinute, delay) => {
          const inbound = at(inboundMinute);
          const now = at(inboundMinute + delay);
          const facts = factsAt(history, now);
          const outcome = consentAllows({ purpose, consent: facts, lastInboundAt: inbound, now });
          const granted = facts.latest?.action === 'grant';
          const inWindow = delay < REPLY_WINDOW_HOURS * HOUR;
          const stoppedAfter =
            facts.latest?.action === 'withdraw' &&
            facts.latest.at.epochMilliseconds >= inbound.epochMilliseconds;
          expect(outcome.allowed).toBe(granted || (inWindow && !stoppedAfter));
          if (outcome.allowed && !granted) expect(outcome.basis).toBe('reply_window');
        },
      ),
    );
  });

  it('answers a tenant who writes again after STOP, within 24 hours of the new message only', () => {
    const consent = consentFactsOf([{ action: 'withdraw', at: at(0) }]);
    const reply = (inbound: number, now: number) =>
      consentAllows({
        purpose: 'conversation_reply',
        consent,
        lastInboundAt: at(inbound),
        now: at(now),
      });
    // The STOP message itself: no replies after it.
    expect(reply(0, 1).allowed).toBe(false);
    // A new message an hour later: replies may go for 24 hours after it.
    expect(reply(60, 61)).toEqual({ allowed: true, basis: 'reply_window' });
    expect(reply(60, 60 + 24 * HOUR).allowed).toBe(false);
    // Business messages stay stopped.
    expect(
      consentAllows({ purpose: 'rent_reminder', consent, lastInboundAt: at(60), now: at(61) }),
    ).toEqual({ allowed: false, reason: 'opted_out' });
  });

  it('sends the one STOP confirmation in the window, and exempts staff and owner notices', () => {
    const withdrawn = consentFactsOf([{ action: 'withdraw', at: at(0) }]);
    expect(
      consentAllows({
        purpose: 'opt_out_confirmation',
        consent: withdrawn,
        lastInboundAt: at(0),
        now: at(1),
      }),
    ).toEqual({ allowed: true, basis: 'opt_out_confirmation' });
    expect(
      consentAllows({
        purpose: 'opt_out_confirmation',
        consent: withdrawn,
        lastInboundAt: null,
        now: at(1),
      }).allowed,
    ).toBe(false);
    for (const purpose of ['staff_notice', 'settlement_alert', 'overdue_alert'] as const)
      expect(
        consentAllows({ purpose, consent: { latest: null }, lastInboundAt: null, now: at(0) }),
      ).toEqual({ allowed: true, basis: 'exempt' });
    expect(
      consentAllows({
        purpose: 'inbound',
        consent: { latest: null },
        lastInboundAt: null,
        now: at(0),
      }).allowed,
    ).toBe(false);
  });

  it('treats the window as 24 hours exactly, and never a message from the future', () => {
    expect(withinReplyWindow(at(0), at(24 * HOUR - 1))).toBe(true);
    expect(withinReplyWindow(at(0), at(24 * HOUR))).toBe(false);
    expect(withinReplyWindow(at(10), at(0))).toBe(false);
    expect(withinReplyWindow(null, at(0))).toBe(false);
  });

  it('records each source only for the actions and channels it can (decision 7, plan 4.2)', () => {
    expect(sourceAllows('stop_keyword', 'grant')).toBe(false);
    expect(sourceAllows('start_keyword', 'withdraw')).toBe(false);
    expect(sourceAllows('email_unsubscribe', 'withdraw')).toBe(true);
    expect(sourceAllows('tenant_reply', 'grant')).toBe(true);
    expect(sourceChannels('tenant_app')).toEqual(['push']);
    expect(sourceChannels('email_unsubscribe')).toEqual(['email']);
    expect(sourceChannels('stop_keyword')).toEqual(['push', 'whatsapp', 'sms', 'email']);
    for (const source of CONSENT_SOURCES)
      for (const action of ['grant', 'withdraw'] as const) {
        if (!sourceAllows(source, action)) continue;
        const version = consentTextVersion(source, action);
        expect(CONSENT_TEXTS[version], `${source} ${action}`).toBeDefined();
        for (const channel of sourceChannels(source))
          expect(consentText(version, channel)).not.toContain('{channel}');
      }
  });

  it('asks a known tenant once about WhatsApp, never after a withdrawal (plan 4.8)', () => {
    const none: ConsentFacts = { latest: null };
    expect(
      shouldAskWhatsAppConsent({ knownSender: true, whatsapp: none, alreadyAsked: false }),
    ).toBe(true);
    expect(
      shouldAskWhatsAppConsent({ knownSender: true, whatsapp: none, alreadyAsked: true }),
    ).toBe(false);
    expect(
      shouldAskWhatsAppConsent({ knownSender: false, whatsapp: none, alreadyAsked: false }),
    ).toBe(false);
    expect(
      shouldAskWhatsAppConsent({
        knownSender: true,
        whatsapp: consentFactsOf([{ action: 'withdraw', at: at(0) }]),
        alreadyAsked: false,
      }),
    ).toBe(false);
  });

  it('takes the latest event by time, whatever order the events come in', () => {
    const facts = consentFactsOf([
      { action: 'grant', at: at(30) },
      { action: 'withdraw', at: at(10) },
    ]);
    expect(facts.latest?.action).toBe('grant');
  });
});

describe('CM-09 SMS fallback and the business order (decision 5)', () => {
  const reach = (consented: boolean): ChannelReach => ({
    address: true,
    consent: consented ? consentFactsOf([{ action: 'grant', at: at(0) }]) : { latest: null },
    lastInboundAt: null,
  });

  it('never picks a channel without consent for a business message, whatever the order and failures (property)', () => {
    const channelSet = fc.subarray([...CONSENT_CHANNELS]);
    fc.assert(
      fc.property(
        fc.constantFrom(...BUSINESS),
        channelSet,
        channelSet,
        channelSet,
        channelSet,
        (purpose, listed, addressed, consented, exhausted) => {
          const plan = planOutbound({
            purpose,
            channels: listed,
            reach: Object.fromEntries(
              CONSENT_CHANNELS.map((c) => [
                c,
                {
                  address: addressed.includes(c),
                  consent: consented.includes(c)
                    ? consentFactsOf([{ action: 'grant', at: at(0) }])
                    : { latest: null },
                  lastInboundAt: at(1),
                },
              ]),
            ) as Record<ConsentChannel, ChannelReach>,
            whatsappTemplate: null,
            exhausted: new Set(exhausted),
            now: at(2),
          });
          if (!plan.send) return;
          expect(listed).toContain(plan.channel);
          expect(addressed).toContain(plan.channel);
          expect(consented).toContain(plan.channel);
          expect(exhausted).not.toContain(plan.channel);
          // Nothing earlier in the order could have carried it (the WhatsApp window is open here).
          const order = ['push', 'whatsapp', 'sms', 'email'];
          for (const earlier of order.slice(0, order.indexOf(plan.channel)))
            expect(
              !listed.includes(earlier as ConsentChannel) ||
                !addressed.includes(earlier as ConsentChannel) ||
                !consented.includes(earlier as ConsentChannel) ||
                exhausted.includes(earlier as ConsentChannel),
            ).toBe(true);
        },
      ),
    );
  });

  it('goes push first, then WhatsApp, SMS and email; a failed WhatsApp falls back to SMS', () => {
    const all = { push: reach(true), whatsapp: reach(true), sms: reach(true), email: reach(true) };
    const approved = { key: 'receipt_ready' as const, language: 'en', status: 'approved' as const };
    const base = {
      purpose: 'receipt' as const,
      channels: [...CONSENT_CHANNELS],
      reach: all,
      whatsappTemplate: approved,
      now: at(10),
    };
    expect(planOutbound({ ...base, exhausted: new Set() })).toMatchObject({
      send: true,
      channel: 'push',
    });
    const noPush = planOutbound({ ...base, exhausted: new Set(['push']) });
    expect(noPush).toMatchObject({
      send: true,
      channel: 'whatsapp',
      whatsapp: { kind: 'template', templateKey: 'receipt_ready' },
    });
    expect(planOutbound({ ...base, exhausted: new Set(['push', 'whatsapp']) })).toMatchObject({
      send: true,
      channel: 'sms',
      skipped: [
        { channel: 'push', reason: 'exhausted' },
        { channel: 'whatsapp', reason: 'exhausted' },
      ],
    });
  });

  it('keeps a message narrowed to some channels to that list (plan 4.3)', () => {
    const plan = planOutbound({
      purpose: 'signing_link',
      channels: ['sms', 'email'],
      reach: { push: reach(true), whatsapp: reach(true), sms: reach(false), email: reach(true) },
      whatsappTemplate: null,
      exhausted: new Set(),
      now: at(0),
    });
    expect(plan).toMatchObject({ send: true, channel: 'email' });
  });

  it('reports why nothing could go, as M3 does', () => {
    const none = (
      overrides: Partial<Record<ConsentChannel, ChannelReach>>,
      exhausted: ConsentChannel[] = [],
    ) =>
      planOutbound({
        purpose: 'rent_reminder',
        channels: [...CONSENT_CHANNELS],
        reach: overrides,
        whatsappTemplate: null,
        exhausted: new Set(exhausted),
        now: at(0),
      });
    expect(none({})).toMatchObject({ send: false, reason: 'no_address' });
    expect(none({ sms: reach(false) })).toMatchObject({ send: false, reason: 'no_consent' });
    expect(none({ sms: reach(true) }, ['sms'])).toMatchObject({
      send: false,
      reason: 'delivery_failed',
    });
    expect(none({ whatsapp: reach(true) })).toMatchObject({
      send: false,
      reason: 'no_approved_template',
    });
  });

  it('lets a reply go on the tenant’s channel without consent in the window, and in the app always', () => {
    const replyReach: ChannelReach = {
      address: true,
      consent: { latest: null },
      lastInboundAt: at(0),
    };
    expect(
      planReply({
        purpose: 'conversation_reply',
        channel: 'sms',
        reach: replyReach,
        whatsappTemplate: null,
        now: at(60),
      }),
    ).toEqual({ send: true, basis: 'reply_window', whatsapp: null });
    expect(
      planReply({
        purpose: 'conversation_reply',
        channel: 'sms',
        reach: replyReach,
        whatsappTemplate: null,
        now: at(25 * HOUR),
      }),
    ).toEqual({ send: false, reason: 'no_consent' });
    expect(
      planReply({
        purpose: 'conversation_reply',
        channel: 'in_app',
        reach: { address: false, consent: { latest: null }, lastInboundAt: null },
        whatsappTemplate: null,
        now: at(0),
      }),
    ).toEqual({ send: true, basis: 'in_app', whatsapp: null });
  });
});
