import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Database } from '@rent/db';
import type { AlertPort, StoragePort } from '@rent/integrations';
import { ApprovalsModule, ApprovalsService } from '@rent/server/approvals';
import { AuditModule, AuditService } from '@rent/server/audit';
import {
  AdvanceService,
  BillingModule,
  InvoicingService,
  SubledgerCheckService,
} from '@rent/server/billing';
import {
  ALERT_PORT,
  CLOCK,
  CONFIG,
  CoreModule,
  createLogger,
  DATABASE,
  loadConfig,
  NestLogger,
  PAYMENT_PROVIDERS,
  STORAGE_PORT,
  type AppConfig,
  type Clock,
  type PaymentProviders,
} from '@rent/server/core';
import { DocumentsModule, DocumentsService } from '@rent/server/documents';
import { EsignModule, EsignService } from '@rent/server/esign';
import { JobsService, OutboxRelay } from '@rent/server/jobs';
import { LedgerModule } from '@rent/server/ledger';
import { MaintenanceModule } from '@rent/server/maintenance';
import { NoticesModule, NoticeTrackingService } from '@rent/server/notices';
import { TasksModule } from '@rent/server/tasks';
import {
  BotService,
  BroadcastsService,
  InboundService,
  MessagingModule,
  MessagingOperationsService,
  MessagingService,
  TemplatesService,
} from '@rent/server/messaging';
import {
  PaymentsModule,
  ProviderPaymentsService,
  QueueService,
  ReceiptsService,
  ReconciliationService,
  RemindersService,
  SettlementAccountsService,
  WebhookInboxRelay,
  WebhooksService,
} from '@rent/server/payments';
import {
  PortfolioModule,
  PropertyFilesService,
  RegisterImportService,
} from '@rent/server/portfolio';
import { TaxAlertsService, TaxAssessmentService, TaxModule } from '@rent/server/tax';
import {
  IdChecksService,
  LeaseLifecycleService,
  TenancyModule,
  TenancyRemindersService,
} from '@rent/server/tenancy';
import { BILLING_EVENT_TYPES, billingJobs } from './billing.jobs';
import { closeRenderer, renderOnPool, renderPdfJob } from './render-pdf.job';
import { ESIGN_EVENT_TYPES, esignJobs } from './esign.jobs';
import { workerJobs } from './jobs';
import { MESSAGING_EVENT_TYPES, messagingJobs } from './messaging.jobs';
import { NOTICES_EVENT_TYPES, noticesJobs, noticesOnRendered } from './notices.jobs';
import { PAYMENTS_EVENT_TYPES, paymentsJobs } from './payments.jobs';
import { REGISTER_EVENT_TYPES, registerJobs } from './register.jobs';
import { taxJobs } from './tax.jobs';
import { TENANCY_EVENT_TYPES, tenancyJobs } from './tenancy.jobs';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, name: 'worker' });

@Module({
  imports: [
    CoreModule.forRoot({ config, logger, applicationName: 'rent-worker' }),
    AuditModule,
    DocumentsModule,
    ApprovalsModule,
    PortfolioModule,
    EsignModule,
    TenancyModule,
    MaintenanceModule,
    MessagingModule,
    LedgerModule,
    BillingModule,
    PaymentsModule,
    // M5: rent tax is assessed in every receipt's posting transaction once this module starts.
    TaxModule,
    // M7: legal notices and staff tasks.
    TasksModule,
    NoticesModule,
  ],
})
class WorkerModule {}

const app = await NestFactory.createApplicationContext(WorkerModule, {
  logger: new NestLogger(logger),
});
app.enableShutdownHooks();

const database = app.get<Database>(DATABASE);
const alerts = app.get<AlertPort>(ALERT_PORT);
const deps = {
  database,
  config: app.get<AppConfig>(CONFIG),
  clock: app.get<Clock>(CLOCK),
  alerts,
  audit: app.get(AuditService),
  approvals: app.get(ApprovalsService),
  documents: app.get(DocumentsService),
};

const storage = app.get<StoragePort>(STORAGE_PORT);
await storage
  .ensureBuckets({ files: config.S3_BUCKET_FILES, evidence: config.S3_BUCKET_EVIDENCE })
  .catch((error: unknown) => logger.warn({ err: error }, 'could not ensure storage buckets'));

const jobs = new JobsService(database, logger, alerts, config.DATABASE_URL);
await jobs.start();
const definitions = [
  ...workerJobs(deps),
  renderPdfJob({ ...deps, storage }),
  ...registerJobs({
    propertyFiles: app.get(PropertyFilesService),
    imports: app.get(RegisterImportService),
  }),
  ...tenancyJobs({
    ...deps,
    messaging: app.get(MessagingService),
    idChecks: app.get(IdChecksService),
    lifecycle: app.get(LeaseLifecycleService),
    reminders: app.get(TenancyRemindersService),
  }),
  ...esignJobs({
    ...deps,
    esign: app.get(EsignService),
    lifecycle: app.get(LeaseLifecycleService),
    render: renderOnPool,
    onRendered: [
      (companyId: string, renderRequestId: string) =>
        app.get(BotService).onDocumentRendered(companyId, renderRequestId),
      // M7 (plan 4.12, notices.issue-delivery): the frozen notice recorded and its links sent.
      noticesOnRendered(app.get(NoticeTrackingService)),
    ],
  }),
  ...messagingJobs({
    ...deps,
    inbound: app.get(InboundService),
    broadcasts: app.get(BroadcastsService),
    operations: app.get(MessagingOperationsService),
    templates: app.get(TemplatesService),
  }),
  ...billingJobs({
    ...deps,
    invoicing: app.get(InvoicingService),
    subledger: app.get(SubledgerCheckService),
  }),
  ...paymentsJobs({
    ...deps,
    providers: app.get<PaymentProviders>(PAYMENT_PROVIDERS),
    webhooks: app.get(WebhooksService),
    providerPayments: app.get(ProviderPaymentsService),
    receipts: app.get(ReceiptsService),
    reminders: app.get(RemindersService),
    reconciliation: app.get(ReconciliationService),
    accounts: app.get(SettlementAccountsService),
    queue: app.get(QueueService),
  }),
  ...noticesJobs({ ...deps, tracking: app.get(NoticeTrackingService) }),
  ...taxJobs({
    ...deps,
    taxAlerts: app.get(TaxAlertsService),
    taxAssessment: app.get(TaxAssessmentService),
    advance: app.get(AdvanceService),
  }),
];
for (const definition of definitions) await jobs.register(definition);
await jobs.watchDeadLetters();

// Event types that have a consumer here; the rest stay in the outbox as the event log.
const relay = new OutboxRelay(
  database,
  jobs,
  logger,
  new Set<string>([
    'documents.render-pdf',
    ...REGISTER_EVENT_TYPES,
    ...TENANCY_EVENT_TYPES,
    ...ESIGN_EVENT_TYPES,
    ...BILLING_EVENT_TYPES,
    ...PAYMENTS_EVENT_TYPES,
    ...MESSAGING_EVENT_TYPES,
    ...NOTICES_EVENT_TYPES,
  ]),
);
await relay.start();
// Provider webhooks stored by the API, queued for processing as they arrive (M4b plan 4.4).
const inbox = new WebhookInboxRelay(database, jobs, logger);
await inbox.start();
logger.info({ jobs: definitions.map((d) => d.name) }, 'worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker stopping');
  await relay.stop();
  await inbox.stop();
  await jobs.stop();
  await closeRenderer();
  await app.close();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
