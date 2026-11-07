import { withCompany } from '@rent/db';
import { renderHtml, templates } from '@rent/documents';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_STATEMENT_TEMPLATE } from '../src/reporting/statements.service';
import { buildPerfFixture, type PerfFixtureResult } from '../scripts/perf-fixture';
import { startServerTest, type ServerTestContext } from './support';
import { billingServices, moneyCompany, type BillingServices } from './support/billing';
import { maintenanceServices, type MaintenanceServices } from './support/maintenance';
import {
  reportingStatementsServices,
  statementRecords,
  type ReportingStatementsServices,
} from './support/reporting-statements';
import { taxServices } from './support/tax';
import { tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * A month's owner statement at 5,000 units (M9 plan section 6; review: the statement's speed was
 * never measured): one owner holds the whole 5,000-unit fixture, and the month the fixture's money
 * fell in is drafted, issued and read again, each within 20 s. The fixture records everything
 * today, so the clock then moves into next month to make that month a past one. Advisory: it runs
 * only with RENT_SPEED=1 (RENT_SPEED_UNITS sets the size), on this test's own cloned database,
 * with the fixture of scripts/perf-fixture.ts.
 */
const enabled = process.env.RENT_SPEED === '1';
const UNITS = Number(process.env.RENT_SPEED_UNITS ?? 5_000);
const STATEMENT_MS = 20_000;
const HOUR = 3_600_000;

let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MaintenanceServices;
let r: ReportingStatementsServices;
let company: Awaited<ReturnType<typeof moneyCompany>>;
let fixture: PerfFixtureResult;
let month: string;

const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.ceil(performance.now() - t0) };
};

describe.skipIf(!enabled)('AC-04 a month’s statement at 5,000 units (advisory)', () => {
  beforeAll(async () => {
    ctx = await startServerTest();
    s = tenancyServices(ctx);
    b = billingServices(ctx, s);
    const t = taxServices(ctx, s, b);
    m = maintenanceServices(ctx, s, b, t);
    r = reportingStatementsServices(ctx, s, b);
    company = await moneyCompany(ctx, s, 'agency', 'Statement Speed Agency');
    const today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
    month = today.slice(0, 7);
    let last = 0;
    fixture = await buildPerfFixture(
      {
        owners: s.owners,
        register: s.register,
        read: s.read,
        tenants: s.tenants,
        leases: s.leases,
        invoicing: b.invoicing,
        money: b.money,
        expenses: m.expenses,
        storage: ctx.storage,
        config: ctx.config,
      },
      {
        companyId: company.companyId,
        admin: company.admin,
        manager: company.manager,
        today,
        units: UNITS,
        owners: 1,
        onProgress: (done, total) => {
          if (done - last >= 500 || done === total) {
            last = done;
            console.info(`perf fixture: ${done}/${total} leases`);
          }
        },
      },
    );
    console.info(
      `perf fixture: ${fixture.leases} leases, ${fixture.payments} payments, ${fixture.expenses} expenses in ${fixture.ms} ms`,
    );
    // Into next month (the 15th, noon UTC), so this month is over and can be drafted.
    const next = addMonths(parseBusinessDate(`${month}-01`), 1);
    ctx.clock.set(new Date(`${toIsoDate(addDays(next, 14))}T12:00:00Z`));
  }, 3 * HOUR);

  afterAll(async () => {
    await ctx?.close();
  });

  it(
    'drafts, issues and reads one owner’s month within 20 s each',
    async () => {
      const owner = fixture.owners[0]!;
      const draft = await timed(() =>
        r.statements.draft(company.manager, { ownerId: owner, month }),
      );
      const pages = draft.value.figures.properties.length;
      console.info(`statement draft: ${pages} property pages in ${draft.ms} ms`);
      expect(pages).toBe(fixture.properties.length);
      expect(draft.value.figures.summary.occupancy.units).toBe(fixture.leases);
      expect(draft.value.figures.checks.every((c) => c.passed)).toBe(true);
      const issue = await timed(() => r.statements.issue(company.manager, draft.value.id));
      console.info(`statement issue: ${issue.ms} ms`);
      const read = await timed(() => r.statements.get(company.manager, draft.value.id));
      console.info(`statement read (frozen figures, one regeneration): ${read.ms} ms`);
      expect(read.value.matchesIssued).toBe(true);
      // The PDF's HTML from the frozen data, as the renderer receives it (Chromium aside).
      const record = await statementRecords(ctx, company.companyId, draft.value.id);
      const frozen = await withCompany(
        ctx.database,
        { companyId: company.companyId, actorKind: 'system' },
        (tx) => s.documents.renderedDocument(tx, record.row!.render_request_id!),
      );
      const html = await timed(() =>
        Promise.resolve(
          renderHtml(
            templates.get(OWNER_STATEMENT_TEMPLATE.key, OWNER_STATEMENT_TEMPLATE.version),
            frozen!.data,
            {
              senderName: 'Statement Speed Agency',
              primaryColour: '#0F766E',
              accentColour: '#F59E0B',
            },
          ).length,
        ),
      );
      console.info(`statement HTML: ${html.value} characters in ${html.ms} ms`);
      expect(draft.ms).toBeLessThan(STATEMENT_MS);
      expect(issue.ms).toBeLessThan(STATEMENT_MS);
      expect(read.ms).toBeLessThan(STATEMENT_MS);
      expect(html.ms).toBeLessThan(STATEMENT_MS);
    },
    HOUR,
  );
});
