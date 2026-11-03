import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { eq, schema } from '@rent/db';
import type { MessageChannel } from '@rent/domain/messaging';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { DocumentsModule } from '../documents/documents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MessagingModule } from '../messaging/messaging.module';
import { MessagingService } from '../messaging/messaging.service';
import { RulesModule } from '../rules/rules.module';
import { PolicyModule } from '../policy/policy.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PayLinksService } from './pay-links.service';
import { PayPageService } from './pay-page.service';
import { ProviderPaymentsService } from './provider-payments.service';
import { QueueService } from './queue.service';
import { ReceiptsService } from './receipts.service';
import { ReconciliationService } from './reconciliation.service';
import { RemindersService } from './reminders.service';
import { SettlementAccountsService } from './settlement-accounts.service';
import { TenantMoneyService } from './tenant-money.service';
import { WebhooksService } from './webhooks.service';

const SERVICES = [
  SettlementAccountsService,
  ProviderPaymentsService,
  PayLinksService,
  PayPageService,
  WebhooksService,
  QueueService,
  ReceiptsService,
  RemindersService,
  ReconciliationService,
  TenantMoneyService,
];

/**
 * Provider payments (BC-02 to BC-04, BC-06, BC-09, BC-12; M4b plan 4.1; architecture section 2,
 * layer 6): settlement accounts and destinations, pay links and the pay page, webhooks and
 * verification, the unmatched queue and refunds, receipts to tenants, the reminder ladder, and
 * reconciliation with settlement. It posts through billing's engine and the ledger's posting
 * service, and sends through the messaging core.
 */
@Module({
  imports: [
    ApprovalsModule,
    AuditModule,
    BillingModule,
    DocumentsModule,
    LedgerModule,
    MessagingModule,
    PolicyModule,
    RulesModule,
    TenancyModule,
  ],
  providers: SERVICES,
  exports: SERVICES,
})
export class PaymentsModule implements OnModuleInit {
  constructor(
    @Inject(SettlementAccountsService) private readonly accounts: SettlementAccountsService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Inject(PayLinksService) private readonly links: PayLinksService,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
  ) {}

  onModuleInit(): void {
    registerPayments(this.accounts, this.queue, this.messaging, this.links, this.receipts);
  }
}

/**
 * Registers the payments approvals (settlement accounts, refunds of unmatched money), the `pay`
 * and `receipt` links messages carry, and owners as recipients of settlement alerts. Tests wire
 * the services by hand and call this too.
 */
export function registerPayments(
  accounts: SettlementAccountsService,
  queue: QueueService,
  messaging: MessagingService,
  links: PayLinksService,
  receipts: ReceiptsService,
): void {
  accounts.registerApprovals();
  queue.registerApprovals();
  messaging.useLinks('pay', {
    url: (companyId, invoiceId, messageId) => links.urlForMessage(companyId, invoiceId, messageId),
  });
  messaging.useLinks('receipt', {
    url: (companyId, receiptId, messageId) =>
      receipts.urlForMessage(companyId, receiptId, messageId),
  });
  messaging.useRecipients('owner', {
    async reach(tx, _companyId, recipient) {
      if (!('ownerId' in recipient)) return null;
      const [owner] = await tx
        .select()
        .from(schema.owner)
        .where(eq(schema.owner.id, recipient.ownerId));
      if (!owner) return null;
      const addresses = {
        ...(owner.phone ? { sms: owner.phone } : {}),
        ...(owner.email ? { email: owner.email } : {}),
      };
      return {
        name: owner.legalName ?? owner.displayName,
        addresses,
        // Settlement alerts need no tenancy consent (packages/domain/src/messaging).
        consented: new Set(Object.keys(addresses) as MessageChannel[]),
        isTestContact: owner.isTestContact,
        tenantId: null,
        propertyId: null,
      };
    },
  });
}
