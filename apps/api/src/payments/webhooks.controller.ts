import { Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { WebhooksService } from '@rent/server/payments';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../http/guards';

/**
 * Provider webhooks (CLAUDE.md section 8; M4b plan 4.4), outside the contracts. The raw request is
 * stored in the inbox first, then its signature is checked, then the answer goes: 200 for a
 * signed event (stored or a replay), 401 for a bad signature (stored as rejected, alerted). The
 * money is posted later, from the provider's verify answer, never from this body.
 */
@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ received: boolean }> {
    const raw = request.rawBody ?? Buffer.from('');
    const result = await this.webhooks.intake(provider, raw, request.headers);
    if (result === 'unknown_provider') {
      void reply.status(404);
      return { received: false };
    }
    if (result === 'rejected') {
      void reply.status(401);
      return { received: false };
    }
    return { received: true };
  }
}
