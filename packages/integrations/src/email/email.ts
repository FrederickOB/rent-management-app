import nodemailer, {
  type Mail,
  type NodemailerError,
  type SMTPSentMessageInfo,
  type SMTPTransportOptions,
} from 'nodemailer';
import { z } from 'zod';
import { ProviderError } from '../http';
import { hasLineBreak, invalidRequest, isEmailAddress } from '../validation';

/**
 * Email (CLAUDE.md section 8). Postmark from M6 (decision 2): it sends, parses inbound replies to
 * JSON (with the quoted thread stripped) and reports deliveries and bounces. SMTP to Mailpit
 * locally. Inbound and event webhooks carry a secret of ours (sms.ts `webhookSecretMatches`).
 */
export interface EmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface EmailMessage {
  /** One recipient per message, so delivery is tracked per person. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** `Name <address>` or a bare address; the adapter's default From when absent. */
  readonly from?: string;
  readonly replyTo?: string;
  readonly attachments?: readonly EmailAttachment[];
  /**
   * Extra headers: `List-Unsubscribe` and `List-Unsubscribe-Post` on business-initiated email
   * (M6 decision 7). Names and values on one line each.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Our reference, echoed in delivery and bounce events (Postmark metadata). */
  readonly reference?: string;
}

export interface EmailSendResult {
  readonly provider: string;
  readonly providerMessageId: string;
}

export interface InboundEmail {
  readonly providerMessageId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  /** The reply alone, without the quoted thread (Postmark's StrippedTextReply). */
  readonly strippedReply?: string;
  /** Every address it was sent to, bare and lower case: the reply address is among them. */
  readonly recipients?: readonly string[];
  readonly attachments: readonly EmailAttachment[];
}

/** A delivery report or bounce (decision 2). */
export interface EmailEvent {
  readonly providerMessageId: string;
  readonly status: 'delivered' | 'failed' | 'opened';
  /** Bounce type, spam complaint and the like, for a failure. */
  readonly reason?: string;
  readonly at: string;
  /** A unique id for the event, for idempotent storage. */
  readonly eventId: string;
  readonly reference?: string;
}

export interface EmailPort {
  readonly provider: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
  /** An inbound email webhook body, or null when the body is not one. */
  parseInbound(body: unknown): InboundEmail | null;
  /** A delivery or bounce webhook body, or null when the body is not one. */
  parseEvent?(body: unknown): EmailEvent | null;
}

const NAMED_ADDRESS = /^[^<>]*<([^<>]+)>$/;
const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

/** The bare address of `Name <address>` or of a bare address. */
export function emailAddressOf(value: string): string {
  return (NAMED_ADDRESS.exec(value.trim())?.[1] ?? value).trim();
}

function checkSender(provider: string, value: string, field: string): void {
  if (hasLineBreak(value) || !isEmailAddress(emailAddressOf(value))) {
    throw invalidRequest(provider, `${field} must be an email address`);
  }
}

/** Refuses what a mail server would refuse, and header injection (a line break in a header). */
export function checkEmail(provider: string, message: EmailMessage): void {
  if (hasLineBreak(message.to) || !isEmailAddress(message.to)) {
    throw invalidRequest(provider, 'recipient must be an email address');
  }
  if (message.from !== undefined) checkSender(provider, message.from, 'from');
  if (message.replyTo !== undefined) checkSender(provider, message.replyTo, 'reply-to');
  if (
    message.subject.length === 0 ||
    message.subject.length > 998 ||
    hasLineBreak(message.subject)
  ) {
    throw invalidRequest(provider, 'subject must be one line of 1 to 998 characters');
  }
  if (message.text.length === 0) throw invalidRequest(provider, 'text body required');
  for (const [name, value] of Object.entries(message.headers ?? {}))
    if (!/^[A-Za-z0-9-]{1,76}$/.test(name) || hasLineBreak(value) || value.length > 998)
      throw invalidRequest(provider, 'headers must be one line each');
  for (const attachment of message.attachments ?? []) {
    if (attachment.filename.length === 0 || hasLineBreak(attachment.filename)) {
      throw invalidRequest(provider, 'attachment file name required, on one line');
    }
    if (!CONTENT_TYPE.test(attachment.contentType)) {
      throw invalidRequest(provider, 'attachment content type must look like type/subtype');
    }
  }
}

/**
 * The neutral inbound shape our fakes use. The provider chosen in M6 maps its own webhook to
 * `InboundEmail`; attachments arrive base64-encoded.
 */
const inboundSchema = z.object({
  messageId: z.string().min(1),
  from: z.string().min(3),
  to: z.string().min(3),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().regex(CONTENT_TYPE),
        contentBase64: z.base64(),
      }),
    )
    .default([]),
});

/**
 * Postmark's inbound webhook (postmarkapp.com/developer/webhooks/inbound-webhook): the sender,
 * every recipient, the subject, the full text, the stripped reply and base64 attachments.
 */
