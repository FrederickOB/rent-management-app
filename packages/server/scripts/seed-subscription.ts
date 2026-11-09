import { sql, withSystem, type Database } from '@rent/db';
import { addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import type { SubscriptionTier } from '@rent/domain/settings';
import { monthBounds, monthOf, previousMonth } from '@rent/domain/subscription';
import type { PaymentsPort, PaymentsTestControls, PaymentWebhookRequest } from '@rent/integrations';
import type { PaymentProviders } from '../src/core/payment-providers';
import type { WebhooksService } from '../src/payments';
import type {
  SubscriptionBillingService,
  SubscriptionCoreService,
  SubscriptionPaymentsService,
} from '../src/subscription';
import { withPlatform } from '../src/subscription/platform';

type FakePort = PaymentsPort & PaymentsTestControls;

/** The demo prices: the placeholder rates, as real (non-placeholder) versions for local use. */
const DEMO_PRICES: readonly {
  readonly tier: SubscriptionTier;
  readonly rates: readonly [number, number, number];
  readonly minimum: number;
}[] = [
  { tier: 'starter', rates: [500, 1_000, 2_000], minimum: 5_000 },
  { tier: 'growth', rates: [800, 1_500, 3_000], minimum: 15_000 },
  { tier: 'portfolio', rates: [1_200, 2_200, 4_500], minimum: 40_000 },
];
const DEMO_NOTE = 'Demo prices for local development (seed), not real prices';

/**
 * The M10 demo data (plan 4.11; review BE-28 and founder answer Q1). Local databases only.
 * - **The platform:** demo price lists (the placeholder rates as non-placeholder versions, from a
 *   month a year back, so the A1 test control can bill a past month) and billing turned on from
 *   then, the activation noted as demo; one discount code, LAUNCH20.
 * - **The agency, Growth, active:** last month's invoice, paid by card on the fake provider with
 *   its receipt, then 12 months paid ahead: every invoice for a year is drawn from that credit.
 * - **The individual landlord, Starter:** in a 365-day trial from today; nothing invoiced.
 * - **Abokobi Homes, Portfolio:** in a 365-day trial from today; nothing invoiced.
 * So a database seeded today reaches no past due or read-only for 12 months; e2e gets those only
 * from the A1 test control, on companies it onboards. No support grants. Idempotent.
 */
export async function ensureSubscriptions(deps: {
  readonly database: Database;
  readonly core: SubscriptionCoreService;
  readonly billing: SubscriptionBillingService;
  readonly payments: SubscriptionPaymentsService;
  readonly providers: PaymentProviders;
  readonly webhooks: WebhooksService;
  readonly agency: string;
  readonly landlord: string;
  readonly abokobi: string;
  readonly actor: (companyId: string, signIn: string) => Promise<Actor>;
}): Promise<string[]> {
  const { database, core, billing } = deps;
  const out: string[] = [];
  const today = core.todayIn('Africa/Accra');
  // A year back, never before the placeholders' own date (a version a day must differ).
  const yearBack = monthBounds(monthOf(toIsoDate(addMonths(parseBusinessDate(today), -12)))).first;
  const demoFrom = yearBack > '2026-02-01' ? yearBack : '2026-02-01';

  // The platform: demo prices, billing on, a discount code. As the platform's system path.
  const activated = await withSystem(database, {}, async (tx) => {
    for (const p of DEMO_PRICES) {
      const exists = await tx.execute(
        sql`select 1 from price_list where tier = ${p.tier} and effective_from = ${demoFrom}::date`,
      );
      if (exists.rows.length === 0)
        await tx.execute(
          sql`select app.add_price_list(${p.tier}, ${p.rates[0]}, ${p.rates[1]}, ${p.rates[2]},
                ${p.minimum}, 1000, ${demoFrom}::date, false)`,
        );
    }
    const on = await tx.execute(sql`select 1 from billing_activation limit 1`);
    if (on.rows.length > 0) return false;
    await tx.execute(sql`select app.turn_on_billing(${demoFrom}::date, ${DEMO_NOTE})`);
    return true;
  });
  await withPlatform(database, {}, (tx, platformId) =>
    tx.execute(
      sql`insert into discount_code (company_id, code, kind, percent_bps, months, expires_on)
          values (${platformId}::uuid, 'LAUNCH20', 'percentage', 2000, 3, current_date + 90)
          on conflict (company_id, code) do nothing`,
    ),
  );
  out.push(
    `  Billing ${activated ? 'turned on' : 'already on'} from ${demoFrom} on demo prices (not placeholders); discount code LAUNCH20 (20% for 3 months).`,
  );

  /** Starts a company's subscription: created `days` ago, on `tier`, with `trialDays`. */
  const start = (companyId: string, tier: SubscriptionTier, days: number, trialDays: number) =>
    withPlatform(database, {}, async (tx, platformId) => {
      const company = await core.subscriberCompany(tx, companyId);
      if (!company) throw new Error(`No subscriber company ${companyId}`);
      const backdated = {
        ...company,
        plan: tier,
        createdAt: new Date(company.createdAt.getTime() - days * 86_400_000),
      };
      const sub = await core.ensure(tx, platformId, backdated, { trialDays });
      await core.refresh(tx, platformId, sub, company);
      return sub;
    });
  const port = deps.providers.get('paystack') as FakePort;
  const deliver = async (webhook: PaymentWebhookRequest | null) => {
    if (!webhook) return;
    await deps.webhooks.intake('paystack', Buffer.from(webhook.rawBody), webhook.headers);
    const claimed = await withSystem(database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.claim_webhook_inbox(100)`),
    );
    for (const row of claimed.rows) await deps.webhooks.process(row.id);
  };
  const succeeded = async (companyId: string, purpose: 'invoices' | 'annual') =>
    (
      await withPlatform(database, {}, (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from subscription_payment
              where subscriber_company_id = ${companyId}::uuid and purpose = ${purpose}
                and status = 'succeeded'`,
        ),
      )
    ).rows[0]!.n > 0;
  /** Pays by card on the fake provider; says what happened, never throws for the provider. */
  const payByCard = async (
    companyId: string,
    signIn: string,
    purpose: 'invoices' | 'annual',
  ): Promise<string> => {
    if (await succeeded(companyId, purpose)) return 'already paid';
    const admin = await deps.actor(companyId, signIn);
    const started = await deps.payments
      .pay(admin, { purpose, channel: 'card' })
      .catch((error: unknown) => (error instanceof Error ? error.message : 'error'));
    if (typeof started === 'string') return `NOT paid (${started})`;
    if (started.status === 'failed')
      return 'NOT paid: the fake provider refused the platform charge';
    const webhook = await port
      .completeCharge(started.reference, { status: 'success' })
      .catch(() => null);
    await deliver(webhook);
    // The status poll verifies with the provider too (BE-1), webhook or not.
    const after = await deps.payments.payment(admin, started.id);
    return after.status === 'succeeded'
      ? `paid by card (${format(money(started.amountMinor))})`
      : `NOT paid (${after.status})`;
  };

  // The agency: Growth, active; last month paid; then a year ahead.
  await start(deps.agency, 'growth', 120, 30);
  const last = previousMonth(monthOf(today));
  const invoice = await billing.invoice(deps.agency, { month: last });
  const lastPaid = invoice
    ? await payByCard(deps.agency, 'agency.admin@demo.invalid', 'invoices')
    : 'nothing billable';
  const yearAhead = await payByCard(deps.agency, 'agency.admin@demo.invalid', 'annual');
  out.push(
    `  Agency: Growth; ${invoice ? `${invoice.number} for ${last} (${format(money(invoice.totalMinor))}), ${lastPaid}` : 'no invoice for last month'}; 12 months ahead ${yearAhead}.`,
  );

  // The landlord and Abokobi: in a year's trial, nothing invoiced.
  await start(deps.landlord, 'starter', 0, 365);
  await start(deps.abokobi, 'portfolio', 0, 365);
  out.push(
    '  Landlord: Starter, in a 365-day trial, nothing invoiced. Abokobi Homes: Portfolio, in a 365-day trial, nothing invoiced.',
  );
  return out;
}
