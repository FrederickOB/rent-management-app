import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PolicyModule } from '../policy/policy.module';
import { DeadLetterService } from './dead-letters.service';
import { WorkerHeartbeatService } from './heartbeat';
import { OpsPruningService } from './pruning.service';
import { QueueMonitorService } from './queues.service';
import { WebhookReplayService } from './webhook-replay.service';

/**
 * Operations for platform admins (M11 decision 9; plan 4.7): failed and dead-lettered webhooks
 * with replay, dead-lettered jobs with retry, queue depth and age with alerts, the worker's
 * heartbeat, and the daily pruning. Every console route is for platform admins, through
 * PolicyService (`health.read` to look, `platform.ops.replay` and `platform.ops.redrive` to act);
 * each action takes a reason and is audited in the platform's chain.
 */
@Module({
  imports: [AuditModule, PolicyModule],
  providers: [
    WebhookReplayService,
    DeadLetterService,
    QueueMonitorService,
    WorkerHeartbeatService,
    OpsPruningService,
  ],
  exports: [
    WebhookReplayService,
    DeadLetterService,
    QueueMonitorService,
    WorkerHeartbeatService,
    OpsPruningService,
  ],
})
export class OpsModule {}
