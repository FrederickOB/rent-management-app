import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { platformAdminFor } from '@rent/server/admin';
import { invalid } from '@rent/server/core';
import { PolicyService } from '@rent/server/policy';
import { SubscriptionBillingService } from '@rent/server/subscription';
import { z } from 'zod';
import { Ctx, type RequestContext } from '../http/request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const forceInvoiceBody = z.object({ dueDaysAgo: z.number().int().min(0).max(365) }).strict();

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
  ) {}

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
}
