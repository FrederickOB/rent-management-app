import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { INBOX_STREAM_PATH } from '@rent/contracts';
import { InboxStreamService } from '@rent/server/messaging';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Ctx, type RequestContext } from '../http/request-context';

/** Proxies (Nginx, the Next proxy) must not buffer the stream; a heartbeat keeps it open. */
const HEARTBEAT_MS = 20_000;

/**
 * The live inbox (plan 4.6), a server-sent event stream outside the contract, with the staff
 * session. It opens with the comment `: ok`, sends a heartbeat comment every 20 seconds, and
 * one named event per change (`conversation`, `message`, `message_event`, `message_attachment`)
 * whose data is `{ kind, conversationId, messageId }`: ids only, for conversations the person may
 * see. The client fetches what changed through the API.
 */
@Controller()
export class InboxStreamController {
  constructor(@Inject(InboxStreamService) private readonly stream: InboxStreamService) {}

  @Get(INBOX_STREAM_PATH)
  async open(
    @Ctx() ctx: RequestContext,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Checked before the stream opens, so a refusal is an ordinary JSON error.
    await this.stream.authorize(ctx.actor);
    reply.hijack();
    const raw = reply.raw;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined)
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
      'x-request-id': String(request.id),
    });
    raw.write(': ok\n\n');
    let closed = false;
    const write = (chunk: string) => {
      if (!closed) raw.write(chunk);
    };
    // Each heartbeat checks again that the person may still have the stream (review S-9).
    const beat = setInterval(() => {
      void this.stream.stillAllowed(ctx.actor).then((allowed) => {
        if (allowed) write(': heartbeat\n\n');
        else {
          close();
          raw.end();
        }
      });
    }, HEARTBEAT_MS);
    beat.unref();
    let stop: () => void = () => undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      stop();
    };
    request.raw.on('close', close);
    raw.on('error', close);
    try {
      stop = await this.stream.subscribe(ctx.actor, (event) =>
        write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`),
      );
      if (closed) stop();
    } catch {
      close();
      raw.end();
    }
  }
}
