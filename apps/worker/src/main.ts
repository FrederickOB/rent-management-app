import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Database } from '@rent/db';
import type { AlertPort, StoragePort } from '@rent/integrations';
import { ApprovalsModule, ApprovalsService } from '@rent/server/approvals';
import { AuditModule, AuditService } from '@rent/server/audit';
import {
  ALERT_PORT,
  CLOCK,
  CONFIG,
  CoreModule,
  createLogger,
  DATABASE,
  loadConfig,
  NestLogger,
  STORAGE_PORT,
  type AppConfig,
  type Clock,
} from '@rent/server/core';
import { DocumentsModule, DocumentsService } from '@rent/server/documents';
import { EsignModule, EsignService } from '@rent/server/esign';
import { JobsService, OutboxRelay } from '@rent/server/jobs';
import { MessagingModule, MessagingService } from '@rent/server/messaging';
import {
  PortfolioModule,
  PropertyFilesService,
  RegisterImportService,
} from '@rent/server/portfolio';
import {
  IdChecksService,
  LeaseLifecycleService,
  TenancyModule,
  TenancyRemindersService,
} from '@rent/server/tenancy';
import { closeRenderer, renderOnPool, renderPdfJob } from './render-pdf.job';
import { ESIGN_EVENT_TYPES, esignJobs } from './esign.jobs';
import { workerJobs } from './jobs';
import { REGISTER_EVENT_TYPES, registerJobs } from './register.jobs';
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
    MessagingModule,
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
  ]),
);
await relay.start();
logger.info({ jobs: definitions.map((d) => d.name) }, 'worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker stopping');
  await relay.stop();
  await jobs.stop();
  await closeRenderer();
  await app.close();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
