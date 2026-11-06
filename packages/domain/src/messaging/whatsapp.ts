import type { Instant } from '../dates';
import type { MessagePurpose } from './messaging';

/**
 * WhatsApp's 24-hour window and templates (CM-07; M6 plan 4.3). Free text goes only within 24
 * hours of the tenant's last WhatsApp message; outside it, only the purpose's template, approved
 * by Meta on the sending number. With none approved, WhatsApp is skipped for that message and the
 * next channel is tried.
 */
export const WHATSAPP_WINDOW_HOURS = 24;
const WINDOW_MS = WHATSAPP_WINDOW_HOURS * 60 * 60 * 1000;

/** Whether the customer service window is open: the tenant wrote on WhatsApp in the last 24 hours. */
export function whatsAppWindowOpen(lastInboundWhatsAppAt: Instant | null, now: Instant): boolean {
  if (!lastInboundWhatsAppAt) return false;
  const age = now.epochMilliseconds - lastInboundWhatsAppAt.epochMilliseconds;
  return age >= 0 && age < WINDOW_MS;
}

/** When the window closes, or null when it is not open. */
export function whatsAppWindowClosesAt(
  lastInboundWhatsAppAt: Instant | null,
  now: Instant,
): Instant | null {
  if (!lastInboundWhatsAppAt || !whatsAppWindowOpen(lastInboundWhatsAppAt, now)) return null;
  return lastInboundWhatsAppAt.add({ hours: WHATSAPP_WINDOW_HOURS });
}

