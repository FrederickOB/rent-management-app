import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ProviderError } from '../http';
import { unexpectedResponse } from '../validation';
import {
  checkInteractive,
  checkMedia,
  checkTemplate,
  checkText,
  interactiveContent,
  mediaContent,
  metaRequest,
  parseMetaWebhook,
  templateContent,
  templateInfo,
  templateList,
  verifyMetaSignature,
  type WhatsAppInboundEvent,
  type WhatsAppInteractiveMessage,
  type WhatsAppMedia,
  type WhatsAppMediaMessage,
  type WhatsAppPort,
  type WhatsAppSendResult,
  type WhatsAppTemplateInfo,
  type WhatsAppTemplateMessage,
  type WhatsAppTextMessage,
} from './whatsapp';

/**
 * Meta's WhatsApp Cloud API (CM-01; M6 plan section 3; developers.facebook.com/docs/whatsapp/
 * cloud-api). One system-user token serves every number the platform's business manages, the
 * shared number and companies' own (decision 3); each send names its number. No SDK: plain JSON
 * over HTTPS with a timeout, as every adapter here.
 */
export interface MetaWhatsAppOptions {
  /** The system user's access token, from the secrets manager. */
  readonly accessToken: string;
  /** The Graph API version, from config (for example `v23.0`). */
  readonly graphVersion: string;
  /** The phone number id used when a message names none: the shared number. */
  readonly defaultPhoneNumberId: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/**
 * Meta error codes that sending again will not fix (developers.facebook.com/docs/whatsapp/
 * cloud-api/support/error-codes): the number is not on WhatsApp or cannot receive, the 24-hour
 * window is closed, or the template or its parameters are refused. The send job moves to the next
 * channel at once (plan 4.3).
 */
export const META_PERMANENT_CODES = new Set([
  131026, // message undeliverable (not on WhatsApp, or an old app)
  131047, // re-engagement: more than 24 hours since the customer last wrote
  131051, // unsupported message type
  131052, // media download error on the recipient side
  131053, // media upload error
  132000, // template parameter count mismatch
  132001, // template does not exist in that language
  132005, // translated text too long
  132007, // template format character policy violated
  132012, // parameter format mismatch
  132015, // template paused
  132016, // template disabled
  132068, // flow blocked
  133010, // phone number not registered
  100, // invalid parameter
]);

/** Throttling and transient errors: tried again with backoff. */
const META_RETRYABLE_CODES = new Set([4, 80007, 130429, 131048, 131056, 131000, 133004, 2]);

const errorBody = z.object({
  error: z.object({ code: z.number().optional(), error_subcode: z.number().optional() }),
});

const PROVIDER = 'meta';

export class MetaWhatsApp implements WhatsAppPort {
  readonly provider = PROVIDER;
  private readonly base: string;

  constructor(private readonly options: MetaWhatsAppOptions) {
    if (!options.accessToken) throw new Error('Meta access token is not configured');
    if (!/^v\d+\.\d+$/.test(options.graphVersion))
      throw new Error('META_GRAPH_VERSION must look like v23.0');
    this.base = `${options.baseUrl ?? 'https://graph.facebook.com'}/${options.graphVersion}`;
  }

  sendText(message: WhatsAppTextMessage): Promise<WhatsAppSendResult> {
    checkText(PROVIDER, message);
    return this.send(
      message.from,
      metaRequest(message.to, { type: 'text', text: { body: message.body } }, message.reference),
    );
  }

  sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
    checkTemplate(PROVIDER, message);
    return this.send(
      message.from,
      metaRequest(message.to, templateContent(message), message.reference),
    );
  }

  sendMedia(message: WhatsAppMediaMessage): Promise<WhatsAppSendResult> {
    checkMedia(PROVIDER, message);
    return this.send(
      message.from,
      metaRequest(message.to, mediaContent(message), message.reference),
    );
  }

  sendInteractive(message: WhatsAppInteractiveMessage): Promise<WhatsAppSendResult> {
    checkInteractive(PROVIDER, message);
    return this.send(
      message.from,
      metaRequest(message.to, interactiveContent(message), message.reference),
    );
  }

  async listTemplates(wabaId: string): Promise<WhatsAppTemplateInfo[]> {
    if (!/^\d{5,30}$/.test(wabaId))
      throw new ProviderError(PROVIDER, 'invalid account id', false, 400);
    const out: WhatsAppTemplateInfo[] = [];
    let url: string | undefined =
      `${this.base}/${wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=200`;
    for (let page = 0; url && page < 20; page++) {
      const parsed = templateList.safeParse(await this.request(url));
      if (!parsed.success) throw unexpectedResponse(PROVIDER);
      out.push(...parsed.data.data.map(templateInfo));
      // Follow only Meta's own next-page links.
      const next = parsed.data.paging?.next;
      url = next && next.startsWith(this.base) ? next : undefined;
    }
    return out;
  }

