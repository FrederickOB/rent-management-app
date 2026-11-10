import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { createDatabase, sql, withSystem, type Database } from '@rent/db';
import { platformAdminFor } from '@rent/server/admin';
import { SubledgerCheckService } from '@rent/server/billing';
import {
  CLOCK,
  CONFIG,
  conflict,
  DATABASE,
  invalid,
  notFound,
  PAYMENT_PROVIDERS,
  type AppConfig,
  type Clock,
  type PaymentProviders,
} from '@rent/server/core';
import { AgentCashCheckService } from '@rent/server/ledger';
import {
  paymentsByReference,
  QUEUE_AGE_JOB,
  storeDeadLetter,
  storeFailedChargeWebhook,
  storeFailedWebhook,
} from '@rent/server/ops';
import { PayLinksService, PayPageService } from '@rent/server/payments';
import { PolicyService } from '@rent/server/policy';
import { ManagementFeesService } from '@rent/server/reporting';
import { SubscriptionBillingService } from '@rent/server/subscription';
import { z } from 'zod';
import { Ctx, type RequestContext } from '../http/request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const forceInvoiceBody = z.object({ dueDaysAgo: z.number().int().min(0).max(365) }).strict();
const failedWebhookBody = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9_.-]{1,39}$/),
    status: z.enum(['failed', 'dead_lettered']).default('dead_lettered'),
    /** M11 review C6: a real pending charge for this open invoice, which a replay posts. */
    charge: z.boolean().optional(),
    companyId: z.string().regex(UUID).optional(),
    invoiceId: z.string().regex(UUID).optional(),
    amountMinor: z.number().int().min(100).max(100_000_000).optional(),
  })
  .strict();
const deadJobBody = z
  .object({
    queue: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{1,119}$/)
      .default(QUEUE_AGE_JOB),
  })
  .strict();

/**
 * Whether the cooling-off control may use this owner URL: it must name the API's own database,
 * and never one called `rent` (the developer's own), except in CI (`CI=true`), whose e2e job runs
 * on a throwaway database of that name.
 */
export function ownerUrlAllowed(
  appUrl: string | undefined,
  ownerUrl: string | undefined,
  inCi: boolean,
): boolean {
  const name = (url: string | undefined) => {
    try {
      return url ? decodeURIComponent(new URL(url).pathname.slice(1)) : null;
    } catch {
      return null;
    }
  };
  const app = name(appUrl);
  if (!app || app !== name(ownerUrl)) return false;
  return app !== 'rent' || inCi;
}

/**
 * Test controls for the web e2e specs (M10; assumption A1 in apps/web/e2e/subscription-support.ts),
 * outside the contracts. Mounted only by TestControlsModule, which the API loads only with
 * E2E_TEST_CONTROLS=on outside production (the config refuses it in production). Platform admins
 * only, through PolicyService (`company.manage`).
 */
