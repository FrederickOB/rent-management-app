import type { Instant } from '../dates';
import {
  BUSINESS_CHANNEL_ORDER,
  type Channel,
  type ConsentChannel,
  type InboundChannel,
} from './channels';
import { consentAllows, NO_CONSENT, type ConsentBasis, type ConsentFacts } from './consent';
import type { MessagePurpose } from './messaging';
import {
  chooseWhatsAppContent,
  templateForPurpose,
  whatsAppWindowOpen,
  type TemplateOnNumber,
  type WhatsAppContent,
} from './whatsapp';

/**
 * Which channel a message goes by (M6 decision 5 and plan 4.3; CM-07, CM-09). One pure function
 * for business-initiated messages, one for replies on a fixed channel. The send job records each
 * skipped channel with its reason.
 */

/** What the send job knows about one channel for one recipient. */
export interface ChannelReach {
  /**
   * An address on the channel: a phone for WhatsApp and SMS, an email, or for push a tenant with
   * the app and a registered device.
   */
  readonly address: boolean;
  readonly consent: ConsentFacts;
  /** When the recipient last wrote to us on this channel (the reply window and WhatsApp's). */
  readonly lastInboundAt: Instant | null;
}

export const UNREACHABLE: ChannelReach = {
  address: false,
  consent: NO_CONSENT,
  lastInboundAt: null,
};

export type SkipReason =
  /** The message was narrowed to other channels. */
  | 'not_listed'
  /** Failed five times, refused by the provider, or not on WhatsApp (plan 4.3). */
  | 'exhausted'
  | 'no_address'
  | 'no_consent'
  | 'opted_out'
  /** Outside the window with no approved template on the sending number (CM-07). */
  | 'no_approved_template';

export interface Skipped {
  readonly channel: ConsentChannel;
  readonly reason: SkipReason;
}

export type OutboundPlan =
  | {
      readonly send: true;
      readonly channel: ConsentChannel;
      readonly basis: ConsentBasis;
      /** For WhatsApp: free text or the template; null on other channels. */
      readonly whatsapp: WhatsAppContent | null;
      readonly skipped: readonly Skipped[];
    }
  | {
      readonly send: false;
      /** As M3 records it, with M6's template reason. */
      readonly reason: 'delivery_failed' | 'no_consent' | 'no_approved_template' | 'no_address';
      readonly skipped: readonly Skipped[];
    };

export interface OutboundRequest {
  readonly purpose: MessagePurpose;
  /** The channels this message may go by; tried in the business order (decision 5). */
  readonly channels: readonly ConsentChannel[];
  readonly reach: Readonly<Partial<Record<ConsentChannel, ChannelReach>>>;
  /** The purpose's template on the sending WhatsApp number; null when there is none. */
  readonly whatsappTemplate: TemplateOnNumber | null;
  /** Channels already used up for this message. */
  readonly exhausted: ReadonlySet<ConsentChannel>;
  readonly now: Instant;
}

/**
 * The first channel, in the order push, WhatsApp, SMS, email, that the message may use: listed,
 * not used up, with an address and consent (or an exemption), and on WhatsApp either the window
 * open or an approved template. Nothing usable: the reason, as M3 records it.
 */
