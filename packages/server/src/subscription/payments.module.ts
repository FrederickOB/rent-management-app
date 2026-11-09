import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReconciliationService } from '../payments/reconciliation.service';
import { WebhooksService } from '../payments/webhooks.service';
import { PolicyModule } from '../policy/policy.module';
import { SubscriptionCoreModule } from './core.module';
import { SubscriptionPaymentsService } from './payments.service';
import { SubscriptionSubledgerCheck } from './subledger-check.service';

/**
 * Paying the subscription (M10 plan 4.4; decision 9): the platform's own charges, their webhooks,
 * receipts, reconciliation and settlement, and the nightly subscription sub-ledger check. It
 * registers with payments' webhook processor and reconciliation (a layer below), which hand it
 * every `SUB-` reference and every payout of the platform's own balance, never to rent.
 */
@Module({
  imports: [SubscriptionCoreModule, DocumentsModule, PaymentsModule, PolicyModule],
  providers: [SubscriptionPaymentsService, SubscriptionSubledgerCheck],
  exports: [SubscriptionPaymentsService, SubscriptionSubledgerCheck],
})
export class SubscriptionPaymentsModule implements OnModuleInit {
  constructor(
    @Inject(WebhooksService) private readonly webhooks: WebhooksService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(SubscriptionPaymentsService) private readonly payments: SubscriptionPaymentsService,
  ) {}

  onModuleInit(): void {
    registerSubscriptionPayments(this.webhooks, this.reconciliation, this.payments);
  }
}

/**
 * Hands the platform's own charges (`SUB-`) and payouts to subscriptions. Tests wire the services
 * by hand and call this too.
 */
export function registerSubscriptionPayments(
  webhooks: Pick<WebhooksService, 'usePlatformCharges'>,
  reconciliation: Pick<ReconciliationService, 'usePlatformCharges'>,
  payments: SubscriptionPaymentsService,
): void {
  webhooks.usePlatformCharges(payments);
  reconciliation.usePlatformCharges(payments);
}

export * from './payments.service';
export * from './subledger-check.service';
