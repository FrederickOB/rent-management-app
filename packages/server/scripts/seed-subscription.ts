import { sql, withSystem, type Database } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import { monthOf, previousMonth } from '@rent/domain/subscription';
import type { PaymentsPort, PaymentsTestControls } from '@rent/integrations';
import type { PaymentProviders } from '../src/core/payment-providers';
import type { WebhooksService } from '../src/payments';
import type {
  SubscriptionBillingService,
  SubscriptionCoreService,
  SubscriptionLifecycleService,
  SubscriptionPaymentsService,
} from '../src/subscription';
import { withPlatform } from '../src/subscription/platform';

type FakePort = PaymentsPort & PaymentsTestControls;

/**
 * The M10 demo data (plan 4.11). The platform company, its book, the placeholder price lists and
 * terms come with the companies and migration 0058; this adds one discount code and each billing
 * company's subscription, started long enough ago that its 30-day trial is over:
 * - the agency on Growth, active: last month's snapshot and invoice, paid by card on the fake
 *   provider, with its receipt;
 * - the individual landlord on Starter: last month's invoice unpaid, past due but inside the grace
 *   period (dated so whatever day the seed runs), so the reminders and the banner show and the
 *   specs can still write;
 * - Abokobi Homes on Growth, active, nothing invoiced yet.
 * No support grants: the e2e specs make their own company to try read-only and support access.
 * Idempotent: a second run adds nothing.
 */
export async function ensureSubscriptions(deps: {
  readonly database: Database;
  readonly core: SubscriptionCoreService;
  readonly billing: SubscriptionBillingService;
  readonly lifecycle: SubscriptionLifecycleService;
  readonly payments: SubscriptionPaymentsService;
  readonly providers: PaymentProviders;
  readonly webhooks: WebhooksService;
  readonly agency: string;
  readonly landlord: string;
  readonly others: readonly string[];
  readonly actor: (companyId: string, signIn: string) => Promise<Actor>;
}): Promise<string[]> {
  const { database, core, billing } = deps;
  const out: string[] = [];
  await withPlatform(database, {}, (tx, platformId) =>
    tx.execute(
      sql`insert into discount_code (company_id, code, kind, percent_bps, months, expires_on)
          values (${platformId}::uuid, 'LAUNCH20', 'percentage', 2000, 3, current_date + 90)
          on conflict (company_id, code) do nothing`,
    ),
  );

  /** Starts a company's subscription as if it had been created `days` ago, on `plan`. */
  const start = (companyId: string, plan: 'starter' | 'growth', days: number) =>
    withPlatform(database, {}, async (tx, platformId) => {
      const company = await core.subscriberCompany(tx, companyId);
      if (!company) throw new Error(`No subscriber company ${companyId}`);
      const backdated = {
        ...company,
        plan,
        createdAt: new Date(company.createdAt.getTime() - days * 86_400_000),
      };
      const sub = await core.ensure(tx, platformId, backdated);
      await core.refresh(tx, platformId, sub, company);
      return { sub, company };
    });

  // The agency: Growth, active; last month invoiced and paid by card.
  const agency = await start(deps.agency, 'growth', 120);
  const today = core.todayIn(agency.company.timeZone);
  const last = previousMonth(monthOf(today));
  const agencyInvoice = await billing.invoice(deps.agency, { month: last });
  const paid = await withPlatform(database, {}, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from subscription_payment
          where subscriber_company_id = ${deps.agency}::uuid and status = 'succeeded'`,
    ),
  );
  let payment = 'paid by card with its receipt';
  if (agencyInvoice && paid.rows[0]!.n === 0) {
    const admin = await deps.actor(deps.agency, 'agency.admin@demo.invalid');
    // A fake provider older than M10 refuses a charge with no subaccount: say so, and go on.
    const started = await deps.payments
      .pay(admin, { purpose: 'invoices', channel: 'card' })
      .catch((error: unknown) => {
        payment = `NOT paid: the fake provider refused the platform charge (${error instanceof Error ? error.message : 'error'}); rebuild the fake-providers image`;
        return null;
      });
    if (started && started.status === 'failed')
      payment = `NOT paid: the fake provider refused the platform charge; rebuild the fake-providers image`;
    if (started && started.status !== 'failed') {
      const port = deps.providers.get('paystack') as FakePort;
      const webhook = await port
        .completeCharge(started.reference, { status: 'success' })
        .catch((error: unknown) => {
          payment = `NOT paid: the fake provider does not know the platform charge (${error instanceof Error ? error.message : 'error'}); rebuild the fake-providers image`;
          return null;
        });
      if (webhook) {
        await deps.webhooks.intake('paystack', Buffer.from(webhook.rawBody), webhook.headers);
        const claimed = await withSystem(database, {}, (tx) =>
          tx.execute<{ id: string }>(sql`select id from app.claim_webhook_inbox(100)`),
        );
        for (const row of claimed.rows) await deps.webhooks.process(row.id);
      }
    }
  }
  out.push(
    agencyInvoice
      ? `  Agency: Growth; ${agencyInvoice.number} for ${last} (${format(money(agencyInvoice.totalMinor))}), ${payment}.`
      : '  Agency: Growth; nothing billable last month.',
  );

  // The landlord: Starter; last month's invoice past due, inside the grace period.
  await start(deps.landlord, 'starter', 120);
  const dueOn = toIsoDate(addDays(parseBusinessDate(today), -3));
  const issuedOn = toIsoDate(addDays(parseBusinessDate(dueOn), -7));
  const landlordInvoice = await billing.invoice(deps.landlord, {
    month: last,
    dates: { issuedOn, dueOn },
  });
  const state = await deps.lifecycle.dunning(deps.landlord);
  out.push(
    landlordInvoice
      ? `  Landlord: Starter; ${landlordInvoice.number} for ${last} (${format(money(landlordInvoice.totalMinor))}) due ${dueOn}, unpaid: ${state?.status ?? 'unknown'}, access ${state?.access ?? 'unknown'}.`
      : '  Landlord: Starter; nothing billable last month.',
  );

  for (const companyId of deps.others) await start(companyId, 'growth', 120);
  out.push(
    `  ${deps.others.length} more on Growth, active; discount code LAUNCH20 (20% for 3 months).`,
  );
  return out;
}
