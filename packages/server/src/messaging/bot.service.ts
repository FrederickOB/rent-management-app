import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import {
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { formatTicketNumber } from '@rent/domain/maintenance';
import {
  balanceReplyText,
  BOT_SESSION_IDLE_MINUTES,
  botStep,
  newBotSession,
  repairLoggedText,
  seesAccount,
  type BotAction,
  type BotContext,
  type BotInput,
  type BotReceipt,
  type BotSession,
  type HandoverReason,
} from '@rent/domain/messaging';
import { money } from '@rent/domain/money';
import {
  messagingSettingsOf,
  parseCompanySettings,
  planHas,
  type SubscriptionTier,
} from '@rent/domain/settings';
import { v5 as uuidv5 } from 'uuid';
import { BillingReadService } from '../billing/billing-read.service';
import { formatReceiptNumber } from '../billing/records';
import { EntitlementsService } from '../companies/entitlements.service';
import { queueMessage, type NewMessage } from '../core/messages';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { membersWhoCan } from '../policy/members';
import { PolicyService } from '../policy/policy.service';
import { applyEvent, type ConversationRow } from './store';

const NAMESPACE = '0c6f8f3e-6f1d-4f3a-9d6f-2a0d5b1e7c41';
const STATEMENT_TEMPLATE = { key: 'tenancy.statement', version: 1 } as const;

type CompanyRow = typeof schema.company.$inferSelect;

export type BotSender =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | {
      readonly kind: 'contact';
      readonly tenantId: string;
      readonly contactId: string;
      readonly contactKind: string;
    };

/** What `bot_session.context` holds: the machine's session, who it is with, statements in hand. */
interface StoredContext {
  readonly session?: BotSession;
  readonly sender?: BotSender;
  readonly pendingStatements?: readonly {
    readonly renderRequestId: string;
    readonly leaseId: string;
    readonly filename: string;
    /** M6 review M3: who asked for it; the statement goes to them, never to whoever wrote last. */
    readonly requester?: BotSender;
  }[];
}

/**
 * Carries out the menu bot's actions (CM-03, CM-04; plan 4.5). The machine itself is pure
 * (`botStep`, packages/domain); this reads the figures from billing, queues replies on the
 * tenant's channel, asks for the statement PDF, reports repairs through maintenance, hands the
 * conversation to a person, and on Starter passes messages to the landlord (decision 9). Replies
 * have ids derived from the message they answer, so a retried job queues nothing twice.
 */
@Injectable()
export class BotService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(BillingReadService) private readonly billing: BillingReadService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  async markConsentAsked(
    tx: Tx,
    companyId: string,
    conversationId: string,
    now: Date,
  ): Promise<void> {
    await tx
      .insert(schema.botSession)
      .values({
        companyId,
        conversationId,
        state: 'menu',
        context: {},
        consentAskedAt: now,
        expiresAt: new Date(now.getTime() + BOT_SESSION_IDLE_MINUTES * 60_000),
      })
      .onConflictDoUpdate({
        target: [schema.botSession.companyId, schema.botSession.conversationId],
        set: { consentAskedAt: now, updatedAt: now },
      });
  }

  /** One inbound WhatsApp message to the bot, answered in the caller's transaction. */
  async answer(
    tx: Tx,
    input: {
      readonly companyId: string;
      readonly company: CompanyRow;
      readonly plan: SubscriptionTier;
      readonly conversation: ConversationRow;
      readonly sender: BotSender;
      readonly inbound: {
        readonly messageId: string;
        readonly text: string;
        readonly choiceId?: string;
        readonly hasMedia: boolean;
        readonly caption: string | null;
      };
      readonly lease: {
        readonly id: string;
        readonly property_id: string;
        readonly unit_id: string;
      } | null;
      readonly now: Date;
      readonly firstResponseMinutes: number;
    },
  ): Promise<void> {
    const stored = await this.load(tx, input.conversation.id);
    // A resolved conversation the tenant opens again starts with the bot again (plan 4.5).
    let session =
      stored.session && stored.session.state.name !== 'handed_over'
        ? stored.session
        : newBotSession();
    const botInput: BotInput = input.inbound.choiceId
      ? { kind: 'choice', id: input.inbound.choiceId, messageId: input.inbound.messageId }
      : input.inbound.hasMedia
        ? { kind: 'media', caption: input.inbound.caption, messageId: input.inbound.messageId }
        : { kind: 'text', text: input.inbound.text, messageId: input.inbound.messageId };
    const context = await this.context(tx, input.company, input.plan, input.sender, input.now);
    const step = botStep(session, context, botInput);
    session = step.session;
    const pending = await this.run(tx, {
      company: input.company,
      conversation: input.conversation,
      sender: input.sender,
      actions: step.actions,
      seed: input.inbound.messageId,
      now: input.now,
      firstResponseMinutes: input.firstResponseMinutes,
    });
    await this.save(
      tx,
      input.companyId,
      input.conversation.id,
      {
        session,
        sender: input.sender,
        pendingStatements: [
          ...(stored.pendingStatements ?? []),
          ...pending.map((p) => ({ ...p, requester: input.sender })),
        ],
      },
      input.now,
    );
  }

  /** Ends repair reports left open for 10 minutes (plan 4.5), from the 5-minute check. */
  async tickRepairs(companyId: string, now: Date): Promise<number> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const sessions = await tx
        .select()
        .from(schema.botSession)
        .where(eq(schema.botSession.state, 'repair'));
      const [company] = await tx
        .select()
        .from(schema.company)
        .where(eq(schema.company.id, companyId));
      if (!company) return 0;
      const plan = await this.entitlements.planIn(tx, companyId);
      const settings = messagingSettingsOf(parseCompanySettings(company.settings));
      let ended = 0;
      for (const row of sessions) {
        const stored = (row.context ?? {}) as StoredContext;
        if (!stored.session || !stored.sender) continue;
        const [conversation] = await tx
          .select()
          .from(schema.conversation)
          .where(eq(schema.conversation.id, row.conversationId));
        if (!conversation) continue;
        const context = await this.context(tx, company, plan, stored.sender, now);
        const step = botStep(stored.session, context, { kind: 'tick' });
        if (step.actions.length === 0 && step.session.state.name === stored.session.state.name)
          continue;
        await this.run(tx, {
          company,
          conversation,
          sender: stored.sender,
          actions: step.actions,
          seed: `${row.id}:tick:${stored.session.state.name === 'repair' ? stored.session.state.startedAt : ''}`,
          now,
          firstResponseMinutes: settings.inboxFirstResponseMinutes,
        });
        await this.save(
          tx,
          companyId,
          row.conversationId,
          { ...stored, session: step.session },
          now,
        );
        ended += 1;
      }
      return ended;
    });
  }

  /** The statement PDF is ready (documents.rendered): it goes to whoever asked for it. */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.botSession)
        .where(
          sql`${schema.botSession.context} -> 'pendingStatements' @> ${JSON.stringify([{ renderRequestId }])}::jsonb`,
        );
      const row = rows[0];
      if (!row) return false;
      const stored = row.context as StoredContext;
      const pending = stored.pendingStatements?.find((p) => p.renderRequestId === renderRequestId);
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      const requester = pending?.requester ?? stored.sender;
      if (!pending || !requester || !rendered?.documentId) return false;
      // Who may see the account is checked again now: a contact removed or moved to a role
      // without figures since asking gets nothing (plan 4.5).
      if (!(await this.stillSeesAccount(tx, requester))) {
        await this.save(
          tx,
          companyId,
          row.conversationId,
          {
            ...stored,
            pendingStatements: (stored.pendingStatements ?? []).filter(
              (p) => p.renderRequestId !== renderRequestId,
            ),
          },
          new Date(),
        );
        return false;
      }
      const [company] = await tx
        .select()
        .from(schema.company)
        .where(eq(schema.company.id, companyId));
      await queueMessage(tx, companyId, {
        messageId: uuidv5(`statement:${renderRequestId}`, NAMESPACE),
        recipient: recipientOf(requester),
        purpose: 'bot_reply',
        body: `Your statement from ${company?.displayName ?? 'your landlord'}.`,
        document: { documentId: rendered.documentId, filename: pending.filename },
        reply: {
          conversationId: row.conversationId,
          channel: 'whatsapp',
          authorType: 'bot',
          authorPersonId: null,
          template: null,
        },
      });
      await this.save(
        tx,
        companyId,
        row.conversationId,
        {
          ...stored,
          pendingStatements: (stored.pendingStatements ?? []).filter(
            (p) => p.renderRequestId !== renderRequestId,
          ),
        },
        new Date(),
      );
      return true;
    });
  }

  private async stillSeesAccount(tx: Tx, who: BotSender): Promise<boolean> {
    switch (who.kind) {
      case 'contact': {
        const [contact] = await tx
          .select({ kind: schema.tenantContact.kind, archivedAt: schema.tenantContact.archivedAt })
          .from(schema.tenantContact)
          .where(eq(schema.tenantContact.id, who.contactId));
        return (
          Boolean(contact && !contact.archivedAt) &&
          seesAccount({ kind: 'contact', contactKind: contact!.kind })
        );
      }
      default: {
        const [tenant] = await tx
          .select({ archivedAt: schema.tenant.archivedAt })
          .from(schema.tenant)
          .where(eq(schema.tenant.id, who.tenantId));
        return Boolean(tenant && !tenant.archivedAt);
      }
    }
  }

  /** Decision 9 (Starter): the tenant's message goes to the landlord by email and SMS. */
  async forwardToLandlord(
    tx: Tx,
    company: CompanyRow,
    messageIds: readonly string[],
    text: string,
    tenantId: string,
  ): Promise<void> {
    const [tenant] = await tx
      .select({ name: schema.tenant.displayName })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenantId));
    const people = await membersWhoCan(tx, this.policy, company, 'company.update');
    for (const personId of people)
      await queueMessage(tx, company.id, {
        messageId: uuidv5(`${messageIds[0]}:forward:${personId}`, NAMESPACE),
        recipient: { type: 'staff', personId },
        purpose: 'staff_notice',
        subject: `A message from ${tenant?.name ?? 'a tenant'}`,
        body: `${tenant?.name ?? 'A tenant'} wrote: "${text.slice(0, 1500) || '(a photo, video or voice note)'}". Reply to them by phone or WhatsApp; the message is on their record.`,
        channels: ['email', 'sms'],
        related: { type: 'tenant', id: tenantId },
      });
  }

  private async load(tx: Tx, conversationId: string): Promise<StoredContext> {
    const [row] = await tx
      .select()
      .from(schema.botSession)
      .where(eq(schema.botSession.conversationId, conversationId));
    return (row?.context ?? {}) as StoredContext;
  }

  private async save(
    tx: Tx,
    companyId: string,
    conversationId: string,
    context: StoredContext,
    now: Date,
  ): Promise<void> {
    const state = context.session?.state.name ?? 'menu';
    const expiresAt = new Date(now.getTime() + BOT_SESSION_IDLE_MINUTES * 60_000);
    await tx
      .insert(schema.botSession)
      .values({ companyId, conversationId, state, context, lastActivityAt: now, expiresAt })
      .onConflictDoUpdate({
        target: [schema.botSession.companyId, schema.botSession.conversationId],
        set: { state, context, lastActivityAt: now, expiresAt, updatedAt: now },
      });
  }

  /** The facts the machine needs: the tenant's current leases and their last three receipts. */
  private async context(
    tx: Tx,
    company: CompanyRow,
    plan: SubscriptionTier,
    sender: BotSender,
    now: Date,
  ): Promise<BotContext> {
    const leases = await tx.execute<{ id: string; code: string; name: string }>(
      sql`select l.id, u.code, p.name from lease l
          join unit u on u.company_id = l.company_id and u.id = l.unit_id
          join property p on p.company_id = l.company_id and p.id = l.property_id
          where l.tenant_id = ${sender.tenantId} and l.status in ('signed', 'active', 'ending', 'holding_over')
          order by l.start_date, l.id`,
    );
    const receipts: Record<string, BotReceipt[]> = {};
    for (const lease of leases.rows) {
      const rows = await tx.execute<{ id: string; number: number; issued_on: string }>(
        sql`select id, number, (issued_at at time zone ${company.timeZone})::date::text as issued_on from receipt
            where lease_id = ${lease.id} and kind = 'receipt' order by issued_at desc, number desc limit 3`,
      );
      receipts[lease.id] = rows.rows.map((r) => ({
        id: r.id,
        number: formatReceiptNumber(r.number),
        issuedOn: r.issued_on,
      }));
    }
    return {
      plan,
      companyName: company.displayName,
      sender: (() => {
        switch (sender.kind) {
          case 'contact':
            return { kind: 'contact' as const, contactKind: sender.contactKind };
          default:
            return { kind: 'tenant_phone' as const };
        }
      })(),
      leases: leases.rows.map((l) => ({ id: l.id, label: `${l.code}, ${l.name}` })),
      receipts,
      // M8 (decision 14): "my repairs" and the answers to work done, for the tenant themselves.
      ...(sender.kind !== 'contact' && planHas(plan, 'maintenance')
        ? { openRepairs: await this.maintenance.openRepairsFor(tx, sender.tenantId) }
        : {}),
      now: instantFrom(now),
    };
  }

  /** Carries the actions out. Returns statements now being prepared. */
  private async run(
    tx: Tx,
    input: {
      readonly company: CompanyRow;
      readonly conversation: ConversationRow;
      readonly sender: BotSender;
      readonly actions: readonly BotAction[];
      readonly seed: string;
      readonly now: Date;
      readonly firstResponseMinutes: number;
    },
  ): Promise<{ renderRequestId: string; leaseId: string; filename: string }[]> {
    const companyId = input.company.id;
    const recipient = recipientOf(input.sender);
    const pending: { renderRequestId: string; leaseId: string; filename: string }[] = [];
    let n = 0;
    const send = (
      message: Omit<NewMessage, 'recipient' | 'purpose' | 'messageId'> & {
        purpose?: NewMessage['purpose'];
      },
    ) =>
      queueMessage(tx, companyId, {
        messageId: uuidv5(`${input.seed}:bot:${n++}`, NAMESPACE),
        recipient,
        purpose: message.purpose ?? 'bot_reply',
        ...message,
        reply: message.reply ?? {
          conversationId: input.conversation.id,
          channel: 'whatsapp',
          authorType: 'bot',
          authorPersonId: null,
          template: null,
        },
      });
    const leaseFacts = async (leaseId: string) =>
      (
        await tx.execute<{
          id: string;
          property_id: string;
          unit_id: string;
          code: string;
          name: string;
          start_date: string;
        }>(
          sql`select l.id, l.property_id, l.unit_id, u.code, p.name, l.start_date::text as start_date from lease l
              join unit u on u.company_id = l.company_id and u.id = l.unit_id
              join property p on p.company_id = l.company_id and p.id = l.property_id
              where l.id = ${leaseId} and l.tenant_id = ${input.sender.tenantId}`,
        )
      ).rows[0];
    for (const action of input.actions) {
      switch (action.type) {
        case 'reply':
          await send({
            body: action.text,
            reply: {
              conversationId: input.conversation.id,
              channel: 'whatsapp',
              authorType: 'bot',
              authorPersonId: null,
              template: null,
              ...(action.choices.length > 0
                ? {
                    choices: action.choices.map((c) => ({ id: c.id, title: c.title.slice(0, 24) })),
                  }
                : {}),
            },
          });
          break;
        case 'send_balance': {
          const lease = await leaseFacts(action.leaseId);
          if (!lease) break;
          const figures = await this.billing.statementIn(
            tx,
            companyId,
            action.leaseId,
            lease.start_date,
          );
          await send({
            body: balanceReplyText({
              leaseLabel: `${lease.code}, ${lease.name}`,
              amountDue: money(figures.dueNowMinor),
              paidUntil: figures.paidUntil,
              nextDueDate: figures.nextDueDate,
            }),
          });
          break;
        }
        case 'send_receipt': {
          const [receipt] = await tx
            .select({ id: schema.receipt.id, number: schema.receipt.number })
            .from(schema.receipt)
            .where(
              and(
                eq(schema.receipt.id, action.receiptId),
                eq(schema.receipt.leaseId, action.leaseId),
              ),
            );
          if (!receipt) break;
          await send({
            body: `Your receipt ${formatReceiptNumber(receipt.number)}: {{link}}`,
            link: { purpose: 'receipt', targetId: receipt.id },
          });
          break;
        }
        case 'send_statement': {
          const lease = await leaseFacts(action.leaseId);
          if (!lease) break;
          const today = toIsoDate(businessDateOf(instantFrom(input.now), input.company.timeZone));
          const yearAgo = toIsoDate(addMonths(parseBusinessDate(today), -12));
          const from = lease.start_date > yearAgo ? lease.start_date : yearAgo;
          const figures = await this.billing.statementIn(tx, companyId, action.leaseId, from);
          const [tenant] = await tx
            .select({ name: schema.tenant.displayName })
            .from(schema.tenant)
            .where(eq(schema.tenant.id, input.sender.tenantId));
          const renderRequestId = await this.documents.requestRender(tx, {
            companyId,
            templateKey: STATEMENT_TEMPLATE.key,
            templateVersion: STATEMENT_TEMPLATE.version,
            data: {
              generatedAt: input.now.toISOString(),
              timeZone: input.company.timeZone,
              from,
              to: figures.today,
              tenant: { name: tenant?.name ?? 'Tenant' },
              landlord: { name: input.company.displayName },
              unit: { code: lease.code, propertyName: lease.name },
              lines: figures.lines.slice(-500),
              dueNowMinor: figures.dueNowMinor,
              creditMinor: figures.creditMinor,
              paidUntil: figures.paidUntil,
              nextDueDate: figures.nextDueDate,
            },
          });
          pending.push({
            renderRequestId,
            leaseId: action.leaseId,
            filename: `statement-${lease.code}.pdf`,
          });
          await send({
            body: `Your statement for ${lease.code} is being prepared. It will arrive here in a moment.`,
          });
          break;
        }
        case 'send_pay_link': {
          const card = await this.billing.leaseBillingIn(tx, companyId, action.leaseId);
          const invoiceId = card.payLink.invoiceId;
          // The bot answers in the chat the tenant wrote in, so SMS and email consent do not
          // matter here; a landlord without online payment, or nothing due, is said plainly.
          if (invoiceId && (card.payLink.available || card.payLink.reason === 'no_consent'))
            await send({
              body: `Pay securely by MoMo or card here: {{link}}`,
              link: { purpose: 'pay', targetId: invoiceId },
            });
          else
            await send({
              body:
                card.payLink.reason === 'nothing_due'
                  ? 'Nothing is due to pay now. Reply MENU for the menu.'
                  : `${card.payLink.text ?? 'Online payment is not set up for this tenancy.'} Reply MENU for the menu.`,
            });
          break;
        }
        case 'report_repair': {
          const lease = await leaseFacts(action.leaseId);
          if (!lease) break;
          const job = await this.maintenance.report(tx, companyId, {
            propertyId: lease.property_id,
            unitId: lease.unit_id,
            leaseId: lease.id,
            tenantId: input.sender.tenantId,
            source: 'whatsapp',
            description: action.description,
            conversationId: input.conversation.id,
            messageIds: action.messageIds,
            reportedBy: null,
          });
          await send({
            body: repairLoggedText(formatTicketNumber(job.ticketNumber), input.company.displayName),
          });
          break;
        }
        case 'handover':
          await this.handover(
            tx,
            input.conversation,
            action.reason,
            input.now,
            input.firstResponseMinutes,
          );
          break;
        case 'repair_response':
          await this.maintenance.botRespond(tx, {
            jobId: action.jobId,
            tenantId: input.sender.tenantId,
            response: action.response,
            reason: action.reason,
          });
          break;
        case 'forward_to_landlord':
          if (action.messageIds.length > 0) {
            const texts = await tx
              .select({ body: schema.message.body })
              .from(schema.message)
              .where(eq(schema.message.id, action.messageIds[0]!));
            await this.forwardToLandlord(
              tx,
              input.company,
              action.messageIds,
              texts[0]?.body ?? '',
              input.sender.tenantId,
            );
          }
          break;
      }
    }
    return pending;
  }

  /** A person takes over at once; the response target starts now (plan 4.5). */
  private async handover(
    tx: Tx,
    conversation: ConversationRow,
    reason: HandoverReason,
    now: Date,
    firstResponseMinutes: number,
  ): Promise<void> {
    const [fresh] = await tx
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.id, conversation.id));
    if (!fresh || fresh.state !== 'bot') return;
    await applyEvent(tx, fresh, { type: 'handover' }, instantFrom(now), firstResponseMinutes, {
      handoverReason: reason,
      handedOverAt: now,
    });
  }
}

function recipientOf(sender: BotSender): NewMessage['recipient'] {
  return sender.kind === 'contact'
    ? { type: 'tenant_contact', tenantId: sender.tenantId, contactId: sender.contactId }
    : { type: 'tenant', tenantId: sender.tenantId };
}
