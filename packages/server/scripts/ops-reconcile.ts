/**
 * M11 (coordinator follow-up): runs a day's reconciliation again during an incident, as the 02:00
 * and 02:30 jobs do: every provider's transactions (missed payments go through the normal path;
 * differences are flagged for a person), then every provider's settlements (P22, once per
 * settlement). Both are idempotent, so running a day again changes nothing already reconciled. The
 * run is recorded in the platform's audit chain with the reason and the operator, who must be an
 * active platform admin (by email, never printed). Only ids and counts are printed.
 *
 *   pnpm ops:reconcile --day 2026-11-09 [--provider paystack] \
 *     --operator ops@example.com --reason "Webhooks lost 09:00-09:40, ticket 812"
 *
 * It loads what the worker loads around a posting (rent tax, management fees, subscriptions), so a
 * payment it posts is assessed and charged as the worker would. It refuses a database named `rent`
 * unless --allow-rent-database is given (an incident on that database itself).
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Database } from '@rent/db';
import { OPS_REASON_MAX, OPS_REASON_MIN } from '@rent/domain/ops';
import { AppError, CoreModule, DATABASE, loadConfig } from '../src/core';
import {
  ALLOW_RENT_FLAG,
  operatorByEmail,
  OpsReconcileModule,
  ReconciliationRunService,
  refusalFor,
} from '../src/ops';
import { ManagementFeesService, ReportingMoneyModule } from '../src/reporting';
import { SubscriptionModule } from '../src/subscription';
import { TaxModule } from '../src/tax';

const { values } = parseArgs({
  options: {
    day: { type: 'string' },
    provider: { type: 'string' },
    reason: { type: 'string' },
    operator: { type: 'string' },
    [ALLOW_RENT_FLAG]: { type: 'boolean', default: false },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

// The guard comes before anything reads the configuration or connects.
const refusal = refusalFor(process.env.DATABASE_URL, values[ALLOW_RENT_FLAG] === true);
if (refusal) fail(`ops:reconcile refused: ${refusal}`);

const reason = values.reason?.trim() ?? '';
if (reason.length < OPS_REASON_MIN || reason.length > OPS_REASON_MAX)
  fail(
    `--reason is required: ${OPS_REASON_MIN} to ${OPS_REASON_MAX} characters, kept in the audit log.`,
  );
if (!values.operator?.trim()) fail('--operator is required: your platform admin email.');
if (!values.day || !/^\d{4}-\d{2}-\d{2}$/.test(values.day))
  fail('--day is required: the Accra day to reconcile, YYYY-MM-DD.');

const config = loadConfig();
const again = refusalFor(config.DATABASE_URL, values[ALLOW_RENT_FLAG] === true);
if (again) fail(`ops:reconcile refused: ${again}`);

@Module({
  imports: [
    CoreModule.forRoot({ config, applicationName: 'rent-ops-reconcile' }),
    OpsReconcileModule,
    // As the worker: rent tax on every receipt (billing refuses to start without it), management
    // fees on every allocation, and the platform's own charges handed to subscriptions.
    TaxModule,
    ReportingMoneyModule,
    SubscriptionModule,
  ],
})
class OpsReconcileCliModule {}

const app = await NestFactory.createApplicationContext(OpsReconcileCliModule, { logger: false });
try {
  // The fee hook registers as its service is made; make sure it is.
  app.get(ManagementFeesService);
  const operator = await operatorByEmail(app.get<Database>(DATABASE), values.operator!);
  const result = await app
    .get(ReconciliationRunService)
    .runAs(operator, { day: values.day!, provider: values.provider ?? null }, reason);
  console.log(`Reconciled ${result.day} (run ${result.runId}).`);
  for (const r of result.providers)
    console.log(
      `  ${r.provider}: ${r.transactions.listed} listed, ${r.transactions.matched} matched, ` +
        `${r.transactions.processed} processed, ${r.transactions.exceptions} for a person; ` +
        `${r.settlementsPosted} settlement(s) posted`,
    );
} catch (error) {
  console.error(
    `ops:reconcile failed: ${error instanceof AppError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'unknown'}`,
  );
  process.exitCode = 1;
} finally {
  await app.close();
}
