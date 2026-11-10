import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database, type Tx } from '@rent/db';
import { v5 as uuidv5 } from 'uuid';
import { queueMessage } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { DATABASE } from '../core/tokens';
import { membersWhoCan } from '../policy/members';
import { PolicyService } from '../policy/policy.service';

/** The outbox event a subscription notice travels in: from the platform company to a job. */
export const SUBSCRIPTION_NOTIFY_EVENT = 'subscription.notify';

const NOTICE_NAMESPACE = '2f9b6c4e-8d1a-5e3b-9c7d-4a5b6c7d8e9f';

export interface SubscriptionNotice {
  /** Stable per event: the notice is queued once, whatever the retries. */
  readonly key: string;
  readonly subject: string;
  readonly body: string;
  readonly related: { readonly type: string; readonly id: string };
}

/**
 * Queues a staff notice to a subscriber's admins in the platform company's outbox, inside the
 * subscription engine's own transaction (M10 review BE-12 and BE-16): it commits with the change
 * or not at all, and the platform never writes in a customer company from a request. The
 * `subscription.notify` job delivers it in the subscriber's context, as the system.
 */
export async function notifySubscriber(
  tx: Tx,
  platformId: string,
  subscriberCompanyId: string,
  notice: SubscriptionNotice,
): Promise<void> {
  await enqueueOutbox(tx, {
    companyId: platformId,
    type: SUBSCRIPTION_NOTIFY_EVENT,
    payload: { subscriberCompanyId, ...notice },
    idempotencyKey: `${SUBSCRIPTION_NOTIFY_EVENT}:${subscriberCompanyId}:${notice.key}`,
  });
}

/** The `subscription.notify` job: the notice to each person who manages the subscription. */
@Injectable()
export class SubscriptionNoticesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  async deliver(subscriberCompanyId: string, notice: SubscriptionNotice): Promise<number> {
    return withCompany(
      this.database,
      { companyId: subscriberCompanyId, actorKind: 'system' },
      async (tx) => {
        const rows = await tx.execute<{ id: string; kind: string }>(
          sql`select id, kind from company where id = ${subscriberCompanyId}::uuid`,
        );
        const company = rows.rows[0];
        if (!company) return 0;
        const people = await membersWhoCan(tx, this.policy, company, 'subscription.manage');
        for (const personId of people)
          await queueMessage(tx, subscriberCompanyId, {
            messageId: uuidv5(`${subscriberCompanyId}:${notice.key}:${personId}`, NOTICE_NAMESPACE),
            recipient: { type: 'staff', personId },
            purpose: 'staff_notice',
            subject: notice.subject,
            body: notice.body,
            channels: ['email'],
            related: notice.related,
          });
        return people.length;
      },
    );
  }
}
