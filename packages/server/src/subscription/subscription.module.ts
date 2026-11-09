import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { PolicyModule } from '../policy/policy.module';
import { SubscriptionBillingService } from './billing.service';
import { SubscriptionCoreModule } from './core.module';
import { SubscriptionLifecycleService } from './lifecycle.service';
import { SubscriptionPaymentsModule } from './payments.module';
import { SubscriptionService } from './subscription.service';

/**
 * Subscription billing (M10, layer 8): the snapshot and invoice, the lifecycle and dunning, the
 * subscriber's page and the console's subscription operations, with paying (its own module) and
 * the core. Rent never reaches the platform book; subscription money never reaches an owner's.
 */
@Module({
  imports: [SubscriptionCoreModule, SubscriptionPaymentsModule, DocumentsModule, PolicyModule],
  providers: [SubscriptionBillingService, SubscriptionLifecycleService, SubscriptionService],
  exports: [
    SubscriptionBillingService,
    SubscriptionLifecycleService,
    SubscriptionService,
    SubscriptionCoreModule,
    SubscriptionPaymentsModule,
  ],
})
export class SubscriptionModule {}
