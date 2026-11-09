import { sql, type Tx } from '@rent/db';
import { prepaidDrawLines, subscriptionPostingKeys } from '@rent/domain/ledger';
import type { PostingService } from '../ledger/posting.service';
import type { SubscriptionCoreService } from './core.service';
import { platformBookId } from './platform';

/**
 * Prepaid credit never sits beside debt (M10 review BE-3): whatever credit (2020) a subscriber
 * holds is drawn at once onto its open invoices, oldest first (P26: Dr 2020, Cr 1100), and an
 * invoice the draws settle is marked paid. Called when an invoice is issued, after a payment
 * reversal reopens invoices, and by the daily lifecycle. Runs in the platform company's context,
 * under the subscription lock. Returns what was drawn, per invoice.
 */
export async function settleFromCredit(
  tx: Tx,
  deps: { readonly core: SubscriptionCoreService; readonly posting: PostingService },
  platformId: string,
  subscriberCompanyId: string,
  valueDate: string,
): Promise<{ readonly invoiceId: string; readonly amountMinor: number }[]> {
  let credit = await deps.core.creditMinor(tx, subscriberCompanyId);
  if (credit <= 0) return [];
  const drawn: { invoiceId: string; amountMinor: number }[] = [];
  const bookId = await platformBookId(tx, platformId);
  for (const invoice of await deps.core.openInvoices(tx, subscriberCompanyId)) {
    if (credit <= 0) break;
    if (invoice.outstandingMinor <= 0) continue;
    const amountMinor = Math.min(credit, invoice.outstandingMinor);
    const earlier = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from subscription_allocation
          where invoice_id = ${invoice.id}::uuid and source = 'prepaid'`,
    );
    const n = Number(earlier.rows[0]?.n ?? 0);
    const inserted = await tx.execute<{ id: string }>(
      sql`insert into subscription_allocation (company_id, subscriber_company_id, source, payment_id, invoice_id, amount_minor)
          values (${platformId}::uuid, ${subscriberCompanyId}::uuid, 'prepaid', null, ${invoice.id}::uuid, ${amountMinor})
          returning id`,
    );
    // The first draw on an invoice keeps P26's key; a later one (after a reversal reopened it)
    // carries its allocation, so each posts once.
    const key =
      n === 0
        ? subscriptionPostingKeys.prepaidDraw(invoice.id)
        : `${subscriptionPostingKeys.prepaidDraw(invoice.id)}:${inserted.rows[0]!.id}`;
    await deps.posting.post(tx, {
      companyId: platformId,
      rule: 'P26',
      key,
      valueDate,
      lines: prepaidDrawLines({ bookId, invoiceId: invoice.id, amountMinor }),
      record: { type: 'subscription_invoice', id: invoice.id },
    });
    if (amountMinor === invoice.outstandingMinor)
      await tx.execute(
        sql`update subscription_invoice set status = 'paid', paid_at = now(), updated_at = now()
            where id = ${invoice.id}::uuid and status = 'open'`,
      );
    drawn.push({ invoiceId: invoice.id, amountMinor });
    credit -= amountMinor;
  }
  return drawn;
}
