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
 * Email (CLAUDE.md section 8). SMTP now, Mailpit locally; the sending provider is chosen in M6.
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
  readonly attachments: readonly EmailAttachment[];
}

export interface EmailPort {
  readonly provider: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
  /** An inbound email webhook body, or null when the body is not one. */
  parseInbound(body: unknown): InboundEmail | null;
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

export function parseInboundEmail(body: unknown): InboundEmail | null {
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

  close(): void {
    this.transport.close();
  }
}
