import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, schema, sql, withCompany, type Database } from '@rent/db';
import { overdueAlertKey, overdueAlertRecipients } from '@rent/domain/messaging';
import { DEFAULT_INTERIM_PLAN, isInterimPlan, planHas } from '@rent/domain/settings';
import type { PushPort } from '@rent/integrations';
import { v5 as uuidv5 } from 'uuid';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { queueMessage } from '../core/messages';
import { CLOCK, CONFIG, DATABASE, PUSH_PORT } from '../core/tokens';
import { membersWhoCan } from '../policy/members';
import { PolicyService } from '../policy/policy.service';
import { BotService } from './bot.service';
import { MessagingService } from './messaging.service';

export const SLA_CHECK_JOB = 'messaging.sla-check';
export const PUSH_RECEIPTS_JOB = 'messaging.push-receipts';
export const SYNC_TEMPLATES_JOB = 'messaging.sync-templates';
const NAMESPACE = '0c6f8f3e-6f1d-4f3a-9d6f-2a0d5b1e7c41';
/** Expo takes up to 1,000 receipt ids a call; it keeps receipts for 24 hours. */
const RECEIPT_BATCH = 300;
const RECEIPT_HOURS = 24;

/**
 * Messaging's scheduled work (plan 4.13): the overdue check (CM-06; decision 10), the bot's repair
 * timer (CM-04), and push receipts (decision 5). Each is idempotent: an overdue alert once per
 * conversation and deadline, a receipt once per message.
 */
