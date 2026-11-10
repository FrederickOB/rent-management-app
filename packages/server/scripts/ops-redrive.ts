/**
 * M11 decision 9: retries dead-lettered jobs during an incident, as the console's Retry does. Each
 * retry sends the job's payload to its queue again (through `ops.retry-job` in the worker, once per
 * retry); every job is idempotent, so retrying work already done changes nothing. A job that
 * processes a stored webhook is refused: replay the webhook (`pnpm ops:replay-webhooks`), so its row
 * records it. Each retry is an ops_action in the platform company with the reason, and an audit
 * event in the platform's chain naming the operator, who must be an active platform admin (by
 * email, never printed). Payloads are never printed: ids and queue names only.
 *
 *   pnpm ops:redrive --operator ops@example.com --reason "Storage back after the 02:00 outage" \
 *     --id <dead-letter job id> [--id ...]
 *   pnpm ops:redrive --operator ops@example.com --reason "..." \
 *     --queue billing.accrue.company [--from 2026-11-09T00:00:00Z] [--to 2026-11-10T00:00:00Z] \
 *     [--include-retried] [--limit 1000]
 *   add --dry-run to list what would be retried, and nothing else.
 *
 * A --queue selection leaves out jobs a platform admin has retried already, unless
 * --include-retried is given. It refuses a database named `rent` unless --allow-rent-database is
 * given (an incident on that database itself).
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
  DeadLetterService,
  OPS_CLI_MAX,
  OpsModule,
  operatorByEmail,
  refusalFor,
} from '../src/ops';

const { values } = parseArgs({
  options: {
    id: { type: 'string', multiple: true },
    queue: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    'include-retried': { type: 'boolean', default: false },
    limit: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
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
if (refusal) fail(`ops:redrive refused: ${refusal}`);

const reason = values.reason?.trim() ?? '';
if (reason.length < OPS_REASON_MIN || reason.length > OPS_REASON_MAX)
  fail(
    `--reason is required: ${OPS_REASON_MIN} to ${OPS_REASON_MAX} characters, kept in the audit log.`,
  );
if (!values.operator?.trim()) fail('--operator is required: your platform admin email.');
const ids = values.id ?? [];
const time = (name: 'from' | 'to'): Date | undefined => {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) fail(`--${name} is not a date and time (ISO 8601, with a zone).`);
  return at;
};
const from = time('from');
const to = time('to');
if (ids.length === 0 && !values.queue)
  fail('Choose the jobs: --id (one or more), or --queue (with --from and --to if you like).');
if (ids.length > 0 && (values.queue || from || to))
  fail('--id retries exactly the ids given: leave out --queue, --from and --to.');
const limit = values.limit === undefined ? 1_000 : Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > OPS_CLI_MAX)
  fail(`--limit is a whole number from 1 to ${OPS_CLI_MAX}.`);

const config = loadConfig();
const again = refusalFor(config.DATABASE_URL, values[ALLOW_RENT_FLAG] === true);
if (again) fail(`ops:redrive refused: ${again}`);

@Module({
  imports: [CoreModule.forRoot({ config, applicationName: 'rent-ops-redrive' }), OpsModule],
})
class OpsRedriveModule {}

const app = await NestFactory.createApplicationContext(OpsRedriveModule, { logger: false });
try {
  const database = app.get<Database>(DATABASE);
  const deadLetters = app.get(DeadLetterService);
  const operator = await operatorByEmail(database, values.operator!);
  const chosen =
    ids.length > 0
      ? ids.map((id) => ({ id, name: '?' as string | null }))
      : await deadLetters.select({
          queue: values.queue!,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          skipRetried: values['include-retried'] !== true,
          limit,
        });
  console.log(`${chosen.length} dead-lettered job(s) chosen.`);
  if (values['dry-run']) {
    for (const row of chosen) console.log(`  ${row.id} ${row.name ?? 'unknown'}`);
    console.log('Dry run: nothing retried.');
  } else {
    let retried = 0;
    const refused: string[] = [];
    for (const row of chosen) {
      try {
        const view = await deadLetters.retryAs(operator, row.id, reason);
        retried += 1;
        console.log(`  ${view.id} ${view.name}: queued`);
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'error';
        refused.push(row.id);
        console.error(`  ${row.id}: not retried (${code})`);
      }
    }
    console.log(
      `Retried ${retried} of ${chosen.length}; the worker sends each to its queue again.` +
        (refused.length > 0 ? ` ${refused.length} not retried (see above).` : ''),
    );
    if (refused.length > 0) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `ops:redrive failed: ${error instanceof AppError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'unknown'}`,
  );
  process.exitCode = 1;
} finally {
  await app.close();
}
