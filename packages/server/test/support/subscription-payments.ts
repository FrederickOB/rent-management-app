import { sql, type Tx } from '@rent/db';
import { subscriptionInvoiceLines, subscriptionPostingKeys } from '@rent/domain/ledger';
import type { PostingService } from '../../src/ledger/posting.service';
import { termsAsOf } from '../../src/subscription/catalogue';
import { SubscriptionCoreService } from '../../src/subscription/core.service';
import { nextSubscriptionNumber } from '../../src/subscription/numbering';
import { registerSubscriptionPayments } from '../../src/subscription/payments.module';
import { SubscriptionPaymentsService } from '../../src/subscription/payments.service';
import { platformBookId, withPlatform } from '../../src/subscription/platform';
import { SubscriptionSubledgerCheck } from '../../src/subscription/subledger-check.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import type { PaymentsServices } from './payments';
import type { TenancyServices } from './tenancy';

/**
 * The M10 paying services wired as Nest wires them (SubscriptionPaymentsModule), on the test
 * database, sharing the M4b payments services: the in-memory `paystack` stands in for the
 * platform's own account, and the webhook processor and reconciliation hand `SUB-` references here.
 */
export function subscriptionPaymentsServices(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
  p: PaymentsServices,
) {
  const core = new SubscriptionCoreService(ctx.database, ctx.audit, ctx.clock);
  const payments = new SubscriptionPaymentsService(
    ctx.database,
    p.providers,
    s.policy,
    core,
    b.posting,
    s.documents,
    s.rules,
    p.alertPort,
    ctx.config,
    ctx.clock,
    p.logger,
  );
  registerSubscriptionPayments(p.webhooks, p.reconciliation, payments);
  const subledger = new SubscriptionSubledgerCheck(ctx.database, core, p.alertPort);
  return { core, payments, subledger };
}

export type SubscriptionPaymentsServices = ReturnType<typeof subscriptionPaymentsServices>;

/** A company's subscription, started as the engine starts it (no trial unless asked). */
export async function subscribe(
  ctx: ServerTestContext,
  sp: SubscriptionPaymentsServices,
  companyId: string,
  options: { trialDays?: number } = {},
) {
  return withPlatform(ctx.database, {}, async (tx, platformId) => {
    const company = await sp.core.subscriberCompany(tx, companyId);
    if (!company) throw new Error('No such subscriber company');
    return sp.core.ensure(tx, platformId, company, { trialDays: options.trialDays ?? 0 });
  });
}

/**
 * An open subscription invoice, as the invoice job will issue it (plain SQL until the lead's
 * billing service exists): its snapshot, one units line, a gap-free number and its P26 entry in
 * the platform book, so the books and the sub-ledger agree.
 */
export async function openInvoice(
  ctx: ServerTestContext,
  posting: PostingService,
  companyId: string,
  input: { month: string; totalMinor: number; issuedOn: string; dueOn: string },
): Promise<{ id: string; number: string }> {
  return withPlatform(ctx.database, {}, async (tx, platformId) => {
    const sub = await one<{ id: string }>(
      tx,
      sql`select id from subscription where subscriber_company_id = ${companyId}::uuid`,
    );
    const snapshot = await one<{ id: string }>(
      tx,
      sql`insert into billing_snapshot (company_id, subscription_id, subscriber_company_id, month,
            single_room_units, self_contained_units, commercial_units)
          values (${platformId}::uuid, ${sub.id}::uuid, ${companyId}::uuid, ${input.month}, 0, 1, 0)
          returning id`,
    );
    const terms = await termsAsOf(tx, input.issuedOn);
    const number = await nextSubscriptionNumber(
      tx,
      platformId,
      'invoice',
      Number(input.issuedOn.slice(0, 4)),
    );
    const prices = await tx.execute<{ id: string }>(
      sql`select id from price_list order by effective_from limit 1`,
    );
    const invoice = await one<{ id: string }>(
      tx,
      sql`insert into subscription_invoice (company_id, subscription_id, subscriber_company_id, number,
            month, snapshot_id, issued_on, due_on, subtotal_minor, discount_minor, net_minor, vat_minor,
            total_minor, price_list_ids, terms_id, template_key, template_version)
          values (${platformId}::uuid, ${sub.id}::uuid, ${companyId}::uuid, ${number}, ${input.month},
            ${snapshot.id}::uuid, ${input.issuedOn}::date, ${input.dueOn}::date, ${input.totalMinor}, 0,
            ${input.totalMinor}, 0, ${input.totalMinor},
            ${`{${prices.rows.map((r) => r.id).join(',')}}`}::uuid[], ${terms.id}::uuid,
            'subscription.invoice', 1)
          returning id`,
    );
    await tx.execute(
      sql`insert into subscription_invoice_line (company_id, invoice_id, line_no, kind, description,
            amount_minor)
          values (${platformId}::uuid, ${invoice.id}::uuid, 1, 'units', 'Units', ${input.totalMinor})`,
    );
    await posting.post(tx, {
      companyId: platformId,
      rule: 'P26',
      key: subscriptionPostingKeys.invoice(invoice.id),
      valueDate: input.issuedOn,
      lines: subscriptionInvoiceLines({
        bookId: await platformBookId(tx, platformId),
        invoiceId: invoice.id,
        netMinor: input.totalMinor,
        vatMinor: 0,
      }),
      record: { type: 'subscription_invoice', id: invoice.id },
    });
    return { id: invoice.id, number };
  });
}

async function one<T extends Record<string, unknown>>(
  tx: Tx,
  query: ReturnType<typeof sql>,
): Promise<T> {
  const result = await tx.execute<T>(query);
  const row = result.rows[0];
  if (!row) throw new Error('Expected a row');
  return row as T;
}
