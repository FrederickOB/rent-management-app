/**
 * M11 decision 9: replays stored webhooks during an incident, as the console's Replay does, when the
 * console is not the right tool (a day's worth, or the web app is down). Each replay sets the stored
 * row to be processed again and queues the normal processing job, so replaying a webhook that was
 * processed already changes nothing. The worker runs the jobs (if it is down, they wait for it).
 * Each replay is an ops_action in the platform company with the reason, and an audit event in the
 * platform's chain naming the operator, who must be an active platform admin (by email, never
 * printed). Bodies, phones and emails are never printed: ids, providers and statuses only.
 *
 *   pnpm ops:replay-webhooks --operator ops@example.com --reason "Paystack outage 09:00-09:40, ticket 812" \
 *     --id <inbox id> [--id <inbox id> ...]
 *   pnpm ops:replay-webhooks --operator ops@example.com --reason "..." \
 *     [--provider paystack] --from 2026-11-09T00:00:00Z --to 2026-11-10T00:00:00Z [--all] [--limit 1000]
 *   add --dry-run to list what would be replayed, and nothing else.
 *
 * Without --all, a time range selects failed and dead-lettered webhooks only; with it, every stored
 * webhook that can be replayed (signed, with a body). It refuses a database named `rent` unless
 * --allow-rent-database is given (an incident on that database itself).
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
  OPS_CLI_MAX,
  OpsModule,
  operatorByEmail,
  refusalFor,
  WebhookReplayService,
} from '../src/ops';

const { values } = parseArgs({
  options: {
    id: { type: 'string', multiple: true },
    provider: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    all: { type: 'boolean', default: false },
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
if (refusal) fail(`ops:replay-webhooks refused: ${refusal}`);

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
if (ids.length === 0 && (!from || !to))
  fail(
    'Choose the webhooks: --id (one or more), or --from and --to (with --provider if you like).',
  );
if (ids.length > 0 && (from || to || values.provider || values.all))
  fail('--id replays exactly the ids given: leave out --provider, --from, --to and --all.');
const limit = values.limit === undefined ? 1_000 : Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > OPS_CLI_MAX)
  fail(`--limit is a whole number from 1 to ${OPS_CLI_MAX}.`);

const config = loadConfig();
const again = refusalFor(config.DATABASE_URL, values[ALLOW_RENT_FLAG] === true);
if (again) fail(`ops:replay-webhooks refused: ${again}`);

@Module({
  imports: [CoreModule.forRoot({ config, applicationName: 'rent-ops-replay' }), OpsModule],
})
class OpsReplayModule {}

const app = await NestFactory.createApplicationContext(OpsReplayModule, { logger: false });
try {
  const database = app.get<Database>(DATABASE);
  const replay = app.get(WebhookReplayService);
  const operator = await operatorByEmail(database, values.operator!);
  const chosen =
    ids.length > 0
      ? ids.map((id) => ({ id, provider: '?', status: '?' }))
      : await replay.select({
          ...(values.provider ? { provider: values.provider } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          include: values.all ? 'all' : 'failed',
          limit,
        });
  console.log(`${chosen.length} webhook(s) chosen.`);
  if (values['dry-run']) {
    for (const row of chosen) console.log(`  ${row.id} ${row.provider} ${row.status}`);
    console.log('Dry run: nothing replayed.');
  } else {
    let replayed = 0;
    const refused: string[] = [];
    for (const row of chosen) {
      try {
        const view = await replay.replayAs(operator, row.id, reason);
        replayed += 1;
        console.log(`  ${view.id} ${view.provider}: queued (replay ${view.replayCount})`);
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'error';
        refused.push(row.id);
        console.error(`  ${row.id}: not replayed (${code})`);
      }
    }
    console.log(
      `Replayed ${replayed} of ${chosen.length}; the worker processes them through the normal path.` +
        (refused.length > 0 ? ` ${refused.length} not replayed (see above).` : ''),
    );
    if (refused.length > 0) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `ops:replay-webhooks failed: ${error instanceof AppError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'unknown'}`,
  );
  process.exitCode = 1;
} finally {
  await app.close();
}
