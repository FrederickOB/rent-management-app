/**
 * Every nightly integrity check, run once against the database DATABASE_URL names (M11 decision
 * 10; NFR-BACKUP and NFR-SCALE). The restore and point-in-time drills run it against their copy,
 * and the load test runs it after its peak. It calls the same services the worker's nightly jobs
 * call, read only and with alerts off:
 * - `audit.verify-chain`: every company's chain recomputed from its first event, and every
 *   recorded anchor still matching (AuditService);
 * - `billing.subledger-check`: every entry balanced in each book; 1100 per invoice line, 2010 and
 *   2100 per lease, payments, cash on hand and suspense against their sub-ledgers;
 * - `ledger.agent-cash-check`: no owner's agent-held cash (1070) below zero;
 * - `reporting.fee-check`: management fees against rate and base, and against the ledger;
 * - `subscription.subledger-check`: the platform book against the subscription sub-ledgers.
 *
 *   pnpm --filter @rent/server exec tsx --tsconfig tsconfig.runtime.json scripts/drill-checks.ts \
 *     [--json FILE]
 *
 * Exits 0 when every check passes, 1 when any fails. It refuses the database `rent`: the drills
 * and the load test only ever point it at a copy or a scratch database. Prints ids and counts
 * only, never personal data.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql, withSystem, type Database } from '@rent/db';
import { AuditModule, AuditService } from '../src/audit';
import { BillingModule, SubledgerCheckService } from '../src/billing';
import { CoreModule, DATABASE, loadConfig } from '../src/core';
import { AgentCashCheckService, LedgerModule } from '../src/ledger';
import { ManagementFeesService, ReportingMoneyModule } from '../src/reporting';
import { SubscriptionModule, SubscriptionSubledgerCheck } from '../src/subscription';

const { values: args } = parseArgs({ options: { json: { type: 'string' } } });

const config = loadConfig();
const databaseName = new URL(config.DATABASE_URL).pathname.slice(1);
if (databaseName === 'rent' || config.NODE_ENV === 'production') {
  console.error('drill-checks runs against a copy or a scratch database, never rent.');
  process.exit(2);
}

@Module({
  imports: [
    CoreModule.forRoot({ config, applicationName: 'rent-drill-checks' }),
    AuditModule,
    LedgerModule,
    BillingModule,
    ReportingMoneyModule,
    SubscriptionModule,
  ],
})
class DrillChecksModule {}

interface CheckResult {
  readonly check: string;
  readonly subject: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: Record<string, unknown>;
}

const app = await NestFactory.createApplicationContext(DrillChecksModule, {
  logger: ['error'],
  abortOnError: false,
});
const results: CheckResult[] = [];
const started = performance.now();
try {
  const database = app.get<Database>(DATABASE);
  const audit = app.get(AuditService);
  const subledger = app.get(SubledgerCheckService);
  const agentCash = app.get(AgentCashCheckService);
  const fees = app.get(ManagementFeesService);
  const subscriptions = app.get(SubscriptionSubledgerCheck);

  const timed = async (
    check: string,
    subject: string,
    run: () => Promise<{ ok: boolean; detail: Record<string, unknown> }>,
  ) => {
    const t0 = performance.now();
    try {
      const { ok, detail } = await run();
      results.push({ check, subject, ok, ms: Math.ceil(performance.now() - t0), detail });
    } catch (error) {
      results.push({
        check,
        subject,
        ok: false,
        ms: Math.ceil(performance.now() - t0),
        detail: { error: (error as Error).name, message: (error as Error).message.slice(0, 200) },
      });
    }
  };

  // The scheduler's own list of companies (ADR-002 system path).
  const companies = (
    await withSystem(database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.company_ids() as id`),
    )
  ).rows.map((r) => r.id);

  for (const companyId of companies) {
    await timed('audit.verify-chain', companyId, async () => {
      const chain = await audit.verifyChain(companyId);
      const anchors = await audit.anchorsMatch(companyId);
      return {
        ok: chain.ok && anchors,
        detail: {
          events: chain.events,
          firstBadSeq: chain.firstBadSeq,
          problem: chain.problem,
          anchorsMatch: anchors,
        },
      };
    });
    await timed('billing.subledger-check', companyId, async () => {
      const r = await subledger.check(companyId, { alert: false });
      return {
        ok: r.mismatches.length === 0,
        detail: {
          leases: r.leases,
          lines: r.lines,
          mismatches: r.mismatches.length,
          first: r.mismatches.slice(0, 5).map((m) => `${m.check}:${m.subject}`),
        },
      };
    });
    await timed('ledger.agent-cash-check', companyId, async () => {
      const r = await agentCash.check(companyId, { alert: false });
      return {
        ok: r.negative.length === 0,
        detail: { books: r.books, negative: r.negative.length },
      };
    });
    await timed('reporting.fee-check', companyId, async () => {
      const r = await fees.check(companyId, { alert: false });
      return { ok: r.mismatches.length === 0, detail: { mismatches: r.mismatches.length } };
    });
  }
  await timed('subscription.subledger-check', 'platform', async () => {
    const r = await subscriptions.check({ alert: false });
    return {
      ok: r.mismatches.length === 0,
      detail: { invoices: r.invoices, subscribers: r.subscribers, mismatches: r.mismatches.length },
    };
  });
} finally {
  await app.close();
}

const failed = results.filter((r) => !r.ok);
const summary = {
  database: databaseName,
  companies: new Set(results.filter((r) => r.subject !== 'platform').map((r) => r.subject)).size,
  checks: results.length,
  failed: failed.length,
  ms: Math.ceil(performance.now() - started),
  byCheck: Object.fromEntries(
    [...new Set(results.map((r) => r.check))].map((check) => {
      const of = results.filter((r) => r.check === check);
      return [
        check,
        {
          runs: of.length,
          failed: of.filter((r) => !r.ok).length,
          ms: of.reduce((sum, r) => sum + r.ms, 0),
        },
      ];
    }),
  ),
  failures: failed,
};
if (args.json) writeFileSync(args.json, `${JSON.stringify({ ...summary, results }, null, 2)}\n`);
for (const [check, s] of Object.entries(summary.byCheck))
  console.log(
    `${s.failed === 0 ? 'ok    ' : 'FAILED'}  ${check.padEnd(30)} ${String(s.runs).padStart(4)} run(s)  ${String(s.ms).padStart(7)} ms`,
  );
for (const f of failed) console.log(`        ${f.check} ${f.subject}: ${JSON.stringify(f.detail)}`);
console.log(
  `Nightly checks on ${databaseName}: ${summary.checks - summary.failed}/${summary.checks} passed for ${summary.companies} companies in ${summary.ms} ms.`,
);
process.exit(failed.length === 0 ? 0 : 1);
