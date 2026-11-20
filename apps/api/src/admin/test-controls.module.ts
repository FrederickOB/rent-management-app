import { Module } from '@nestjs/common';
import { BillingModule } from '@rent/server/billing';
import { LedgerModule } from '@rent/server/ledger';
import { OpsModule } from '@rent/server/ops';
import { PaymentsModule } from '@rent/server/payments';
import { PolicyModule } from '@rent/server/policy';
import { ReportingMoneyModule } from '@rent/server/reporting';
import { SubscriptionModule } from '@rent/server/subscription';
import { TestControlsController } from './test-controls.controller';

/**
 * The e2e test controls (M10; M11 adds the operations ones). AppModule imports this module only when `testControlsEnabled`
 * (E2E_TEST_CONTROLS=on, and never in production), so without it the routes do not exist (404).
 */
@Module({
  imports: [
    PolicyModule,
    SubscriptionModule,
    OpsModule,
    // M11 review C6 and C8: the charge control and the ledger checks.
    PaymentsModule,
    BillingModule,
    LedgerModule,
    ReportingMoneyModule,
  ],
  controllers: [TestControlsController],
})
export class TestControlsModule {}
