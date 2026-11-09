import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, type Database, type Tx } from '@rent/db';
import { formatBusinessDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { TIER_LABELS } from '@rent/domain/settings';
import { latestStepDue, trialReminderDue, type DunningStepKey } from '@rent/domain/subscription';
import { DATABASE } from '../core/tokens';
import { PostingService } from '../ledger/posting.service';
import { PolicyService } from '../policy/policy.service';
import { SubscriptionCoreService, type SubscriberCompany } from './core.service';
import { settleFromCredit } from './credit';
import { notifySubscriber } from './notices';
import { lockSubscription, withPlatform } from './platform';

export const SUBSCRIPTION_LIFECYCLE_JOB = 'subscription.lifecycle';
export const SUBSCRIPTION_DUNNING_JOB = 'subscription.dunning';

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
    @Optional() @Inject(PostingService) private readonly posting: PostingService | null = null,
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
        const eventId = await this.core.event(tx, platformId, sub, 'tier_changed', {
          tier: sub.pendingTier,
          effectiveOn: sub.pendingTierFrom,
          reason: 'downgrade',
        });
        await this.core.auditSubscriberIn(
          tx,
          company.id,
          'subscription.tier_changed',
          sub.id,
          { tier: sub.pendingTier, reason: 'downgrade' },
          `subscription_event:${eventId}`,
        );
        downgraded = sub.pendingTier;
        sub = (await this.core.byId(tx, sub.id))!;
      }
      // Review BE-3: credit never sits beside debt (a reversal may have reopened an invoice).
      if (this.posting)
        await settleFromCredit(
          tx,
          { core: this.core, posting: this.posting },
          platformId,
          company.id,
          day,
        );
      const state = await this.core.refresh(tx, platformId, sub, company, { today: day });
      const notices: Notice[] = [];
      if (state.status === 'trialing' && sub.trialEndsOn) {
        const days = trialReminderDue(sub.trialEndsOn, day);
        if (days !== null) {
          const key = `trial:${days}:${sub.trialEndsOn}`;
          // Recorded once; queued on every run, so a retry still sends it (ids fixed, BE-12).
          await this.recordReminder(tx, platformId, sub, key, { days });
          notices.push({
            key,
            relatedId: sub.id,
            subject: days === 1 ? 'Your trial ends tomorrow' : 'Your trial ends in a week',
            body: `Your free trial ends on ${formatBusinessDate(sub.trialEndsOn)}. After that your ${TIER_LABELS[sub.tier]} subscription continues and is billed monthly for the units you let. You can change your plan or cancel on the subscription page.`,
          });
        }
      }
      const readOnly = this.readOnlyNotice(sub.id, state);
      if (readOnly) notices.push(readOnly);
      for (const notice of notices) await this.queue(tx, platformId, company.id, notice);
      return { sub, state, downgraded, notices };
    });
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
        // Recorded once; queued on every run, so a retry still sends it (ids fixed, BE-12).
        await this.recordReminder(tx, platformId, sub, key, {
          invoiceId: invoice.id,
          step: step.key,
        });
        notices.push(
          this.dunningNotice(key, invoice.id, invoice.number, invoice.outstandingMinor, step.key),
        );
      }
      const state = await this.core.refresh(tx, platformId, sub, company, { today: day });
      const readOnly = this.readOnlyNotice(sub.id, state);
      if (readOnly) notices.push(readOnly);
      for (const notice of notices) await this.queue(tx, platformId, company.id, notice);
      return { sub, state, notices };
    });
    if (!outcome) return null;
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

  /**
   * While read-only for arrears, the notice saying so, keyed by the day read-only began, so it is
   * queued on every run and sent once (review BE-12). A cancelled company is told by its
   * cancellation instead. Paying in full tells the admins it is restored (the payments service).
   */
  private readOnlyNotice(
    subscriptionId: string,
    state: {
      readonly status: string;
      readonly access: string;
      readonly readOnlyFrom: string | null;
    },
  ): Notice | null {
    if (state.access !== 'read_only' || state.status === 'cancelled') return null;
    return {
      key: `access:read_only:${state.readOnlyFrom ?? 'now'}`,
      relatedId: subscriptionId,
      subject: 'Changes are paused until the subscription is paid',
      body: 'Your subscription is past due, so changes by staff are paused. Nothing was deleted, and tenants can still pay rent and get receipts. Paying the subscription on the subscription page restores access at once.',
    };
  }

  /** A notice to the subscriber's admins, in the platform's outbox with the change (BE-12). */
  private async queue(tx: Tx, platformId: string, companyId: string, notice: Notice) {
    await notifySubscriber(tx, platformId, companyId, {
      key: notice.key,
      subject: notice.subject,
      body: notice.body,
      related: { type: 'subscription', id: notice.relatedId },
    });
  }
}