const postmarkInbound = z.object({
  MessageID: z.string().min(1),
  From: z.string().min(3),
  FromFull: z.object({ Email: z.string() }).optional(),
  To: z.string().default(''),
  ToFull: z.array(z.object({ Email: z.string() })).optional(),
  CcFull: z.array(z.object({ Email: z.string() })).optional(),
  OriginalRecipient: z.string().optional(),
  Subject: z.string().default(''),
  TextBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  StrippedTextReply: z.string().optional(),
  Attachments: z
    .array(
      z.object({
        Name: z.string().min(1),
        Content: z.base64(),
        ContentType: z.string().regex(CONTENT_TYPE),
      }),
    )
    .default([]),
});

export function parsePostmarkInbound(body: unknown): InboundEmail | null {
  const parsed = postmarkInbound.safeParse(body);
  if (!parsed.success) return null;
  const m = parsed.data;
  const recipients = [
    ...(m.ToFull ?? []).map((t) => t.Email),
    ...(m.CcFull ?? []).map((t) => t.Email),
    ...(m.OriginalRecipient ? [m.OriginalRecipient] : []),
    ...m.To.split(',').map((t) => emailAddressOf(t)),
  ]
    .map((a) => a.trim().toLowerCase())
    .filter((a, i, all) => a.length > 0 && all.indexOf(a) === i);
  return {
    providerMessageId: m.MessageID,
    from: (m.FromFull?.Email ?? emailAddressOf(m.From)).toLowerCase(),
    to: recipients[0] ?? '',
    subject: m.Subject,
    ...(m.TextBody === undefined ? {} : { text: m.TextBody }),
    ...(m.HtmlBody === undefined ? {} : { html: m.HtmlBody }),
    ...(m.StrippedTextReply === undefined || m.StrippedTextReply.trim() === ''
      ? {}
      : { strippedReply: m.StrippedTextReply }),
    recipients,
    attachments: m.Attachments.map((a) => ({
      filename: a.Name,
      contentType: a.ContentType,
      content: Buffer.from(a.Content, 'base64'),
    })),
  };
}

/**
 * Postmark's delivery, bounce, spam-complaint and open webhooks
 * (postmarkapp.com/developer/webhooks/webhooks-overview), as one event each.
 */
const postmarkEvent = z.object({
  RecordType: z.enum(['Delivery', 'Bounce', 'SpamComplaint', 'Open']),
  MessageID: z.string().min(1),
  ID: z.union([z.number(), z.string()]).optional(),
  Type: z.string().optional(),
  DeliveredAt: z.string().optional(),
  BouncedAt: z.string().optional(),
  ReceivedAt: z.string().optional(),
  Metadata: z.record(z.string(), z.string()).optional(),
});

export function parsePostmarkEvent(body: unknown): EmailEvent | null {
  const parsed = postmarkEvent.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data;
  const at = e.DeliveredAt ?? e.BouncedAt ?? e.ReceivedAt;
  const status =
    e.RecordType === 'Delivery' ? 'delivered' : e.RecordType === 'Open' ? 'opened' : 'failed';
  return {
    providerMessageId: e.MessageID,
    status,
    ...(status === 'failed'
      ? {
          reason:
            e.RecordType === 'SpamComplaint'
              ? 'spam_complaint'
              : (e.Type ?? 'bounce').toLowerCase(),
        }
      : {}),
    at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString(),
    eventId: `${e.RecordType}:${e.MessageID}:${e.ID ?? ''}`,
    ...(e.Metadata?.reference ? { reference: e.Metadata.reference } : {}),
  };
}

export function parseInboundEmail(body: unknown): InboundEmail | null {
  const postmark = parsePostmarkInbound(body);
  if (postmark) return postmark;
  const parsed = inboundSchema.safeParse(body);
  if (!parsed.success) return null;
  const { messageId, attachments, text, html, ...rest } = parsed.data;
  return {
    ...rest,
    providerMessageId: messageId,
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
    attachments: attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: Buffer.from(a.contentBase64, 'base64'),
    })),
  };
}

export type SentEmail = EmailMessage & {
  readonly from: string;
  readonly providerMessageId: string;
};

/** Records email in memory, for unit and integration tests. */
export class InMemoryEmail implements EmailPort {
  readonly provider = 'memory';
  readonly sent: SentEmail[] = [];

  constructor(private readonly defaultFrom = 'Rent Platform <no-reply@rent.local>') {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    checkEmail(this.provider, message);
    const providerMessageId = `mem-email-${this.sent.length + 1}`;
    this.sent.push({ ...message, from: message.from ?? this.defaultFrom, providerMessageId });
    return { provider: this.provider, providerMessageId };
  }

  parseInbound(body: unknown): InboundEmail | null {
    return parseInboundEmail(body);
  }

  parseEvent(body: unknown): EmailEvent | null {
    return parsePostmarkEvent(body);
  }

