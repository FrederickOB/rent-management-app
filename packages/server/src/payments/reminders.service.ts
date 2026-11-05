import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, schema, sql, withCompany, type Database } from '@rent/db';
import { formatBusinessDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { carriesInvoice, invoiceRemainingMinor, reminderDue } from '@rent/domain/payments';
import { parseCompanySettings, paymentSettingsOf } from '@rent/domain/settings';
import type { AppLogger } from '../core/logging/logger';
import { BillingEngine } from '../billing/engine';
import { formatInvoiceNumber, leaseGroup, lockLeases } from '../billing/records';
import { destinationForOwner } from '../companies/settlement-destinations';
import { queueMessage } from '../core/messages';
import { DATABASE, LOGGER } from '../core/tokens';

const BILLED = ['signed', 'active', 'ending', 'holding_over', 'ended', 'terminated'];

/**
 * The rent reminder ladder (BC-09; M4b plan 4.7): `billing.rent-reminders`, daily. For each open
 * invoice, the latest step that is due and not yet done is sent (earlier missed steps are recorded
 * as skipped, so a tenant never gets a burst); each step goes once per invoice; the ladder stops
 * as soon as nothing is left to pay after the lease's credit. The message carries the pay link,
 * and the first step also the invoice (through the pay page). Consent per channel and test
 * contacts are the messaging core's rules (CM-09).
 */
@Injectable()
export class RemindersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** One company's run for a day. Returns the reminders queued. */
  async run(companyId: string, today: string): Promise<number> {
    const ctx = { companyId, actorKind: 'system' as const };
    // Invoices whose ladder can still have a step: due within the last step's reach, plus a week
    // for a run the job missed. Older arrears are not reminded late (the dashboard shows them).
    const leases = await withCompany(this.database, ctx, async (tx) => {
      const [company] = await tx
        .select()
        .from(schema.company)
        .where(eq(schema.company.id, companyId));
      const offsets = paymentSettingsOf(
        parseCompanySettings(company?.settings),
      ).reminderOffsetsDays;
      const reach = Math.max(0, ...offsets) + 7;
      return tx.execute<{ lease_id: string }>(
        sql`select distinct i.lease_id from invoice i join lease l on l.company_id = i.company_id and l.id = i.lease_id
            where i.kind in ('cycle', 'deposit') and l.status in ('signed', 'active', 'ending', 'holding_over', 'ended', 'terminated')
              and i.due_date >= (${today}::date - ${reach}::int)`,
      );
    });
    let sent = 0;
    for (const { lease_id: leaseId } of leases.rows) {
      try {
        sent += await withCompany(this.database, ctx, async (tx) => {
          await lockLeases(tx, companyId, await leaseGroup(tx, leaseId));
          const state = await this.engine.load(tx, companyId, leaseId);
          if (!BILLED.includes(state.lease.status) || state.book.kind !== 'book') return 0;
          const settings = paymentSettingsOf(parseCompanySettings(state.company.settings));
          const destination = await destinationForOwner(
            tx,
            state.company,
            state.book.ownerId,
            today,
          );
          const walk = this.engine.walk(state);
          const invoiceIds = [...new Set(state.lines.map((l) => l.invoiceId))];
          if (invoiceIds.length === 0) return 0;
          const invoices = await tx
            .select()
            .from(schema.invoice)
            .where(
              and(
                inArray(schema.invoice.id, invoiceIds),
                inArray(schema.invoice.kind, ['cycle', 'deposit']),
              ),
            );
          const done = await tx
            .select({
              invoiceId: schema.reminderSent.invoiceId,
              offsetDays: schema.reminderSent.offsetDays,
            })
            .from(schema.reminderSent)
            .where(inArray(schema.reminderSent.invoiceId, invoiceIds));
          let queued = 0;
          for (const invoice of invoices) {
            const remaining = invoiceRemainingMinor({
              invoiceLines: state.lines.filter((l) => l.invoiceId === invoice.id),
              allocations: state.allocations,
              walk,
            });
            const decision = reminderDue({
              dueDate: invoice.dueDate,
              offsetsDays: settings.reminderOffsetsDays,
              today,
              done: new Set(
                done.filter((d) => d.invoiceId === invoice.id).map((d) => d.offsetDays),
              ),
              outstandingMinor: remaining,
            });
            const row = {
              companyId,
              propertyId: invoice.propertyId,
              tenantId: invoice.tenantId,
              leaseId: invoice.leaseId,
              invoiceId: invoice.id,
            };
            for (const step of decision.skip)
              await tx
                .insert(schema.reminderSent)
                .values({
                  ...row,
                  offsetDays: step.offsetDays,
                  status: 'skipped',
                  stepDate: step.date,
                })
                .onConflictDoNothing();
            const step = decision.send;
            if (!step) continue;
            const first = carriesInvoice(step, settings.reminderOffsetsDays);
            const due = invoice.dueDate;
            const when =
              step.offsetDays < 0
                ? `due on ${formatBusinessDate(due)}`
                : step.offsetDays === 0
                  ? 'due today'
                  : `overdue since ${formatBusinessDate(due)}`;
            const payable = destination.kind === 'ok';
            const messageId = await queueMessage(tx, companyId, {
              recipient: { type: 'tenant', tenantId: invoice.tenantId },
              purpose: 'rent_reminder',
              subject: `${formatInvoiceNumber(invoice.number)}: ${format(money(remaining))} ${when}`,
              body: [
                `${state.company.displayName}: ${first ? `your invoice ${formatInvoiceNumber(invoice.number)} for ${state.lease.unitCode}` : `${formatInvoiceNumber(invoice.number)} for ${state.lease.unitCode}`} is ${when}; ${format(money(remaining))} to pay.`,
                payable
                  ? first
                    ? 'See the invoice and pay by MoMo or card: {{link}}'
                    : 'Pay by MoMo or card: {{link}}'
                  : 'Pay your landlord as usual, quoting your payment reference.',
              ].join(' '),
              link: payable ? { purpose: 'pay', targetId: invoice.id } : null,
              // M6 (plan 4.9): every channel in the business order, each with its consent.
              channels: ['push', 'whatsapp', 'sms', 'email'],
              propertyId: invoice.propertyId,
              related: { type: 'invoice', id: invoice.id },
            });
            const inserted = await tx
              .insert(schema.reminderSent)
              .values({
                ...row,
                offsetDays: step.offsetDays,
                status: 'sent',
                stepDate: step.date,
                messageId,
              })
              .onConflictDoNothing()
              .returning({ id: schema.reminderSent.id });
            // A concurrent run took this step first: its message is the one that goes.
            if (inserted.length === 0) throw new Error('reminder step taken concurrently');
            queued += 1;
          }
          return queued;
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'reminder step taken concurrently')
          continue;
        this.logger.error({ err: error, leaseId }, 'rent reminders failed for a lease');
      }
    }
    return sent;
  }
}
