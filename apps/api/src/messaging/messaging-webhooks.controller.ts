import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { verifyMetaChallenge } from '@rent/integrations';
import { CONFIG, type AppConfig } from '@rent/server/core';
import { InboundService, type MessagingWebhookKind } from '@rent/server/messaging';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../http/guards';

/** What Meta's verification sends locally, when no verify token is configured (never production). */
const DEV_META_VERIFY_TOKEN = 'fake-providers-verify-token-dev-only';

/** Our secret on a Hubtel or Postmark webhook: `?secret=` or the Basic auth password. */
function secretOf(request: FastifyRequest): string | null {
  const query = request.query as Record<string, unknown> | undefined;
  if (typeof query?.secret === 'string') return query.secret;
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon >= 0 ? decoded.slice(colon + 1) : null;
}

/**
 * Messaging webhooks (plan 4.4; CLAUDE.md section 8), outside the contracts. Each request is
 * checked (Meta's signature; our secret on Hubtel's and Postmark's URLs), stored in the webhook
 * inbox one row per message or status, and answered at once; the worker processes it. A bad
 * signature or secret is stored as rejected, without its body, and answered 401.
 */
@Public()
@Controller('webhooks')
export class MessagingWebhooksController {
  constructor(
    @Inject(InboundService) private readonly inbound: InboundService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Meta's subscription check: the challenge back, only for our verify token. */
  @Get('whatsapp')
  verify(@Query() query: Record<string, unknown>, @Res() reply: FastifyReply): void {
    const token =
      this.config.META_VERIFY_TOKEN ??
      (this.config.NODE_ENV === 'production' ? '' : DEV_META_VERIFY_TOKEN);
    const challenge = verifyMetaChallenge(query, token);
    if (challenge === null) {
      void reply.status(403).type('text/plain').send('forbidden');
      return;
    }
    void reply.status(200).type('text/plain').send(challenge);
  }

  @Post('whatsapp')
  @HttpCode(200)
  whatsapp(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.receive('whatsapp', request, reply);
  }

  @Post('sms/inbound')
  @HttpCode(200)
  smsInbound(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.receive('sms_inbound', request, reply);
  }

  @Post('sms/status')
  @HttpCode(200)
  smsStatus(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.receive('sms_status', request, reply);
  }

  @Post('email/inbound')
  @HttpCode(200)
  emailInbound(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.receive('email_inbound', request, reply);
  }

  @Post('email/events')
  @HttpCode(200)
  emailEvents(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.receive('email_events', request, reply);
  }

  private async receive(
    kind: MessagingWebhookKind,
    request: RawBodyRequest<FastifyRequest>,
    reply: FastifyReply,
  ): Promise<{ received: boolean }> {
    const raw = request.rawBody ?? Buffer.from('');
    const result = await this.inbound.intake(kind, raw, {
      headers: request.headers,
      secret: secretOf(request),
      ip: request.ip,
    });
    const refused: Partial<Record<typeof result, number>> = {
      rejected: 401,
      too_large: 413,
      rate_limited: 429,
    };
    const status = refused[result];
    if (status) {
      void reply.status(status);
      return { received: false };
    }
    return { received: true };
  }
}