  lastTo(to: string): SentEmail | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

// Errors without an SMTP reply where sending the same message again cannot succeed.
const PERMANENT_CODES = new Set(['EENVELOPE', 'ECONFIG', 'EAUTH', 'ENOAUTH']);

function smtpError(provider: string, error: unknown): ProviderError {
  const e = error as NodemailerError;
  // Built from codes only: server replies can quote the recipient's address (CLAUDE.md section 10).
  const detail = [e.code, e.responseCode].filter((part) => part !== undefined).join(' ');
  const permanent =
    e.permanent === true || (e.responseCode === undefined && PERMANENT_CODES.has(e.code ?? ''));
  return new ProviderError(provider, `SMTP ${detail || 'error'}`, !permanent);
}

/** Sends through any SMTP server: Mailpit locally. */
export class SmtpEmail implements EmailPort {
  readonly provider = 'smtp';
  private readonly transport: Mail<SMTPSentMessageInfo, SMTPTransportOptions>;

  constructor(
    smtpUrl: string,
    private readonly defaultFrom: string,
  ) {
    checkSender(this.provider, defaultFrom, 'default from');
    this.transport = nodemailer.createTransport(
      { url: smtpUrl, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 },
      // We only ever attach buffers; never let a message make the mailer read a file or a URL.
      { disableFileAccess: true, disableUrlAccess: true },
    );
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    checkEmail(this.provider, message);
    try {
      const info = await this.transport.sendMail({
        from: message.from ?? this.defaultFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
        attachments: (message.attachments ?? []).map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: a.content,
        })),
      });
      return { provider: this.provider, providerMessageId: info.messageId };
    } catch (error) {
      throw smtpError(this.provider, error);
    }
  }

  parseInbound(body: unknown): InboundEmail | null {
    return parseInboundEmail(body);
  }

  parseEvent(body: unknown): EmailEvent | null {
    return parsePostmarkEvent(body);
  }

  close(): void {
    this.transport.close();
  }
}

export interface PostmarkEmailOptions {
  /** The server API token, from the secrets manager. */
  readonly serverToken: string;
  /** `Name <address>` on the sending domain. */
  readonly defaultFrom: string;
  /** Postmark's message stream: `outbound` for transactional mail. */
  readonly messageStream?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

const postmarkResponse = z.object({
  ErrorCode: z.number(),
  MessageID: z.string().optional(),
});

/**
 * Postmark error codes that sending again will not fix (postmarkapp.com/developer/api/overview):
 * an inactive recipient (hard bounce, complaint or unsubscribe), an invalid address or request.
 */
const POSTMARK_PERMANENT = new Set([300, 406, 409, 411, 412, 413, 422]);

/** Postmark (decision 2): `POST /email` with the server token; no SDK. */
export class PostmarkEmail implements EmailPort {
  readonly provider = 'postmark';
  private readonly base: string;

  constructor(private readonly options: PostmarkEmailOptions) {
    if (!options.serverToken) throw new Error('POSTMARK_SERVER_TOKEN is not configured');
    checkSender(this.provider, options.defaultFrom, 'default from');
    this.base = options.baseUrl ?? 'https://api.postmarkapp.com';
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    checkEmail(this.provider, message);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.base}/email`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': this.options.serverToken,
        },
        body: JSON.stringify({
          From: message.from ?? this.options.defaultFrom,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          ...(message.html === undefined ? {} : { HtmlBody: message.html }),
          ...(message.replyTo === undefined ? {} : { ReplyTo: message.replyTo }),
          MessageStream: this.options.messageStream ?? 'outbound',
          Headers: Object.entries(message.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
          Attachments: (message.attachments ?? []).map((a) => ({
            Name: a.filename,
            Content: a.content.toString('base64'),
            ContentType: a.contentType,
          })),
          ...(message.reference === undefined
            ? {}
            : { Metadata: { reference: message.reference } }),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ProviderError(this.provider, `request failed (${(error as Error).name})`, true);
    }
    const parsed = await response
      .json()
      .then((json: unknown) => {
        const result = postmarkResponse.safeParse(json);
        return result.success ? result.data : null;
      })
      .catch(() => null);
    if (response.ok && parsed && parsed.ErrorCode === 0 && parsed.MessageID)
      return { provider: this.provider, providerMessageId: parsed.MessageID };
    const code = parsed?.ErrorCode;
    // Codes only: Postmark's text can quote the address (CLAUDE.md section 10).
    const detail = `HTTP ${response.status}${code === undefined ? '' : ` code ${code}`}`;
    const retryable =
      code !== undefined && code !== 0
        ? !POSTMARK_PERMANENT.has(code) &&
          (response.status >= 500 || response.status === 429 || code === 405)
        : response.status >= 500 || response.status === 429;
    throw new ProviderError(this.provider, detail, retryable, response.status);
  }

  parseInbound(body: unknown): InboundEmail | null {
    return parsePostmarkInbound(body);
  }

  parseEvent(body: unknown): EmailEvent | null {
    return parsePostmarkEvent(body);
  }
}
