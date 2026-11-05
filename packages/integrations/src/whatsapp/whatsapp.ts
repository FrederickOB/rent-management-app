import { z } from 'zod';
import { hmacHex, signatureMatches } from '../hmac';
import { ProviderError, requestJson } from '../http';
import { hasLineBreak, invalidRequest, isE164, notFound, unexpectedResponse } from '../validation';

/**
 * WhatsApp Business messaging (CLAUDE.md section 8). Request and webhook shapes follow Meta's
 * Cloud API; the Meta adapter is in meta.ts (M6). `from` names the number a message goes from,
 * by Meta's phone number id: the shared platform number or a company's own (M6 decision 3).
 */
export interface WhatsAppTextMessage {
  /** E.164 number. */
  readonly to: string;
  readonly body: string;
  /** Meta's phone number id of the sending number; the adapter's default when absent. */
  readonly from?: string;
  /** Our idempotency reference, echoed in status updates. */
  readonly reference?: string;
}

export interface WhatsAppTemplateMessage {
  readonly to: string;
  /** An approved template: the only kind of message allowed outside the 24-hour window. */
  readonly template: string;
  /** Template language code, for example `en` or `en_GB`. */
  readonly language: string;
  /** Body parameters in order: {{1}}, {{2}} and so on. */
  readonly parameters: readonly string[];
  readonly from?: string;
  readonly reference?: string;
}

export interface WhatsAppMediaMessage {
  readonly to: string;
  /** A link the provider downloads, such as a short-lived presigned URL. */
  readonly mediaUrl: string;
  /** `document` (the default) for PDFs such as receipts and notices; `image` for photos. */
  readonly kind?: 'document' | 'image';
  /** File name shown with a document. */
  readonly filename?: string;
  readonly caption?: string;
  readonly from?: string;
  readonly reference?: string;
}

/**
 * Reply buttons (up to three) or a list (up to ten rows): the menu bot's choices (CM-03). The
 * reply comes back with the choice's id. Only inside the 24-hour window.
 */
export interface WhatsAppInteractiveMessage {
  readonly to: string;
  readonly body: string;
  readonly choices: readonly { readonly id: string; readonly title: string }[];
  /** The list's button label; used when there are more than three choices. */
  readonly listButton?: string;
  readonly from?: string;
  readonly reference?: string;
}

export interface WhatsAppSendResult {
  readonly provider: string;
  readonly providerMessageId: string;
}

export interface WhatsAppInboundMessage {
  readonly kind: 'message';
  readonly providerMessageId: string;
  /** E.164 number of the sender, for matching to a tenant. */
  readonly from: string;
  /** The provider's message type: text, image, document, audio, video, button, interactive, ... */
  readonly type: string;
  /** The text, caption or button text, when the message has one. */
  readonly text?: string;
  /** Media to fetch with `fetchMedia` and copy to our storage at once. */
  readonly mediaIds: readonly string[];
  /** The same media with what Meta says about each. */
  readonly media?: readonly {
    readonly id: string;
    readonly kind: 'image' | 'document' | 'audio' | 'video' | 'sticker';
    readonly mimeType?: string;
    readonly filename?: string;
    readonly caption?: string;
  }[];
  /** The id of the reply button or list row chosen (the bot's choice ids), when it was one. */
  readonly choiceId?: string;
  /** Meta's phone number id of the number written to: which number, shared or a company's. */
  readonly phoneNumberId?: string;
  /** The provider's timestamp, ISO 8601 UTC. Evidence uses our own receive time, never this. */
  readonly at: string;
}

export interface WhatsAppStatusUpdate {
  readonly kind: 'status';
  readonly providerMessageId: string;
  /** E.164 number of the recipient. */
  readonly recipient: string;
  readonly status: 'sent' | 'delivered' | 'read' | 'failed';
  readonly at: string;
  /** The reference given when the message was sent. */
  readonly reference?: string;
  /** The provider's error code when the status is `failed`. */
  readonly errorCode?: string;
  /** Meta's pricing category and whether it bills the message (CM-12 groundwork). */
  readonly pricing?: { readonly category: string; readonly billable: boolean };
  readonly phoneNumberId?: string;
}