@Injectable()
export class MessagingOperationsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(BotService) private readonly bot: BotService,
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Optional() @Inject(PUSH_PORT) private readonly push: PushPort | null = null,
  ) {}

  /**
   * `messaging.sla-check`, per company: each conversation past its first-response target alerts
   * its assignee, or when unassigned the managers who see it, once per deadline. By email only:
   * staff WhatsApp needs an opt-in nothing records yet (OQ-33).
   */
  async slaCheck(companyId: string): Promise<{ alerted: number; repairs: number }> {
    const now = this.clock.now();
    const alerted = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => {
        const [company] = await tx
          .select()
          .from(schema.company)
          .where(eq(schema.company.id, companyId));
        if (!company) return 0;
        // Review S5: a company without the inbox (Starter) has no response target to miss.
        if (
          !planHas(
            isInterimPlan(company.interimPlan) ? company.interimPlan : DEFAULT_INTERIM_PLAN,
            'inbox',
          )
        )
          return 0;
        const overdue = await tx.execute<{
          id: string;
          assigned_to: string | null;
          first_response_due_at: Date;
          tenant_id: string | null;
          tenant_name: string | null;
          property_id: string | null;
          owner_id: string | null;
        }>(
          sql`select c.id, c.assigned_to, c.first_response_due_at, c.tenant_id, t.display_name as tenant_name,
                   l.property_id, o.owner_id
            from conversation c
            left join tenant t on t.company_id = c.company_id and t.id = c.tenant_id
            left join lateral (select property_id from lease where company_id = c.company_id and tenant_id = c.tenant_id
                               and status <> 'draft' order by start_date desc limit 1) l on true
            left join property_current_ownership o on o.company_id = c.company_id and o.property_id = l.property_id
            where c.state in ('open', 'assigned') and c.merged_into_id is null
              and c.first_response_due_at is not null and c.first_response_due_at <= ${now}`,
        );
        let n = 0;
        for (const c of overdue.rows) {
          const due = new Date(c.first_response_due_at).toISOString();
          const key = overdueAlertKey(c.id, due);
          const fresh = await tx
            .insert(schema.processedJob)
            .values({ companyId, key, jobName: SLA_CHECK_JOB })
            .onConflictDoNothing()
            .returning({ key: schema.processedJob.key });
          if (fresh.length === 0) continue;
          // Unassigned: those who may assign it and see it (triage: the whole-company people only).
          const managers = c.assigned_to
            ? []
            : await membersWhoCan(tx, this.policy, company, 'messaging.assign', {
                propertyId: c.property_id,
                ownerId: c.owner_id,
              });
          const who = c.tenant_name ?? 'Someone not yet linked to a tenant';
          for (const personId of overdueAlertRecipients({
            assigneeId: c.assigned_to,
            managerIds: managers,
          }))
            await queueMessage(tx, companyId, {
              messageId: uuidv5(`${key}:${personId}`, NAMESPACE),
              recipient: { type: 'staff', personId },
              purpose: 'overdue_alert',
              subject: `Waiting for a reply: ${who}`,
              body: `${who} has waited past your response target for a reply. Open the conversation: ${this.config.WEB_ORIGIN}/inbox/${c.id}`,
              channels: ['email'],
              related: { type: 'conversation', id: c.id },
            });
          n += 1;
        }
        return n;
      },
    );
    const repairs = await this.bot.tickRepairs(companyId, now);
    return { alerted, repairs };
  }

  /**
   * `messaging.push-receipts`, per company: asks Expo what became of each push sent in the last
   * day. A message with any token delivered is delivered; one whose every token failed is failed,
   * and when push was its channel the next one is tried (the fallback in CM-09).
   */
  async pushReceipts(companyId: string): Promise<{ delivered: number; failed: number }> {
    if (!this.push) return { delivered: 0, failed: 0 };
    const since = new Date(this.clock.now().getTime() - RECEIPT_HOURS * 3_600_000);
    const tickets = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx.execute<{ message_id: string; ticket: string; push_main: boolean }>(
        sql`select e.message_id, e.provider_message_id as ticket,
                   not exists (select 1 from message_event x where x.company_id = e.company_id and x.message_id = e.message_id
                               and x.status = 'sent' and x.channel <> 'push') as push_main
            from message_event e
            where e.status = 'sent' and e.channel = 'push' and e.provider = ${this.push!.provider} and e.occurred_at >= ${since}
              and not exists (select 1 from message_event x where x.company_id = e.company_id and x.message_id = e.message_id
                              and x.channel = 'push' and x.status in ('delivered', 'failed'))
            order by e.occurred_at limit 2000`,
      ),
    );
    const byMessage = new Map<string, { tickets: string[]; pushMain: boolean }>();
    for (const t of tickets.rows) {
      const entry = byMessage.get(t.message_id) ?? { tickets: [], pushMain: t.push_main };
      entry.tickets.push(t.ticket);
      byMessage.set(t.message_id, entry);
    }
    const all = tickets.rows.map((t) => t.ticket);
    const receipts = new Map<string, Awaited<ReturnType<PushPort['getReceipts']>>[number]>();
    for (let i = 0; i < all.length; i += RECEIPT_BATCH)
      for (const r of await this.push.getReceipts(all.slice(i, i + RECEIPT_BATCH)))
        receipts.set(r.ticketId, r);
    let delivered = 0;
    let failed = 0;
    await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      for (const [messageId, entry] of byMessage) {
        const mine = entry.tickets.map((t) => receipts.get(t));
        const ok = entry.tickets.find((t) => receipts.get(t)?.status === 'ok');
        if (ok) {
          await tx
            .insert(schema.messageEvent)
            .values({
              companyId,
              messageId,
              status: 'delivered',
              channel: 'push',
              provider: this.push!.provider,
              providerMessageId: ok,
              destinationMasked: 'app',
            })
            .onConflictDoNothing();
          delivered += 1;
          continue;
        }
        if (!mine.every((r) => r?.status === 'error')) continue;
        const first = mine[0];
        await tx.insert(schema.messageEvent).values({
          companyId,
          messageId,
          status: 'failed',
          channel: 'push',
          provider: this.push!.provider,
          providerMessageId: entry.tickets[0]!,
          // Refused for good: the app is gone or the token is not ours. Push is not tried again.
          reason: 'provider_refused',
          destinationMasked: 'app',
        });
        failed += 1;
        if (entry.pushMain && first?.status === 'error')
          await this.messaging.redeliver(tx, companyId, messageId, `push:${entry.tickets[0]!}`);
      }
    });
    return { delivered, failed };
  }
}