/** Meta's template review states, in our spelling. Only `approved` may be sent. */
export const TEMPLATE_STATUSES = ['pending', 'approved', 'rejected', 'paused', 'disabled'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** Meta's template categories. Ours are utility messages, apart from none. */
export const TEMPLATE_CATEGORIES = ['utility', 'marketing', 'authentication'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Meta's pricing categories on delivery reports (CM-12 groundwork; decision 13). */
export const PRICING_CATEGORIES = [
  'utility',
  'marketing',
  'authentication',
  'service',
  'referral_conversion',
] as const;
export type PricingCategory = (typeof PRICING_CATEGORIES)[number];

/**
 * Our templates (CM-07; plan section 3). Notice templates arrive in M7. Keys are stable; a
 * changed text is a new version with its own WhatsApp name.
 */
export const TEMPLATE_KEYS = [
  'rent_reminder',
  'receipt_ready',
  'pay_link',
  'renewal_reminder',
  'signing_link',
  'signing_reminder',
  'signed_copy',
  'id_check_link',
  'paid_until_prompt',
  'building_notice',
  'conversation_reopen',
  // M7: legal notices (plan 4.6 and 4.7).
  'notice_link',
  'notice_reminder',
  'notice_in_force',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/**
 * The template a purpose uses outside the window. Purposes without one only ever go inside it:
 * bot replies and the STOP confirmation answer a message the tenant just sent.
 */
export const TEMPLATE_FOR_PURPOSE: Readonly<Partial<Record<MessagePurpose, TemplateKey>>> = {
  rent_reminder: 'rent_reminder',
  receipt: 'receipt_ready',
  pay_link: 'pay_link',
  renewal_reminder: 'renewal_reminder',
  signing_link: 'signing_link',
  signing_reminder: 'signing_reminder',
  signed_copy: 'signed_copy',
  id_check_link: 'id_check_link',
  paid_until_prompt: 'paid_until_prompt',
  broadcast: 'building_notice',
  conversation_reply: 'conversation_reopen',
  notice_link: 'notice_link',
  notice_reminder: 'notice_reminder',
  notice_in_force: 'notice_in_force',
};

export const templateForPurpose = (purpose: MessagePurpose): TemplateKey | null =>
  TEMPLATE_FOR_PURPOSE[purpose] ?? null;

/** The purpose's template on the sending number, as the template registry knows it. */
export interface TemplateOnNumber {
  readonly key: TemplateKey;
  readonly language: string;
  /** Null: never submitted to Meta for this number. */
  readonly status: TemplateStatus | null;
}

export type WhatsAppContent =
  | { readonly kind: 'free_text' }
  | { readonly kind: 'template'; readonly templateKey: TemplateKey; readonly language: string };

export type WhatsAppChoice =
  WhatsAppContent | { readonly kind: 'skip'; readonly reason: 'no_approved_template' };

/**
 * Free text or a template (plan 4.3), from the window and the template's status on the sending
 * number. Inside the window, free text; outside it, the approved template; otherwise skip.
 */
export function chooseWhatsAppContent(input: {
  readonly windowOpen: boolean;
  readonly template: TemplateOnNumber | null;
}): WhatsAppChoice {
  if (input.windowOpen) return { kind: 'free_text' };
  const template = input.template;
  if (template && template.status === 'approved')
    return { kind: 'template', templateKey: template.key, language: template.language };
  return { kind: 'skip', reason: 'no_approved_template' };
}

/**
 * The text of a template (CM-07), as registered with Meta: `{{1}}`, `{{2}}` and so on are its
 * parameters, named in order. On the shared number the first is always the landlord's name
 * (OQ-24). Documents and links go as the message's attachment or button, not in the text.
 */
export interface TemplateDefinition {
  readonly key: TemplateKey;
  readonly version: number;
  /** The name registered with Meta: the key and version, as Meta's names allow. */
  readonly whatsappName: string;
  readonly category: TemplateCategory;
  readonly language: string;
  readonly body: string;
  readonly parameters: readonly string[];
}

const template = (
  key: TemplateKey,
  body: string,
  parameters: readonly string[],
): TemplateDefinition => ({
  key,
  version: 1,
  whatsappName: `${key}_v1`,
  category: 'utility',
  language: 'en',
  body,
  parameters: ['landlord', ...parameters],
});

/**
 * Version 1 of every template (plan section 3). The send job fills `landlord` (the company's
 * name), `tenant` (the recipient's name) and `link` (the secure link it makes as it sends); any
 * other parameter comes with the message (`templateParams`). No amounts: the link shows them.
 */
export const TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [
  template(
    'rent_reminder',
    'Hello {{2}}, this is a rent reminder from {{1}}. See what is due and pay by MoMo or card at {{3}} whenever you are ready.',
    ['tenant', 'link'],
  ),
  template(
    'receipt_ready',
    'Hello {{2}}, {{1}} has received your payment. Your receipt is at {{3}} and stays open for 30 days.',
    ['tenant', 'link'],
  ),
  template(
    'pay_link',
    'Hello {{2}}, {{1}} has sent you a secure link to pay: {{3}} works for this payment only.',
    ['tenant', 'link'],
  ),
  template(
    'renewal_reminder',
    'Hello {{2}}, {{1}} would like to talk with you about renewing your tenancy. Reply here when you are free.',
    ['tenant'],
  ),
  template(
    'signing_link',
    'Hello {{2}}, {{1}} has sent you a document to read and sign at {{3}} with a code sent to your phone.',
    ['tenant', 'link'],
  ),
  template(
    'signing_reminder',
    'Hello {{2}}, a reminder from {{1}}: a document is waiting for you to sign at {{3}} with a code sent to your phone.',
    ['tenant', 'link'],
  ),
  template(
    'signed_copy',
    'Hello {{2}}, everyone has signed. Your copy from {{1}} is at {{3}} for you to keep.',
    ['tenant', 'link'],
  ),
  template(
    'id_check_link',
    'Hello {{2}}, {{1}} asks you to confirm your identity against your Ghana Card at {{3}} using your phone camera.',
    ['tenant', 'link'],
  ),
  template(
    'paid_until_prompt',
    'Hello {{2}}, your rent with {{1}} is paid until {{3}}. Reply here to talk about the next payment.',
    ['tenant', 'paid_until'],
  ),
  // Meta refuses a template that starts or ends with a parameter.
  template(
    'building_notice',
    'A notice from {{1}} about {{2}}: {{3}}. Reply here if you have a question.',
    ['topic', 'notice'],
  ),
  template(
    'conversation_reopen',
    'Hello {{2}}, {{1}} has replied to your message. Reply here to read it and carry on.',
    ['tenant'],
  ),
  // M7: the words say what to do and what signing confirms; the legal wording is in the notice.
  template(
    'notice_link',
    'Hello {{2}}, {{1}} has sent you a notice. Read it at {{3}} and confirm you received it with a code sent to your phone.',
    ['tenant', 'link'],
  ),
  template(
    'notice_reminder',
    'Hello {{2}}, a reminder from {{1}}: a notice is waiting for you at {{3}}. Please open it and confirm you received it.',
    ['tenant', 'link'],
  ),
  template(
    'notice_in_force',
    'Hello {{2}}, a reminder from {{1}}: the notice sent to you remains in force whether or not you sign it. Read it at {{3}} when you are ready.',
    ['tenant', 'link'],
  ),
];

export const templateDefinition = (key: TemplateKey): TemplateDefinition | null =>
  TEMPLATE_DEFINITIONS.find((d) => d.key === key) ?? null;

/** Fills a template's parameters in order. Throws when a parameter is missing. */
export function renderTemplate(
  definition: TemplateDefinition,
  values: Readonly<Record<string, string>>,
): { readonly text: string; readonly parameters: readonly string[] } {
  const parameters = definition.parameters.map((name) => {
    const value = values[name];
    if (value === undefined || value.trim() === '')
      throw new Error(`Template ${definition.whatsappName} needs ${name}`);
    return value.replace(/\s+/g, ' ').trim();
  });
  const text = definition.body.replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => parameters[Number(n) - 1] ?? '',
  );
  return { text, parameters };
}