/** Meta's template review result for one template on one WhatsApp Business Account (CM-07). */
export interface WhatsAppTemplateStatusEvent {
  readonly kind: 'template_status';
  /** The account (WABA) id the webhook entry is for. */
  readonly wabaId: string;
  readonly metaTemplateId: string;
  readonly name: string;
  readonly language: string;
  /** Meta's event, lower case: approved, rejected, pending, paused, disabled, flagged… */
  readonly status: string;
  readonly reason?: string;
}

export type WhatsAppInboundEvent = WhatsAppInboundMessage | WhatsAppStatusUpdate;

/** A template as Meta lists it for an account, for the daily sync (CM-07). */
export interface WhatsAppTemplateInfo {
  readonly metaTemplateId: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly category?: string;
  readonly reason?: string;
}

export interface WhatsAppMedia {
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface WhatsAppPort {
  readonly provider: string;
  sendText(message: WhatsAppTextMessage): Promise<WhatsAppSendResult>;
  sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult>;
  sendMedia(message: WhatsAppMediaMessage): Promise<WhatsAppSendResult>;
  sendInteractive(message: WhatsAppInteractiveMessage): Promise<WhatsAppSendResult>;
  /** Every template on an account and its status (the daily sync, CM-07). */
  listTemplates(wabaId: string): Promise<WhatsAppTemplateInfo[]>;
  /** Messages and status updates in a webhook body; [] for a body that is not a WhatsApp webhook. */
  parseInbound(body: unknown): WhatsAppInboundEvent[];
  /** Checks Meta's `X-Hub-Signature-256` header against the raw request body. */
  verifySignature(
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
    appSecret: string,
  ): boolean;
  /** M6 review S-4: with `maxBytes`, a larger file is refused (ProviderError, status 413). */
  fetchMedia(mediaId: string, options?: { maxBytes?: number }): Promise<WhatsAppMedia>;
}

/** What a fake recorded for a message we sent. */
export interface SentWhatsApp {
  readonly providerMessageId: string;
  readonly to: string;
  readonly from?: string;
  readonly type: 'text' | 'template' | 'document' | 'image' | 'interactive';
  readonly choices?: readonly { readonly id: string; readonly title: string }[];
  readonly body?: string;
  readonly template?: string;
  readonly language?: string;
  readonly parameters?: readonly string[];
  readonly mediaUrl?: string;
  readonly filename?: string;
  readonly caption?: string;
  readonly reference?: string;
}

export interface SimulatedInboundWhatsApp {
  /** E.164 number of the person writing. */
  readonly from: string;
  /** Message text, or the caption when there is media. */
  readonly text?: string;
  /** A reply button chosen, by its id (and its title as the text). */
  readonly choiceId?: string;
  /** The number written to, by Meta's phone number id; the fake's default when absent. */
  readonly phoneNumberId?: string;
  readonly media?: {
    readonly contentType: string;
    readonly bytes: Buffer;
    readonly filename?: string;
  };
}

/** A webhook request as the provider would deliver it. */
export interface SimulatedWhatsAppWebhook {
  readonly rawBody: string;
  /** The `X-Hub-Signature-256` header value. */
  readonly signature: string;
}

/** Test controls both fakes offer; not part of the port. */
export interface WhatsAppTestControls {
  /** A person writes to us. Returns the signed webhook request the provider would deliver. */
  simulateInbound(input: SimulatedInboundWhatsApp): Promise<SimulatedWhatsAppWebhook>;
  /** The provider reports a status for a message we sent. */
  simulateStatus(input: {
    readonly providerMessageId: string;
    readonly status: WhatsAppStatusUpdate['status'];
    readonly errorCode?: string;
  }): Promise<SimulatedWhatsAppWebhook>;
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
// Meta refuses template parameters with new lines, tabs or more than four spaces in a row (132018).
const BAD_PARAMETER = /[\n\t]| {5,}/;

export function checkCommon(provider: string, to: string, reference: string | undefined): void {
  if (!isE164(to)) throw invalidRequest(provider, 'recipient must be an E.164 number');
  if (reference !== undefined && (reference.length === 0 || reference.length > 512)) {
    throw invalidRequest(provider, 'reference must be 1 to 512 characters');
  }
}

export function checkText(provider: string, message: WhatsAppTextMessage): void {
  checkCommon(provider, message.to, message.reference);
  if (message.body.length === 0 || message.body.length > 4096) {
    throw invalidRequest(provider, 'text must be 1 to 4096 characters');
  }
}

export function checkTemplate(provider: string, message: WhatsAppTemplateMessage): void {
  checkCommon(provider, message.to, message.reference);
  if (!TEMPLATE_NAME.test(message.template)) {
    throw invalidRequest(provider, 'invalid template name');
  }
  if (!LANGUAGE.test(message.language)) throw invalidRequest(provider, 'invalid template language');
  for (const parameter of message.parameters) {
    if (parameter.length === 0 || parameter.length > 1024 || BAD_PARAMETER.test(parameter)) {
      throw invalidRequest(
        provider,
        'template parameters must be 1 to 1024 characters, without new lines, tabs or runs of spaces',
      );
    }
  }
}

export function checkInteractive(provider: string, message: WhatsAppInteractiveMessage): void {
  checkCommon(provider, message.to, message.reference);
  if (message.body.length === 0 || message.body.length > 1024)
    throw invalidRequest(provider, 'interactive body must be 1 to 1024 characters');
  if (message.choices.length === 0 || message.choices.length > 10)
    throw invalidRequest(provider, 'interactive messages carry 1 to 10 choices');
  const limit = message.choices.length > 3 ? 24 : 20;
  for (const choice of message.choices)
    if (
      choice.id.length === 0 ||
      choice.id.length > 200 ||
      choice.title.length === 0 ||
      choice.title.length > limit
    )
      throw invalidRequest(provider, `choice titles must be 1 to ${limit} characters`);
}

export function checkMedia(provider: string, message: WhatsAppMediaMessage): void {
  checkCommon(provider, message.to, message.reference);
  const url = URL.parse(message.mediaUrl);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw invalidRequest(provider, 'media URL must be http or https');
  }
  if (message.caption !== undefined && message.caption.length > 1024) {
    throw invalidRequest(provider, 'caption must be at most 1024 characters');
  }
  if (
    message.filename !== undefined &&
    (message.filename.length > 240 || hasLineBreak(message.filename))
  ) {
    throw invalidRequest(provider, 'invalid file name');
  }
}

/** Meta's `X-Hub-Signature-256`: `sha256=` and the hex HMAC-SHA256 of the raw body. */
export function verifyMetaSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (appSecret.length === 0) throw new Error('WhatsApp app secret is not configured');
  if (!signatureHeader?.startsWith('sha256=')) return false;
  return signatureMatches('sha256', appSecret, rawBody, signatureHeader.slice('sha256='.length));
}