@Controller('_test')
export class TestControlsController {
  constructor(
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(SubscriptionBillingService) private readonly billing: SubscriptionBillingService,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PayLinksService) private readonly links: PayLinksService,
    @Inject(PayPageService) private readonly page: PayPageService,
    @Inject(SubledgerCheckService) private readonly subledger: SubledgerCheckService,
    @Inject(AgentCashCheckService) private readonly agentCash: AgentCashCheckService,
    @Inject(ManagementFeesService) private readonly fees: ManagementFeesService,
  ) {}

  /**
   * M11 (OQ-29 under founder D1): ends a single-user request's cooling-off now, so the e2e spec can
   * self-confirm a new company's first manager invite without waiting 24 hours. The request's
   * cooling_off_until moves before both the service clock and the database's now(). Only a status
   * change may touch approval_request (RA016), so this runs as the database owner, on the same
   * database as the API's, with forced RLS and that one check lifted inside its transaction; never in production.
   */
  @Post('approvals/:requestId/end-cooling-off')
  @HttpCode(200)
  async endCoolingOff(
    @Ctx() ctx: RequestContext,
    @Param('requestId') requestId: string,
  ): Promise<{ id: string; coolingOffUntil: string }> {
    platformAdminFor(this.policy, ctx.actor, 'company.manage');
    if (!UUID.test(requestId)) throw invalid('bad_request', 'The request id is not a UUID');
    const ownerUrl = this.config.E2E_DATABASE_OWNER_URL;
    if (
      !ownerUrlAllowed(this.config.DATABASE_URL, ownerUrl, process.env.CI === 'true') ||
      !ownerUrl
    )
      throw conflict(
        'owner_url_mismatch',
        'This control needs E2E_DATABASE_OWNER_URL naming the API’s own e2e database',
      );
    const owner = createDatabase(ownerUrl, { max: 1, applicationName: 'e2e-test-control' });
    try {
      const until = new Date(this.clock.now().getTime() - 60_000);
      const rows = await owner.db.transaction(async (tx) => {
        // The owner is held to forced RLS too; lift it and the status check for this statement.
        await tx.execute(sql`alter table approval_request no force row level security`);
        await tx.execute(sql`alter table approval_request disable trigger check_request_update`);
        // The change is audited in the request's own company chain, as the system.
        await tx.execute(sql`select set_config('app.company_id', coalesce(
            (select company_id::text from approval_request where id = ${requestId}::uuid), ''), true),
          set_config('app.actor_kind', 'system', true)`);
        const updated = await tx.execute<{ id: string; cooling_off_until: Date }>(sql`
          update approval_request set cooling_off_until = least(${until}::timestamptz, now() - interval '1 minute')
          where id = ${requestId}::uuid and status = 'cooling_off' and mode = 'single_user'
          returning id, cooling_off_until`);
        await tx.execute(sql`alter table approval_request enable trigger check_request_update`);
        await tx.execute(sql`alter table approval_request force row level security`);
        return updated.rows;
      });
      const row = rows[0];
      if (!row)
        throw conflict('not_cooling_off', 'No single-user request is cooling off with that id');
      return { id: row.id, coolingOffUntil: new Date(row.cooling_off_until).toISOString() };
    } finally {
      await owner.close();
    }
  }

  /**
   * An open subscription invoice for the company, issued through the normal invoice path and
   * dated so it fell due `dueDaysAgo` days ago, then today's dunning for the company: the one state
   * no screen can reach in a test.
   */
  @Post('subscriptions/:companyId/invoice')
  @HttpCode(200)
  async forceInvoice(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; number: string; totalMinor: number }> {
    platformAdminFor(this.policy, ctx.actor, 'company.manage');
    if (!UUID.test(companyId)) throw invalid('bad_company', 'The company id is not a UUID');
    const parsed = forceInvoiceBody.safeParse(body);
    if (!parsed.success)
      throw invalid(
        'bad_request',
        'Send { "dueDaysAgo": n }, a whole number of days from 0 to 365',
      );
    const invoice = await this.billing.forceOverdueInvoice(companyId, parsed.data.dueDaysAgo);
    return { id: invoice.id, number: invoice.number, totalMinor: invoice.totalMinor };
  }

  /**
   * M11 decision 9 (the console's replay spec, assumption O1): a webhook stored as a real one that
   * failed looks (signed, with its body, dead-lettered unless `status` says `failed`), answering
   * its inbox id. Replaying it runs the normal path and ends `processed`, posting and sending
   * nothing: a payments provider's `charge.success` for a reference no provider knows (outcome
   * `unknown`), or a WhatsApp `delivered` status for a message never sent (`unknown_message`).
   */
  @Post('webhooks/failed')
  @HttpCode(200)
  async failedWebhook(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<{ id: string }> {
    platformAdminFor(this.policy, ctx.actor, 'platform.ops.replay');
    const parsed = failedWebhookBody.safeParse(body ?? {});
    if (!parsed.success)
      throw invalid(
        'bad_request',
        'Send { "provider": "paystack" | "messaging.whatsapp", "status"?: "failed" | "dead_lettered" }',
      );
    const { provider, status } = parsed.data;
    if (provider !== 'messaging.whatsapp' && !this.providers.has(provider))
      throw invalid('bad_provider', 'Use a configured payments provider or messaging.whatsapp');
    if (parsed.data.charge) {
      const { companyId, invoiceId, amountMinor } = parsed.data;
      if (provider.startsWith('messaging.') || !companyId || !invoiceId)
        throw invalid(
          'bad_request',
          'A charge needs a payments provider, the companyId and an open invoiceId of that company',
        );
      return storeFailedChargeWebhook(
        {
          database: this.database,
          links: this.links,
          page: this.page,
          providers: this.providers,
        },
        { companyId, invoiceId, ...(amountMinor === undefined ? {} : { amountMinor }) },
      );
    }
    return { id: await storeFailedWebhook(this.database, { provider, status }) };
  }

  /** M11 review C6: the payments and receipts a charge reference has (`?reference=pi-…`). */
  @Get('payments')
  async payments(
    @Ctx() ctx: RequestContext,
    @Query('reference') reference: unknown,
  ): Promise<{ payments: number; receipts: number }> {
    platformAdminFor(this.policy, ctx.actor, 'health.read');
    if (typeof reference !== 'string') throw invalid('bad_request', 'Give ?reference=');
    return paymentsByReference(this.database, reference);
  }

  /**
   * M11 review C8: the nightly ledger checks for one company, now, read only and without alerts:
   * the sub-ledger check (every book balances; receivables, prepayments, deposits, cash, suspense
   * against their records), the agency's cash per owner, and the management fee check. Answers
   * every difference, labelled by its `source` check; none is `{ differences: [] }`.
   */
  @Post('ledger-checks/:companyId')
  @HttpCode(200)
  async ledgerChecks(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
  ): Promise<{ differences: Record<string, unknown>[] }> {
    platformAdminFor(this.policy, ctx.actor, 'health.read');
    if (!UUID.test(companyId)) throw invalid('bad_company', 'The company id is not a UUID');
    const known = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from app.company_ids() as id where id = ${companyId}::uuid`,
      ),
    );
    if (known.rows.length === 0) throw notFound('Company');
    const subledger = await this.subledger.check(companyId, { alert: false });
    const agentCash = await this.agentCash.check(companyId, { alert: false });
    const fees = await this.fees.check(companyId, { alert: false });
    return {
      differences: [
        ...subledger.mismatches.map((m) => ({ source: 'subledger', ...m })),
        ...agentCash.negative.map((n) => ({ source: 'agent_cash', ...n })),
        ...fees.mismatches.map((m) => ({ source: 'fees', ...m })),
      ],
    };
  }

  /**
   * M11 decision 9: a job in the dead-letter queue as pg-boss's transfer leaves one, for `queue`
   * (default `ops.queue-age`, whose retry is a harmless queue check), answering its id there.
   */
  @Post('jobs/dead')
  @HttpCode(200)
  async deadJob(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<{ id: string }> {
    platformAdminFor(this.policy, ctx.actor, 'platform.ops.redrive');
    const parsed = deadJobBody.safeParse(body ?? {});
    if (!parsed.success) throw invalid('bad_request', 'Send { "queue"?: "<queue name>" }');
    return { id: await storeDeadLetter(this.database, { queue: parsed.data.queue }) };
  }
}
