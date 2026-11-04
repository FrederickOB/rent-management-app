/**
 * Channels (M6 plan 4.3; decision 5). Every message travels on one of these. Business-initiated
 * messages try push, then WhatsApp, then SMS, then email; in-app messages are what a tenant writes
 * in the app and the replies they read there.
 */
export const CHANNELS = ['push', 'whatsapp', 'sms', 'email', 'in_app'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Channels consent is recorded on (CM-09; the `consent_event` channel check). */
export const CONSENT_CHANNELS = ['push', 'whatsapp', 'sms', 'email'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

/** The order a business-initiated message tries the channels in (decision 5; plan 4.3). */
export const BUSINESS_CHANNEL_ORDER: readonly ConsentChannel[] = [
  'push',
  'whatsapp',
  'sms',
  'email',
];

/** Channels a tenant can write in on, and so channels a conversation reply can go back on. */
export const INBOUND_CHANNELS = ['whatsapp', 'sms', 'email', 'in_app'] as const;
export type InboundChannel = (typeof INBOUND_CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  push: 'App notification',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  in_app: 'In the app',
};

export const isChannel = (value: string): value is Channel =>
  (CHANNELS as readonly string[]).includes(value);

export const isConsentChannel = (value: string): value is ConsentChannel =>
  (CONSENT_CHANNELS as readonly string[]).includes(value);

/** Phone-addressed channels; the others are addressed by email or by a registered device. */
export const usesPhone = (channel: Channel): boolean => channel === 'whatsapp' || channel === 'sms';