export function signMetaWebhook(rawBody: string, appSecret: string): string {
  return `sha256=${hmacHex('sha256', appSecret, rawBody)}`;
}

const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'] as const;
const waId = z.string().regex(/^\d{7,15}$/);
const unixSeconds = z.string().regex(/^\d{1,12}$/);
const media = z.object({
  id: z.string().min(1),
  caption: z.string().optional(),
  mime_type: z.string().optional(),
  filename: z.string().optional(),
});

const inboundMessage = z.object({
  id: z.string().min(1),
  from: waId,
  timestamp: unixSeconds,
  type: z.string().min(1),
  text: z.object({ body: z.string() }).optional(),
  image: media.optional(),
  document: media.optional(),
  audio: media.optional(),
  video: media.optional(),
  sticker: media.optional(),
  button: z.object({ text: z.string(), payload: z.string().optional() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ id: z.string().optional(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string().optional(), title: z.string() }).optional(),
    })
    .optional(),
});

const statusUpdate = z.object({
  id: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: unixSeconds,
  recipient_id: waId,
  biz_opaque_callback_data: z.string().optional(),
  errors: z.array(z.object({ code: z.union([z.number(), z.string()]) })).optional(),
  pricing: z.object({ category: z.string(), billable: z.boolean().optional() }).optional(),
});

const templateStatus = z.object({
  event: z.string().min(1),
  message_template_id: z.union([z.number(), z.string()]),
  message_template_name: z.string().min(1),
  message_template_language: z.string().min(1),
  reason: z.string().nullable().optional(),
});

const webhook = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              metadata: z.object({ phone_number_id: z.string().optional() }).optional(),
              messages: z.array(z.unknown()).optional(),
              statuses: z.array(z.unknown()).optional(),
            })
            .passthrough(),
        }),
      ),
    }),
  ),
});

const isoFromUnix = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();

