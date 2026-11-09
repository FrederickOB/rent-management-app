import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database, type Tx } from '@rent/db';
import { formatBusinessDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { TIER_LABELS } from '@rent/domain/settings';
import { latestStepDue, trialReminderDue, type DunningStepKey } from '@rent/domain/subscription';
import { v5 as uuidv5 } from 'uuid';
import { queueMessage } from '../core/messages';
import { DATABASE } from '../core/tokens';
import { membersWhoCan } from '../policy/members';
import { PolicyService } from '../policy/policy.service';
import { SubscriptionCoreService, type SubscriberCompany } from './core.service';
import { lockSubscription, withPlatform } from './platform';

export const SUBSCRIPTION_LIFECYCLE_JOB = 'subscription.lifecycle';
export const SUBSCRIPTION_DUNNING_JOB = 'subscription.dunning';

const NOTICE_NAMESPACE = '5e2d8c1a-9b47-5f30-a6c2-3d4e5f60718a';

interface Notice {
  readonly key: string;
  readonly subject: string;
  readonly body: string;
  readonly relatedId: string;
}

/**
 * The subscription's days (M10 plan 4.5 and 4.10):
 * - `subscription.lifecycle` (daily, 00:15): starts a subscription for a company that has none,
 *   applies a downgrade on its day (decision 6), ends a trial (decision 5) and a cancellation
 *   (decision 12) as the status derives them, and sends the trial reminders 7 days and 1 day
 *   before the trial ends.
 * - `subscription.dunning` (daily, 09:00): the reminders for each past-due invoice (decision 11:
 *   the day after the due date, then 3, 7 and 13 days after it), and read-only once the grace has
 *   run, when the switch is on. Paying in full restores access at once (the payments service).
 * Idempotent per subscriber and day: each reminder is an event, sent once.
 */
@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SubscriptionCoreService) private readonly core: SubscriptionCoreService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  private async company(subscriberCompanyId: string): Promise<SubscriberCompany | null> {
    return withPlatform(this.database, {}, (tx) =>
      this.core.subscriberCompany(tx, subscriberCompanyId),
    );
  }

  /** `subscription.lifecycle` for one subscriber. */
  async daily(subscriberCompanyId: string, today?: string) {
    const company = await this.company(subscriberCompanyId);
    if (!company) return null;
    const day = today ?? this.core.todayIn(company.timeZone);
    const outcome = await withPlatform(this.database, {}, async (tx, platformId) => {
      await lockSubscription(tx, company.id);
      let sub = await this.core.ensure(tx, platformId, company);
      let downgraded: string | null = null;
      if (sub.pendingTier && sub.pendingTierFrom && sub.pendingTierFrom <= day) {
        await tx.execute(
          sql`update subscription set tier = ${sub.pendingTier}, pending_tier = null, pending_tier_from = null,
                updated_at = now() where id = ${sub.id}::uuid`,
        );
        await this.core.event(tx, platformId, sub, 'tier_changed', {
          tier: sub.pendingTier,
          effectiveOn: sub.pendingTierFrom,
          reason: 'downgrade',
        });
        downgraded = sub.pendingTier;
        sub = (await this.core.byId(tx, sub.id))!;
      }
      const state = await this.core.refresh(tx, platformId, sub, company, { today: day });
      const notices: Notice[] = [];
      if (state.status === 'trialing' && sub.trialEndsOn) {
        const days = trialReminderDue(sub.trialEndsOn, day);
        if (days !== null) {
          const key = `trial:${days}:${sub.trialEndsOn}`;
          if (await this.recordReminder(tx, platformId, sub, key, { days }))
            notices.push({
              key,
              relatedId: sub.id,
              subject: days === 1 ? 'Your trial ends tomorrow' : 'Your trial ends in a week',
              body: `Your free trial ends on ${formatBusinessDate(sub.trialEndsOn)}. After that your ${TIER_LABELS[sub.tier]} subscription continues and is billed monthly for the units you let. You can change your plan or cancel on the subscription page.`,
            });
        }
      }
      return { sub, state, downgraded, notices };
    });
    if (outcome.state.changed)
      await this.core.auditSubscriber(company.id, 'subscription.status_changed', outcome.sub.id, {
        from: outcome.sub.status,
        to: outcome.state.status,
      });
    if (outcome.downgraded)
      await this.core.auditSubscriber(company.id, 'subscription.tier_changed', outcome.sub.id, {
        tier: outcome.downgraded,
        reason: 'downgrade',
      });
    if (outcome.state.accessChanged)
      outcome.notices.push(this.accessNotice(outcome.sub.id, outcome.state.access, day));
    await this.notify(company, outcome.notices);
    return outcome.state;
  }

  /** `subscription.dunning` for one subscriber. */
  async dunning(subscriberCompanyId: string, today?: string) {
    const company = await this.company(subscriberCompanyId);
    if (!company) return null;
    const day = today ?? this.core.todayIn(company.timeZone);
    const outcome = await withPlatform(this.database, {}, async (tx, platformId) => {
      await lockSubscription(tx, company.id);
      const sub = await this.core.find(tx, company.id);
      if (!sub) return null;
      const notices: Notice[] = [];
      for (const invoice of await this.core.openInvoices(tx, company.id)) {
        if (invoice.outstandingMinor <= 0) continue;
        const step = latestStepDue(invoice.dueOn, day);
        if (!step) continue;
        const key = `dunning:${invoice.id}:${step.key}`;
        if (
          await this.recordReminder(tx, platformId, sub, key, {
            invoiceId: invoice.id,
            step: step.key,
          })
        )
          notices.push(
            this.dunningNotice(key, invoice.id, invoice.number, invoice.outstandingMinor, step.key),
          );
      }
      const state = await this.core.refresh(tx, platformId, sub, company, { today: day });
      return { sub, state, notices };
    });
    if (!outcome) return null;
    if (outcome.state.changed)
      await this.core.auditSubscriber(company.id, 'subscription.status_changed', outcome.sub.id, {
        from: outcome.sub.status,
        to: outcome.state.status,
      });
    if (outcome.state.accessChanged)
      outcome.notices.push(this.accessNotice(outcome.sub.id, outcome.state.access, day));
    await this.notify(company, outcome.notices);
    return outcome.state;
  }

  /** Records a reminder as an event, once per key; false when it was sent already. */
  private async recordReminder(
    tx: Tx,
    platformId: string,
    sub: { readonly id: string; readonly subscriberCompanyId: string },
    key: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const sent = await tx.execute(
      sql`select 1 from subscription_event where subscription_id = ${sub.id}::uuid
          and kind = 'reminder_sent' and data->>'key' = ${key}`,
    );
    if (sent.rows.length > 0) return false;
    await this.core.event(tx, platformId, sub, 'reminder_sent', { data: { key, ...data } });
    return true;
  }

  private dunningNotice(
    key: string,
    invoiceId: string,
    number: string,
    outstandingMinor: number,
    step: DunningStepKey,
  ): Notice {
    const amount = format(money(outstandingMinor));
    const tail =
      step === 'day_13'
        ? ' If it stays unpaid, changes by staff pause tomorrow until it is paid. Tenants can still pay rent and get receipts.'
        : ' Tenants are not affected.';
    return {
      key,
      relatedId: invoiceId,
      subject: `Subscription invoice ${number} is past due`,
      body: `Your subscription invoice ${number} has ${amount} unpaid and is past its due date. Pay it on the subscription page by MoMo or card.${tail}`,
    };
  }

  private accessNotice(subscriptionId: string, access: 'full' | 'read_only', day: string): Notice {
    return access === 'read_only'
      ? {
          key: `access:read_only:${day}`,
          relatedId: subscriptionId,
          subject: 'Changes are paused until the subscription is paid',
          body: 'Your subscription is past due, so changes by staff are paused. Nothing was deleted, and tenants can still pay rent and get receipts. Paying the subscription on the subscription page restores access at once.',
        }
      : {
          key: `access:full:${day}`,
          relatedId: subscriptionId,
          subject: 'Full access restored',
          body: 'Your subscription is paid up and full access is restored.',
        };
  }

  /** Staff notices to the subscriber's people who manage the subscription, once per event. */
  private async notify(company: SubscriberCompany, notices: readonly Notice[]): Promise<void> {
    if (notices.length === 0) return;
    await withCompany(this.database, { companyId: company.id, actorKind: 'system' }, async (tx) => {
      const people = await membersWhoCan(
        tx,
        this.policy,
        { id: company.id, kind: company.kind },
        'subscription.manage',
      );
      for (const notice of notices)
        for (const personId of people)
          await queueMessage(tx, company.id, {
            messageId: uuidv5(`${company.id}:${notice.key}:${personId}`, NOTICE_NAMESPACE),
            recipient: { type: 'staff', personId },
            purpose: 'staff_notice',
            subject: notice.subject,
            body: notice.body,
            channels: ['email'],
            related: { type: 'subscription', id: notice.relatedId },
          });
    });
  }
}