export function planOutbound(request: OutboundRequest): OutboundPlan {
  const skipped: Skipped[] = [];
  for (const channel of BUSINESS_CHANNEL_ORDER) {
    const skip = (reason: SkipReason) => skipped.push({ channel, reason });
    if (!request.channels.includes(channel)) {
      skip('not_listed');
      continue;
    }
    if (request.exhausted.has(channel)) {
      skip('exhausted');
      continue;
    }
    const reach = request.reach[channel] ?? UNREACHABLE;
    if (!reach.address) {
      skip('no_address');
      continue;
    }
    const consent = consentAllows({
      purpose: request.purpose,
      consent: reach.consent,
      lastInboundAt: reach.lastInboundAt,
      now: request.now,
    });
    if (!consent.allowed) {
      skip(consent.reason);
      continue;
    }
    if (channel !== 'whatsapp')
      return { send: true, channel, basis: consent.basis, whatsapp: null, skipped };
    const purposeTemplate = templateForPurpose(request.purpose);
    const content = chooseWhatsAppContent({
      windowOpen: whatsAppWindowOpen(reach.lastInboundAt, request.now),
      template:
        purposeTemplate && request.whatsappTemplate?.key === purposeTemplate
          ? request.whatsappTemplate
          : null,
    });
    if (content.kind === 'skip') {
      skip(content.reason);
      continue;
    }
    return { send: true, channel, basis: consent.basis, whatsapp: content, skipped };
  }
  return { send: false, reason: finalReason(skipped), skipped };
}

function finalReason(
  skipped: readonly Skipped[],
): Extract<OutboundPlan, { send: false }>['reason'] {
  const listed = skipped.filter((s) => s.reason !== 'not_listed');
  if (listed.some((s) => s.reason === 'exhausted')) return 'delivery_failed';
  if (listed.some((s) => s.reason === 'no_consent' || s.reason === 'opted_out'))
    return 'no_consent';
  if (listed.some((s) => s.reason === 'no_approved_template')) return 'no_approved_template';
  return 'no_address';
}

export type ReplyPlan =
  | {
      readonly send: true;
      readonly basis: ConsentBasis | 'in_app';
      readonly whatsapp: WhatsAppContent | null;
    }
  | {
      readonly send: false;
      readonly reason: 'no_address' | 'no_consent' | 'opted_out' | 'window_closed';
    };

/**
 * A reply on a fixed channel (plan 4.6): staff answering in the inbox, or the bot. In the app it
 * always goes (the tenant reads it there). Elsewhere it needs consent or the reply window; on
 * WhatsApp outside the window only the "reopen conversation" template, when approved.
 */
export function planReply(input: {
  readonly purpose: MessagePurpose;
  readonly channel: InboundChannel;
  readonly reach: ChannelReach;
  /** The reopen template on the sending number, for WhatsApp outside the window. */
  readonly whatsappTemplate: TemplateOnNumber | null;
  readonly now: Instant;
}): ReplyPlan {
  if (input.channel === 'in_app') return { send: true, basis: 'in_app', whatsapp: null };
  if (!input.reach.address) return { send: false, reason: 'no_address' };
  const consent = consentAllows({
    purpose: input.purpose,
    consent: input.reach.consent,
    lastInboundAt: input.reach.lastInboundAt,
    now: input.now,
  });
  if (!consent.allowed) return { send: false, reason: consent.reason };
  if (input.channel !== 'whatsapp') return { send: true, basis: consent.basis, whatsapp: null };
  const purposeTemplate = templateForPurpose(input.purpose);
  const content = chooseWhatsAppContent({
    windowOpen: whatsAppWindowOpen(input.reach.lastInboundAt, input.now),
    template:
      purposeTemplate && input.whatsappTemplate?.key === purposeTemplate
        ? input.whatsappTemplate
        : null,
  });
  if (content.kind === 'skip') return { send: false, reason: 'window_closed' };
  return { send: true, basis: consent.basis, whatsapp: content };
}

/** The channel the composer offers first: the one the tenant last wrote on (plan 4.6). */
export function defaultReplyChannel(
  lastInbound: Readonly<Partial<Record<InboundChannel, Instant | null>>>,
): InboundChannel | null {
  let best: { channel: InboundChannel; at: Instant } | null = null;
  for (const [channel, at] of Object.entries(lastInbound) as [InboundChannel, Instant | null][])
    if (at && (!best || at.epochMilliseconds > best.at.epochMilliseconds)) best = { channel, at };
  return best?.channel ?? null;
}

/** Whether a channel is one a person can be messaged on at all, for previews (CM-08). */
export const isOutboundChannel = (channel: Channel): channel is ConsentChannel =>
  channel !== 'in_app';