function toMessage(
  raw: unknown,
  phoneNumberId: string | undefined,
  detailed: boolean,
): WhatsAppInboundMessage | null {
  const parsed = inboundMessage.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const attached = MEDIA_TYPES.flatMap((kind) => {
    const item = m[kind];
    return item ? [{ kind, item }] : [];
  });
  const text =
    m.text?.body ??
    attached.find(({ item }) => item.caption !== undefined)?.item.caption ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title;
  const choiceId =
    m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload;
  return {
    kind: 'message',
    providerMessageId: m.id,
    from: `+${m.from}`,
    type: m.type,
    ...(text === undefined ? {} : { text }),
    mediaIds: attached.map(({ item }) => item.id),
    ...(detailed
      ? {
          media: attached.map(({ kind, item }) => ({
            id: item.id,
            kind,
            ...(item.mime_type === undefined ? {} : { mimeType: item.mime_type }),
            ...(item.filename === undefined ? {} : { filename: item.filename }),
            ...(item.caption === undefined ? {} : { caption: item.caption }),
          })),
          ...(choiceId === undefined ? {} : { choiceId }),
          ...(phoneNumberId === undefined ? {} : { phoneNumberId }),
        }
      : {}),
    at: isoFromUnix(m.timestamp),
  };
}

function toStatus(
  raw: unknown,
  phoneNumberId: string | undefined,
  detailed: boolean,
): WhatsAppStatusUpdate | null {
  const parsed = statusUpdate.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const errorCode = s.errors?.[0]?.code;
  return {
    kind: 'status',
    providerMessageId: s.id,
    recipient: `+${s.recipient_id}`,
    status: s.status,
    at: isoFromUnix(s.timestamp),
    ...(s.biz_opaque_callback_data === undefined ? {} : { reference: s.biz_opaque_callback_data }),
    ...(errorCode === undefined ? {} : { errorCode: String(errorCode) }),
    ...(detailed && s.pricing !== undefined
      ? { pricing: { category: s.pricing.category, billable: s.pricing.billable ?? true } }
      : {}),
    ...(detailed && phoneNumberId !== undefined ? { phoneNumberId } : {}),
  };
}

function toTemplateStatus(
  raw: unknown,
  wabaId: string | undefined,
): WhatsAppTemplateStatusEvent | null {
  const parsed = templateStatus.safeParse(raw);
  if (!parsed.success || !wabaId) return null;
  const t = parsed.data;
  return {
    kind: 'template_status',
    wabaId,
    metaTemplateId: String(t.message_template_id),
    name: t.message_template_name,
    language: t.message_template_language,
    status: t.event.toLowerCase(),
    ...(t.reason ? { reason: t.reason } : {}),
  };
}

/** Parses a Meta webhook body. Entries it cannot read are skipped; the raw body is kept elsewhere. */
export function parseMetaWebhook(body: unknown): WhatsAppInboundEvent[] {
  return parseEvents(body, false);
}

/**
 * The same, with what the M6 inbound pipeline needs as well: the number written to (its phone
 * number id), the reply button or list row chosen, each media item's type and file name, and a
 * status's pricing category (CM-12 groundwork).
 */
export function parseMetaWebhookDetailed(body: unknown): WhatsAppInboundEvent[] {
  return parseEvents(body, true);
}

function parseEvents(body: unknown, detailed: boolean): WhatsAppInboundEvent[] {
  const parsed = webhook.safeParse(body);
  if (!parsed.success) return [];
  const events: WhatsAppInboundEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const phoneNumberId = change.value.metadata?.phone_number_id;
      for (const raw of change.value.messages ?? []) {
        const message = toMessage(raw, phoneNumberId, detailed);
        if (message) events.push(message);
      }
      for (const raw of change.value.statuses ?? []) {
        const status = toStatus(raw, phoneNumberId, detailed);
        if (status) events.push(status);
      }
    }
  }
  return events;
}

/**
 * Template review results in a Meta webhook body (field `message_template_status_update`), for
 * the template registry (CM-07). [] for anything else.
 */
export function parseMetaTemplateStatus(body: unknown): WhatsAppTemplateStatusEvent[] {
  const parsed = webhook.safeParse(body);
  if (!parsed.success) return [];
  const events: WhatsAppTemplateStatusEvent[] = [];
  for (const entry of parsed.data.entry)
    for (const change of entry.changes) {
      if (change.field !== 'message_template_status_update') continue;
      const event = toTemplateStatus(change.value, entry.id);
      if (event) events.push(event);
    }
  return events;
}

