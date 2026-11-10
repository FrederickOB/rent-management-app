import { schema, type Tx } from '@rent/db';
import { openingBalanceKeys } from '@rent/domain/ledger';
import type { BillingEngine } from '../billing/engine';
import { ownerFacts } from '../companies/owners.service';
import type { PostedEntry, PostingService } from '../ledger/posting.service';
import type { BalanceCheck, ItemMeta } from './balances';

/**
 * Posts a checked Balances or adjustment plan (P25; M11 decision 3) in the posting transaction,
 * which holds every lease's billing lock and the counters: each lease's opening records and
 * entries through the billing engine and the posting service (`P25:<batch>:<item>`), each owner's
 * items, an `onboarding_item` row per item (RA125: only while the batch is posting), and the M5
 * withholding record of each withholding brought in, awaiting its certificate. Every entry is
 * dated the cut-over; the accounting date is its period, or the open one if that is locked.
 */
export async function postBalancePlan(
  tx: Tx,
  deps: { readonly engine: BillingEngine; readonly posting: PostingService },
  input: {
    readonly companyId: string;
    readonly batchId: string;
    readonly cutOver: string;
    readonly causedBy: string | null;
    readonly check: BalanceCheck;
  },
): Promise<{ readonly entries: number; readonly items: number }> {
  const { companyId, batchId, cutOver } = input;
  let entries = 0;
  let items = 0;
  const item = async (
    itemId: string,
    meta: ItemMeta,
    subject: { readonly leaseId: string | null; readonly ownerId: string | null },
    posted: ReadonlyMap<string, PostedEntry>,
  ) => {
    const key = openingBalanceKeys.item(batchId, itemId);
    const entry = posted.get(key);
    if (!entry) throw new Error(`Opening item ${itemId} has no entry`);
    await tx.insert(schema.onboardingItem).values({
      companyId,
      batchId,
      itemKey: key,
      kind: meta.kind,
      leaseId: subject.leaseId,
      ownerId: subject.ownerId,
      amountMinor: meta.amountMinor,
      dueOn: meta.dueOn,
      periodStart: meta.periodStart,
      invoiceLineId: meta.invoiceLineId,
      paymentId: meta.paymentId,
      entryId: entry.entryId,
      valueDate: cutOver,
      accountingDate: entry.accountingDate,
    });
    items += 1;
    return entry;
  };

  for (const lease of input.check.leases) {
    const posted = await deps.engine.recordOpening(tx, lease.state, lease.plan, {
      batchId,
      cutOver,
      causedBy: input.causedBy,
    });
    entries += posted.size;
    for (const [itemId, meta] of lease.meta)
      await item(itemId, meta, { leaseId: lease.leaseId, ownerId: null }, posted);
    if (lease.withholding.length > 0) {
      const owner = (await ownerFacts(tx, [lease.ownerId])).get(lease.ownerId);
      for (const w of lease.withholding) {
        const entry = posted.get(openingBalanceKeys.item(batchId, w.itemId))!;
        const { lease: l } = lease.state;
        await tx.insert(schema.withholding).values({
          companyId,
          propertyId: l.propertyId,
          tenantId: l.tenantId,
          leaseId: l.id,
          unitId: l.unitId,
          ownerId: lease.ownerId,
          bookId: lease.bookId,
          paymentId: null,
          valueDate: w.withheldOn,
          accountingDate: entry.accountingDate,
          amountMinor: w.amountMinor,
          rateBps: w.rateBps,
          rateRuleId: w.rateRuleId,
          differsFromRate: w.differsFromRate,
          note: `Brought in at the cut-over (${cutOver}) for the period from ${w.periodStart}; withheld before the platform`,
          entryId: entry.entryId,
          recordedBy: input.causedBy,
          // No rent tax item of kind `withholding` exists for it (P17 posts nothing on opening
          // money, OQ-64). Its certificate posts P20 against 1160 for a letting-business owner and
          // against 3900 for any other (founder decision 4), by the flag recorded here.
          rentTaxTreatment: owner?.lettingBusiness ? 'letting_business' : 'not_assessed',
        });
      }
    }
  }

  for (const owner of input.check.owners) {
    const posted = new Map<string, PostedEntry>();
    for (const e of owner.plan.entries) {
      const done = await deps.posting.post(tx, {
        companyId,
        rule: e.rule,
        key: e.key,
        valueDate: e.valueDate,
        lines: e.lines,
        record: { type: 'onboarding_batch', id: batchId },
        causedBy: input.causedBy,
      });
      if (done) posted.set(e.key, done);
    }
    entries += posted.size;
    for (const [itemId, meta] of owner.meta)
      await item(itemId, meta, { leaseId: null, ownerId: owner.ownerId }, posted);
    // TX-02: the owner's M5 rent tax items, owner-level (no lease): the alerts read the one brought
    // in, a GRA payment (P18) settles it, and a lowering is its reversal, on the lowering's entry.
    if (owner.rentTax) {
      const entry = posted.get(openingBalanceKeys.item(batchId, `rent_tax.${owner.ownerId}`));
      if (!entry) throw new Error('Opening rent tax has no entry');
      const common = {
        companyId,
        ownerId: owner.ownerId,
        bookId: owner.bookId,
        valueDate: cutOver,
        accountingDate: entry.accountingDate,
        baseMinor: 0,
        rateBps: 0,
        rateRuleId: null,
        entryId: entry.entryId,
        createdBy: input.causedBy,
      };
      if (owner.rentTax.raise)
        await tx.insert(schema.rentTaxItem).values({
          ...common,
          kind: 'opening',
          dueDate: owner.rentTax.raise.dueOn,
          taxMinor: owner.rentTax.raise.amountMinor,
          dueRuleId: owner.rentTax.dueRuleId,
          alertRuleId: owner.rentTax.alertRuleId,
        });
      for (const l of owner.rentTax.lower)
        await tx.insert(schema.rentTaxItem).values({
          ...common,
          kind: 'reversal',
          reversesItemId: l.itemId,
          dueDate: null,
          taxMinor: -l.amountMinor,
        });
    }
  }
  return { entries, items };
}
