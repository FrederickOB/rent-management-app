/**
 * Adds a row to the rules table (TX-08). Rows are never edited: a new value, a verification
 * or a correction is always a new row with its own effective date (CLAUDE.md section 7).
 *
 *   pnpm rules:add --key rent_tax.rate.residential --value '{"bps":800}' --from 2027-01-01 \
 *     --source "GRA notice 2026/14" --status verified --verified-by "Ama Mensah, tax adviser" --by "founder"
 */
import { parseArgs } from 'node:util';
import { createDatabase, sql, withSystem } from '@rent/db';
import { loadConfig } from '../src/core/config';
import { RulesService } from '../src/rules/rules.service';

const { values } = parseArgs({
  options: {
    country: { type: 'string', default: 'GH' },
    key: { type: 'string' },
    value: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    source: { type: 'string' },
    status: { type: 'string' },
    'verified-by': { type: 'string' },
    notes: { type: 'string' },
    by: { type: 'string' },
  },
});

const required = ['key', 'value', 'from', 'source', 'status', 'by'] as const;
const missing = required.filter((name) => !values[name]);
if (missing.length > 0) {
  console.error(
    `Missing --${missing.join(', --')}. See the usage at the top of scripts/rules-add.ts.`,
  );
  process.exit(1);
}
if (!['verified', 'from_prd', 'unverified'].includes(values.status!)) {
  console.error('--status must be verified, from_prd or unverified');
  process.exit(1);
}

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL, { max: 1, applicationName: 'rent-rules-add' });
try {
  const platform = await withSystem(database, {}, (tx) =>
    tx.execute<{ id: string | null }>(sql`select app.platform_company_id() as id`),
  );
  const platformId = platform.rows[0]?.id;
  if (!platformId)
    throw new Error('No platform company exists; run pnpm db:seed or create it first');
  const id = await new RulesService(database).add(
    {
      country: values.country!,
      key: values.key!,
      value: JSON.parse(values.value!) as unknown,
      effectiveFrom: values.from!,
      effectiveTo: values.to ?? null,
      source: values.source!,
      verificationStatus: values.status as 'verified' | 'from_prd' | 'unverified',
      verifiedBy: values['verified-by'] ?? null,
      notes: values.notes ?? null,
      createdBy: values.by!,
    },
    platformId,
  );
  console.log(`Added rule ${id}: ${values.key} from ${values.from}.`);
} finally {
  await database.close();
}