/** The body of a Meta send request (Cloud API `POST /{phone-number-id}/messages`). */
export function metaRequest(
  to: string,
  content: Record<string, unknown>,
  reference: string | undefined,
) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...content,
    ...(reference === undefined ? {} : { biz_opaque_callback_data: reference }),
  };
}

export function templateContent(message: WhatsAppTemplateMessage) {
  return {
    type: 'template',
    template: {
      name: message.template,
      language: { code: message.language },
      ...(message.parameters.length === 0
        ? {}
        : {
            components: [
              {
                type: 'body',
                parameters: message.parameters.map((text) => ({ type: 'text', text })),
              },
            ],
          }),
    },
  };
}

export function interactiveContent(message: WhatsAppInteractiveMessage) {
  if (message.choices.length <= 3)
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message.body },
        action: {
          buttons: message.choices.map((c) => ({
            type: 'reply',
            reply: { id: c.id, title: c.title },
          })),
        },
      },
    };
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: message.body },
      action: {
        button: (message.listButton ?? 'Choose').slice(0, 20),
        sections: [{ rows: message.choices.map((c) => ({ id: c.id, title: c.title })) }],
      },
    },
  };
}

export function mediaContent(message: WhatsAppMediaMessage) {
  const kind = message.kind ?? 'document';
  return {
    type: kind,
    [kind]: {
      link: message.mediaUrl,
      ...(message.caption === undefined ? {} : { caption: message.caption }),
      ...(kind === 'document' && message.filename !== undefined
        ? { filename: message.filename }
        : {}),
    },
  };
}

function inboundMediaType(contentType: string): (typeof MEDIA_TYPES)[number] {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'document';
}

function webhookBody(value: Record<string, unknown>, phoneNumberId = 'fake-phone-number'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'fake-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '000000000', phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  });
}

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

/** Records messages and holds media in memory, for unit and integration tests. */
export class InMemoryWhatsApp implements WhatsAppPort, WhatsAppTestControls {
  readonly provider = 'memory';
  readonly sent: SentWhatsApp[] = [];
  private readonly media = new Map<string, WhatsAppMedia>();
  private counter = 0;

  constructor(readonly appSecret = 'in-memory-whatsapp-app-secret') {}

  /** Template statuses `listTemplates` answers, by account. */
  readonly templates = new Map<string, WhatsAppTemplateInfo[]>();

  async sendText(message: WhatsAppTextMessage): Promise<WhatsAppSendResult> {
    checkText(this.provider, message);
    return this.record({
      to: message.to,
      from: message.from,
      type: 'text',
      body: message.body,
      reference: message.reference,
    });
  }

  async sendInteractive(message: WhatsAppInteractiveMessage): Promise<WhatsAppSendResult> {
    checkInteractive(this.provider, message);
    return this.record({
      to: message.to,
      from: message.from,
      type: 'interactive',
      body: message.body,
      choices: message.choices.map((c) => ({ id: c.id, title: c.title })),
      reference: message.reference,
    });
  }

  async listTemplates(wabaId: string): Promise<WhatsAppTemplateInfo[]> {
    return [...(this.templates.get(wabaId) ?? [])];
  }