  parseInbound(body: unknown): WhatsAppInboundEvent[] {
    return parseMetaWebhook(body);
  }

  verifySignature(
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
    appSecret: string,
  ) {
    return verifyMetaSignature(rawBody, signatureHeader, appSecret);
  }

  /** Meta's two steps: the media's URL from its id, then the bytes, both with the token. */
  async fetchMedia(mediaId: string, options: { maxBytes?: number } = {}): Promise<WhatsAppMedia> {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(mediaId))
      throw new ProviderError(PROVIDER, 'invalid media id', false, 400);
    const info = z
      .object({
        url: z.string().url(),
        mime_type: z.string().min(1),
        file_size: z.coerce.number().int().nonnegative().optional(),
      })
      .safeParse(await this.request(`${this.base}/${mediaId}`));
    if (!info.success) throw unexpectedResponse(PROVIDER);
    // M6 review S-4: a file over the limit is refused on Meta's word, before any of it is read.
    const max = options.maxBytes;
    if (max !== undefined && info.data.file_size !== undefined && info.data.file_size > max)
      throw new ProviderError(PROVIDER, 'media too large', false, 413);
    const url = new URL(info.data.url);
    // Meta serves media from its own hosts only; never send the token anywhere else.
    if (
      url.protocol !== 'https:' ||
      !/(^|\.)(fbsbx|facebook|whatsapp)\.(com|net)$/.test(url.hostname)
    )
      throw unexpectedResponse(PROVIDER);
    const response = await this.raw(info.data.url, { method: 'GET' });
    return {
      contentType: response.headers.get('content-type') ?? info.data.mime_type,
      bytes: await readCapped(response, max),
    };
  }

  private async send(from: string | undefined, body: Record<string, unknown>) {
    const phoneNumberId = from ?? this.options.defaultPhoneNumberId;
    if (!/^\d{5,30}$/.test(phoneNumberId))
      throw new ProviderError(PROVIDER, 'invalid sending number', false, 400);
    const parsed = z
      .object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) })
      .safeParse(await this.request(`${this.base}/${phoneNumberId}/messages`, body));
    const first = parsed.success ? parsed.data.messages[0] : undefined;
    if (!first) throw unexpectedResponse(PROVIDER);
    return { provider: PROVIDER, providerMessageId: first.id };
  }

  private async request(url: string, body?: unknown): Promise<unknown> {
    const response = await this.raw(url, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
      return await response.json();
    } catch {
      throw new ProviderError(PROVIDER, 'response was not JSON', true, response.status);
    }
  }

  /** One request with the token; Meta's error codes decide whether a failure is worth retrying. */
  private async raw(url: string, init: { method: string; body?: string }): Promise<Response> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new ProviderError(PROVIDER, `request failed (${(error as Error).name})`, true);
    }
    if (response.ok) return response;
    const code = await response
      .json()
      .then((json: unknown) => {
        const parsed = errorBody.safeParse(json);
        return parsed.success ? parsed.data.error.code : undefined;
      })
      .catch(() => undefined);
    // Codes only in the message: Meta's error text can quote the number (CLAUDE.md section 10).
    const detail = `HTTP ${response.status}${code === undefined ? '' : ` code ${code}`}`;
    const retryable =
      code !== undefined
        ? META_RETRYABLE_CODES.has(code) ||
          (!META_PERMANENT_CODES.has(code) && response.status >= 500)
        : response.status >= 500 || response.status === 429;
    throw new MetaError(detail, retryable, response.status, code);
  }
}

/** A Meta refusal, with its code, so the send job can tell "not on WhatsApp" from the rest. */
export class MetaError extends ProviderError {
  constructor(
    message: string,
    retryable: boolean,
    status: number,
    readonly metaCode: number | undefined,
  ) {
    super(PROVIDER, message, retryable, status);
  }
}

/**
 * Meta's webhook verification (`GET` with `hub.mode=subscribe`, `hub.verify_token` and
 * `hub.challenge`): the challenge to echo when the token matches ours, otherwise null.
 */
export function verifyMetaChallenge(
  query: Readonly<Record<string, unknown>>,
  verifyToken: string,
): string | null {
  if (!verifyToken) return null;
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string')
    return null;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}

/** Reads a response body, stopping (and refusing it) once it passes `max` bytes. */
async function readCapped(response: Response, max: number | undefined): Promise<Buffer> {
  if (max === undefined || !response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError(PROVIDER, 'media too large', false, 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
