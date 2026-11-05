import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withCompany, type Database } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { BillingEngine } from '../billing/engine';
import { leaseGroup, lockLeases, paymentsByIds } from '../billing/records';
import { staffActor } from '../companies/companies.service';
import { DATABASE } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RentTaxService } from './rent-tax.service';
import {
  appendTaxEvent,
  ASSESSED_ACTION,
  notAssessedEvents,
  uuids,
  type NotAssessedEvent,
} from './tax-records';

export interface NotAssessedView {
  readonly eventKey: string;
  readonly event: NotAssessedEvent['event'];
  readonly leaseId: string;
  readonly ownerId: string;
  readonly unitCode: string;
  readonly paymentId: string | null;
  readonly withholdingId: string | null;
  readonly valueDate: string;
  readonly reason: NotAssessedEvent['reason'];
  readonly ruleKey: string | null;
  readonly message: string;
  readonly recordedAt: Date;
  readonly assessed: boolean;
}

/**
 * Rent tax that could not be assessed when the money posted (TX-08; M5 review 7): a rules row it
 * needs was missing, or is not one this build applies. The receipt, carry-over or withholding
 * posted all the same and a person was alerted (`tax.not_assessed`). This run
 * (`tax.assess-pending`, daily before TX-02's alerts) assesses each once the rules in force on its
 * value date allow, on the key P17 would have used, and records in the audit log that it did.
 * What has moved on since (a payment reversed, a certificate decided) is left for a person.
 */
@Injectable()
export class TaxAssessmentService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(RentTaxService) private readonly rentTax: RentTaxService,
  ) {}

  /** Events not assessed, oldest first, that the person may see (their owners and leases). */
  async list(
    actor: Actor | null,
    filter: { readonly ownerId?: string; readonly open?: boolean } = {},
  ): Promise<NotAssessedView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const events = await notAssessedEvents(tx, filter);
      if (events.length === 0) return [];
      // Leases outside the person's scope are not visible to them (AD-02).
      const visible = new Set(
        (
          await tx
            .select({ id: schema.lease.id })
            .from(schema.lease)
            .where(sql`${schema.lease.id} = any(${uuids(events.map((e) => e.leaseId))})`)
        ).map((l) => l.id),
      );
      return events
        .filter((e) => visible.has(e.leaseId))
        .map((e) => ({
          eventKey: e.eventKey,
          event: e.event,
          leaseId: e.leaseId,
          ownerId: e.ownerId,
          unitCode: e.unitCode,
          paymentId: e.paymentId,
          withholdingId: e.withholdingId,
          valueDate: e.valueDate,
          reason: e.reason,
          ruleKey: e.ruleKey,
          message: e.message,
          recordedAt: e.recordedAt,
          assessed: e.assessed,
        }));
    });
  }

  /** One company's run. Returns how many events it assessed (or left for a person). */
  async run(companyId: string): Promise<number> {
    const open = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      notAssessedEvents(tx, { open: true }),
    );
    let done = 0;
    for (const event of open) if (await this.assessOne(companyId, event)) done += 1;
    return done;
  }

  private async assessOne(companyId: string, e: NotAssessedEvent): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      await lockLeases(tx, companyId, await leaseGroup(tx, e.leaseId));
      // Another run may have assessed it while this one waited for the locks.
      const again = await notAssessedEvents(tx, { leaseId: e.leaseId, open: true });
      if (!again.some((x) => x.eventKey === e.eventKey)) return false;
      const state = await this.engine.load(tx, companyId, e.leaseId);
      const a = await this.rentTax.rulesAssessment(tx, state, e.valueDate);
      if (a.kind === 'not_assessed') return false;
      let itemId: string | null = null;
      let note: string | null = null;
      if (e.event === 'receipt' || e.event === 'carry_over' || e.event === 'deposit_applied') {
        const [payment] = e.paymentId ? await paymentsByIds(tx, [e.paymentId]) : [];
        if (payment?.reversedAccountingDate)
          note = 'The payment was reversed before it was assessed';
        else if (e.event === 'receipt') {
          const [receipt] = await tx
            .select({ number: schema.receipt.number })
            .from(schema.receipt)
            .where(
              sql`${schema.receipt.paymentId} = ${e.paymentId} and ${schema.receipt.kind} = 'receipt'`,
            );
          const capRentOnly = (e as { capRentOnlyMinor?: number }).capRentOnlyMinor;
          itemId = await this.rentTax.assessReceipt(tx, state, {
            key: e.eventKey,
            paymentId: e.paymentId!,
            valueDate: e.valueDate,
            capMinor: a.rules.includesServiceCharge ? e.capMinor : (capRentOnly ?? e.capMinor),
            receiptNumber: receipt?.number ?? null,
            rules: a.rules,
            causedBy: null,
          });
        } else
          itemId = await this.rentTax.assessCarryOver(tx, state, {
            key: e.eventKey,
            paymentId: e.paymentId,
            valueDate: e.valueDate,
            capMinor: e.capMinor,
            rules: a.rules,
            kind: e.event === 'deposit_applied' ? 'deposit_applied' : 'carry_over',
          });
      } else {
        const [w] = await tx
          .select()
          .from(schema.withholding)
          .where(eq(schema.withholding.id, e.withholdingId!));
        const decided = await tx.execute<{ decided: boolean }>(
          sql`select exists (select 1 from withholding_certificate c where c.withholding_id = ${e.withholdingId}
                and c.status = 'confirmed')
              or exists (select 1 from withholding_write_off o where o.withholding_id = ${e.withholdingId}) as decided`,
        );
        if (!w) note = 'The withholding was not found';
        else if (decided.rows[0]!.decided)
          note = 'Its certificate was confirmed or written off before it was assessed';
        else {
          const lines = await tx.execute<{ line_id: string; amount: string }>(
            sql`select invoice_line_id as line_id, sum(amount_minor)::bigint as amount from allocation
                where record_type = 'withholding' and record_id = ${w.id} and source = 'withholding'
                group by invoice_line_id`,
          );
          await this.rentTax.taxWithholding(
            tx,
            state,
            {
              id: w.id,
              paymentId: w.paymentId,
              valueDate: w.valueDate,
              lines: lines.rows.map((l) => ({ lineId: l.line_id, amountMinor: Number(l.amount) })),
              rateBps: w.rateBps,
              rateRuleId: w.rateRuleId,
              causedBy: null,
              released: e.released,
            },
            a.rules,
          );
          const [item] = await tx
            .select({ id: schema.rentTaxItem.id })
            .from(schema.rentTaxItem)
            .where(
              sql`${schema.rentTaxItem.withholdingId} = ${w.id} and ${schema.rentTaxItem.kind} = 'withholding'`,
            );
          itemId = item?.id ?? null;
        }
      }
      await appendTaxEvent(tx, companyId, ASSESSED_ACTION, e.eventKey, { itemId, note });
      return true;
    });
  }
}