  async sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
    checkTemplate(this.provider, message);
    return this.record({
      to: message.to,
      from: message.from,
      type: 'template',
      template: message.template,
      language: message.language,
      parameters: [...message.parameters],
      reference: message.reference,
    });
  }

  async sendMedia(message: WhatsAppMediaMessage): Promise<WhatsAppSendResult> {
    checkMedia(this.provider, message);
    const type = message.kind ?? 'document';
    return this.record({
      to: message.to,
      from: message.from,
      type,
      mediaUrl: message.mediaUrl,
      // As with Meta, only documents carry a file name.
      filename: type === 'document' ? message.filename : undefined,
      caption: message.caption,
      reference: message.reference,
    });
  }

  parseInbound(body: unknown): WhatsAppInboundEvent[] {
    return parseMetaWebhook(body);
  }

  verifySignature(
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
    appSecret: string,
  ): boolean {
    return verifyMetaSignature(rawBody, signatureHeader, appSecret);
  }

  async fetchMedia(mediaId: string): Promise<WhatsAppMedia> {
    const found = this.media.get(mediaId);
    if (!found) throw notFound(this.provider, 'media');
    return { contentType: found.contentType, bytes: Buffer.from(found.bytes) };
  }

  async simulateInbound(input: SimulatedInboundWhatsApp): Promise<SimulatedWhatsAppWebhook> {
    if (!isE164(input.from)) throw invalidRequest(this.provider, 'sender must be an E.164 number');
    if (input.text === undefined && input.media === undefined && input.choiceId === undefined) {
      throw invalidRequest(this.provider, 'text or media required');
    }
    const id = `wamid.mem-in-${++this.counter}`;
    const from = input.from.slice(1);
    let content: Record<string, unknown> = { type: 'text', text: { body: input.text } };
    if (input.choiceId !== undefined)
      content = {
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: input.choiceId, title: input.text ?? input.choiceId },
        },
      };
    if (input.media) {
      const mediaId = `mem-media-${this.counter}`;
      this.media.set(mediaId, {
        contentType: input.media.contentType,
        bytes: Buffer.from(input.media.bytes),
      });
      const type = inboundMediaType(input.media.contentType);
      content = {
        type,
        [type]: {
          id: mediaId,
          mime_type: input.media.contentType,
          ...(input.text === undefined ? {} : { caption: input.text }),
          ...(input.media.filename === undefined ? {} : { filename: input.media.filename }),
        },
      };
    }
    const rawBody = webhookBody(
      {
        contacts: [{ profile: { name: 'Test contact' }, wa_id: from }],
        messages: [{ from, id, timestamp: nowSeconds(), ...content }],
      },
      input.phoneNumberId,
    );
    return { rawBody, signature: signMetaWebhook(rawBody, this.appSecret) };
  }

  async simulateStatus(input: {
    providerMessageId: string;
    status: WhatsAppStatusUpdate['status'];
    errorCode?: string;
  }): Promise<SimulatedWhatsAppWebhook> {
    const message = this.sent.find((m) => m.providerMessageId === input.providerMessageId);
    if (!message) throw notFound(this.provider, 'message');
    const rawBody = webhookBody({
      statuses: [
        {
          id: message.providerMessageId,
          status: input.status,
          timestamp: nowSeconds(),
          recipient_id: message.to.slice(1),
          ...(message.reference === undefined
            ? {}
            : { biz_opaque_callback_data: message.reference }),
          ...(input.errorCode === undefined
            ? {}
            : { errors: [{ code: input.errorCode, title: 'Fake failure' }] }),
          pricing: { category: 'utility', billable: true, pricing_model: 'PMP' },
        },
      ],
    });
    return { rawBody, signature: signMetaWebhook(rawBody, this.appSecret) };
  }

  lastTo(to: string): SentWhatsApp | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }

  private record(message: Omit<SentWhatsApp, 'providerMessageId'>): WhatsAppSendResult {
    const providerMessageId = `wamid.mem-${++this.counter}`;
    this.sent.push({ ...message, providerMessageId });
    return { provider: this.provider, providerMessageId };
  }
}

const sendResponse = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) });
/** Meta's `GET /{waba-id}/message_templates` page. */
export const templateList = z.object({
  data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      name: z.string(),
      language: z.string(),
      status: z.string(),
      category: z.string().optional(),
      rejected_reason: z.string().nullable().optional(),
    }),
  ),
  paging: z.object({ next: z.string().optional() }).optional(),
});
export const templateInfo = (
  t: z.infer<typeof templateList>['data'][number],
): WhatsAppTemplateInfo => ({
  metaTemplateId: String(t.id),
  name: t.name,
  language: t.language,
  status: t.status.toLowerCase(),
  ...(t.category === undefined ? {} : { category: t.category.toLowerCase() }),
  ...(t.rejected_reason && t.rejected_reason !== 'NONE' ? { reason: t.rejected_reason } : {}),
});
const mediaInfo = z.object({ url: z.string().min(1), mime_type: z.string().min(1) });
const simulated = z.object({ rawBody: z.string().min(1), signature: z.string().min(1) });

