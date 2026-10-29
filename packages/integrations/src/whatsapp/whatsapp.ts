import { z } from 'zod';
import { hmacHex, signatureMatches } from '../hmac';
import { ProviderError, requestJson } from '../http';
import { hasLineBreak, invalidRequest, isE164, notFound, unexpectedResponse } from '../validation';

/**
 * WhatsApp Business messaging (CLAUDE.md section 8). The Meta Cloud API adapter arrives in M6;
 * request and webhook shapes here follow Meta's, so that adapter stays thin.
 */
export interface WhatsAppTextMessage {
  /** E.164 number. */
  readonly to: string;
  readonly body: string;
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
}

export type WhatsAppInboundEvent = WhatsAppInboundMessage | WhatsAppStatusUpdate;

export interface WhatsAppMedia {
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface WhatsAppPort {
  readonly provider: string;
  sendText(message: WhatsAppTextMessage): Promise<WhatsAppSendResult>;
  sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult>;
  sendMedia(message: WhatsAppMediaMessage): Promise<WhatsAppSendResult>;
  /** Messages and status updates in a webhook body; [] for a body that is not a WhatsApp webhook. */
  parseInbound(body: unknown): WhatsAppInboundEvent[];
  /** Checks Meta's `X-Hub-Signature-256` header against the raw request body. */
  verifySignature(
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
    appSecret: string,
  ): boolean;
  fetchMedia(mediaId: string): Promise<WhatsAppMedia>;
}

/** What a fake recorded for a message we sent. */
export interface SentWhatsApp {
  readonly providerMessageId: string;
  readonly to: string;
  readonly type: 'text' | 'template' | 'document' | 'image';
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

function checkCommon(provider: string, to: string, reference: string | undefined): void {
  if (!isE164(to)) throw invalidRequest(provider, 'recipient must be an E.164 number');
  if (reference !== undefined && (reference.length === 0 || reference.length > 512)) {
    throw invalidRequest(provider, 'reference must be 1 to 512 characters');
  }
}

function checkText(provider: string, message: WhatsAppTextMessage): void {
  checkCommon(provider, message.to, message.reference);
  if (message.body.length === 0 || message.body.length > 4096) {
    throw invalidRequest(provider, 'text must be 1 to 4096 characters');
  }
}

function checkTemplate(provider: string, message: WhatsAppTemplateMessage): void {
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

function checkMedia(provider: string, message: WhatsAppMediaMessage): void {
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
const media = z.object({ id: z.string().min(1), caption: z.string().optional() });

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
  button: z.object({ text: z.string() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ title: z.string() }).optional(),
      list_reply: z.object({ title: z.string() }).optional(),
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
});

const webhook = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            messages: z.array(z.unknown()).optional(),
            statuses: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});

const isoFromUnix = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();

function toMessage(raw: unknown): WhatsAppInboundMessage | null {
  const parsed = inboundMessage.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const attached = MEDIA_TYPES.map((type) => m[type]).filter((item) => item !== undefined);
  const text =
    m.text?.body ??
    attached.find((item) => item.caption !== undefined)?.caption ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title;
  return {
    kind: 'message',
    providerMessageId: m.id,
    from: `+${m.from}`,
    type: m.type,
    ...(text === undefined ? {} : { text }),
    mediaIds: attached.map((item) => item.id),
    at: isoFromUnix(m.timestamp),
  };
}

function toStatus(raw: unknown): WhatsAppStatusUpdate | null {
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
  };
}

/** Parses a Meta webhook body. Entries it cannot read are skipped; the raw body is kept elsewhere. */
export function parseMetaWebhook(body: unknown): WhatsAppInboundEvent[] {
  const parsed = webhook.safeParse(body);
  if (!parsed.success) return [];
  const events: WhatsAppInboundEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      for (const raw of change.value.messages ?? []) {
        const message = toMessage(raw);
        if (message) events.push(message);
      }
      for (const raw of change.value.statuses ?? []) {
        const status = toStatus(raw);
        if (status) events.push(status);
      }
    }
  }
  return events;
}

/** The body of a Meta send request (Cloud API `POST /{phone-number-id}/messages`). */
function metaRequest(to: string, content: Record<string, unknown>, reference: string | undefined) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...content,
    ...(reference === undefined ? {} : { biz_opaque_callback_data: reference }),
  };
}

function templateContent(message: WhatsAppTemplateMessage) {
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

function mediaContent(message: WhatsAppMediaMessage) {
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

function webhookBody(value: Record<string, unknown>): string {
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
              metadata: { display_phone_number: '000000000', phone_number_id: 'fake-phone-number' },
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

  async sendText(message: WhatsAppTextMessage): Promise<WhatsAppSendResult> {
    checkText(this.provider, message);
    return this.record({
      to: message.to,
      type: 'text',
      body: message.body,
      reference: message.reference,
    });
  }

  async sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
    checkTemplate(this.provider, message);
    return this.record({
      to: message.to,
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
    if (input.text === undefined && input.media === undefined) {
      throw invalidRequest(this.provider, 'text or media required');
    }
    const id = `wamid.mem-in-${++this.counter}`;
    const from = input.from.slice(1);
    let content: Record<string, unknown> = { type: 'text', text: { body: input.text } };
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
    const rawBody = webhookBody({
      contacts: [{ profile: { name: 'Test contact' }, wa_id: from }],
      messages: [{ from, id, timestamp: nowSeconds(), ...content }],
    });
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
    );
  }

  sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
    return this.send(metaRequest(message.to, templateContent(message), message.reference));
  }

  sendMedia(message: WhatsAppMediaMessage): Promise<WhatsAppSendResult> {
    return this.send(metaRequest(message.to, mediaContent(message), message.reference));
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

  private async send(body: Record<string, unknown>): Promise<WhatsAppSendResult> {
    const parsed = sendResponse.safeParse(
      await requestJson<unknown>(this.provider, `${this.baseUrl}/whatsapp/messages`, { body }),
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
