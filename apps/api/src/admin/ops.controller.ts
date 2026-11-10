import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import {
  DeadLetterService,
  QueueMonitorService,
  WebhookReplayService,
  WorkerHeartbeatService,
} from '@rent/server/ops';
import { serialize } from '../http/serialize';
import { Ctx, type RequestContext } from '../http/request-context';

/**
 * Operations in the platform admin console (M11 decision 9; plan 4.7): failed and dead-lettered
 * webhooks with replay, dead-lettered jobs with retry, each queue's oldest job and the worker's
 * heartbeat. Platform admins only, through PolicyService in each service: `health.read` to look,
 * `platform.ops.replay` and `platform.ops.redrive` to act. A replay or retry takes a reason, is
 * audited in the platform's chain and runs the normal idempotent path, so doing it twice changes
 * nothing; no Idempotency-Key is needed.
 */
@Controller()
export class OpsController {
  constructor(
    @Inject(WebhookReplayService) private readonly webhooks: WebhookReplayService,
    @Inject(DeadLetterService) private readonly deadLetters: DeadLetterService,
    @Inject(QueueMonitorService) private readonly queues: QueueMonitorService,
    @Inject(WorkerHeartbeatService) private readonly heartbeats: WorkerHeartbeatService,
  ) {}

  @Implement(contract.platformOps)
  platformOpsRouter(@Ctx() ctx: RequestContext) {
    const c = contract.platformOps;
    const a = ctx.actor;
    return {
      webhooks: implement(c.webhooks).handler(async ({ input }) =>
        serialize(await this.webhooks.list(a, input)),
      ),
      replayWebhook: implement(c.replayWebhook).handler(async ({ input }) =>
        serialize(await this.webhooks.replay(a, input.webhookId, input.reason, ctx.requestId)),
      ),
      jobs: implement(c.jobs).handler(async ({ input }) =>
        serialize(await this.deadLetters.list(a, input)),
      ),
      retryJob: implement(c.retryJob).handler(async ({ input }) =>
        serialize(await this.deadLetters.retry(a, input.jobId, input.reason, ctx.requestId)),
      ),
      queues: implement(c.queues).handler(async () => serialize(await this.queues.queues(a))),
      heartbeat: implement(c.heartbeat).handler(async () =>
        serialize(await this.heartbeats.heartbeat(a)),
      ),
    };
  }
}