async function requestBytes(provider: string, url: string): Promise<WhatsAppMedia> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new ProviderError(provider, `request failed (${(error as Error).name})`, true);
  }
  if (!response.ok) {
    throw new ProviderError(
      provider,
      `HTTP ${response.status}`,
      response.status >= 500 || response.status === 429,
      response.status,
    );
  }
  return {
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

/** Talks to `apps/fake-providers` over HTTP, with the request shapes of Meta's Cloud API. */
export class FakeProvidersWhatsApp implements WhatsAppPort, WhatsAppTestControls {
  readonly provider = 'fake-providers';
  constructor(private readonly baseUrl: string) {}

  sendText(message: WhatsAppTextMessage): Promise<WhatsAppSendResult> {
    return this.send(
      metaRequest(message.to, { type: 'text', text: { body: message.body } }, message.reference),
      message.from,
    );
  }

  sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
    return this.send(
      metaRequest(message.to, templateContent(message), message.reference),
      message.from,
    );
  }

  sendMedia(message: WhatsAppMediaMessage): Promise<WhatsAppSendResult> {
    return this.send(
      metaRequest(message.to, mediaContent(message), message.reference),
      message.from,
    );
  }

  sendInteractive(message: WhatsAppInteractiveMessage): Promise<WhatsAppSendResult> {
    checkInteractive(this.provider, message);
    return this.send(
      metaRequest(message.to, interactiveContent(message), message.reference),
      message.from,
    );
  }

  async listTemplates(wabaId: string): Promise<WhatsAppTemplateInfo[]> {
    const parsed = templateList.safeParse(
      await requestJson<unknown>(
        this.provider,
        `${this.baseUrl}/whatsapp/templates?waba=${encodeURIComponent(wabaId)}`,
      ),
    );
    if (!parsed.success) throw unexpectedResponse(this.provider);
    return parsed.data.data.map(templateInfo);
  }

  parseInbound(body: unknown): WhatsAppInboundEvent[] {
    return parseMetaWebhook(body);
  }

  verifySignature(
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
    appSecret: string,
  ): boolean {
    return verifyMetaSignature(rawBody, signatureHeader, appSecret);
  }

  /** Meta's two steps: look up the media URL, then download it. */
  async fetchMedia(mediaId: string): Promise<WhatsAppMedia> {
    const info = mediaInfo.safeParse(
      await requestJson<unknown>(
        this.provider,
        `${this.baseUrl}/whatsapp/media/${encodeURIComponent(mediaId)}`,
      ),
    );
    if (!info.success) throw unexpectedResponse(this.provider);
    return requestBytes(this.provider, info.data.url);
  }

  async simulateInbound(input: SimulatedInboundWhatsApp): Promise<SimulatedWhatsAppWebhook> {
    const body = {
      from: input.from,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.choiceId === undefined ? {} : { choiceId: input.choiceId }),
      ...(input.phoneNumberId === undefined ? {} : { phoneNumberId: input.phoneNumberId }),
      ...(input.media === undefined
        ? {}
        : {
            media: {
              contentType: input.media.contentType,
              base64: input.media.bytes.toString('base64'),
              ...(input.media.filename === undefined ? {} : { filename: input.media.filename }),
            },
          }),
    };
    return this.simulate('/whatsapp/_test/inbound', body);
  }

  simulateStatus(input: {
    providerMessageId: string;
    status: WhatsAppStatusUpdate['status'];
    errorCode?: string;
  }): Promise<SimulatedWhatsAppWebhook> {
    return this.simulate('/whatsapp/_test/status', input);
  }

  private async send(body: Record<string, unknown>, from?: string): Promise<WhatsAppSendResult> {
    const parsed = sendResponse.safeParse(
      await requestJson<unknown>(this.provider, `${this.baseUrl}/whatsapp/messages`, {
        body: from === undefined ? body : { ...body, from_phone_number_id: from },
      }),
    );
    const first = parsed.success ? parsed.data.messages[0] : undefined;
    if (!first) throw unexpectedResponse(this.provider);
    return { provider: this.provider, providerMessageId: first.id };
  }

  private async simulate(path: string, body: unknown): Promise<SimulatedWhatsAppWebhook> {
    const parsed = simulated.safeParse(
      await requestJson<unknown>(this.provider, `${this.baseUrl}${path}`, { body }),
    );
    if (!parsed.success) throw unexpectedResponse(this.provider);
    return parsed.data;
  }
}
