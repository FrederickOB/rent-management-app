/**
 * The 5,000-unit performance fixture for the dashboard's speed check (M9 plan section 6 and 4.10).
 * It is never part of the demo seed and never touches the `rent` database: it runs only inside the
 * integration harness (`test/dashboard-speed.int.test.ts`, behind RENT_SPEED=1), on that test's
 * own cloned database, with the services wired as the tests wire them.
 *
 * Everything goes through the services, so every rule holds: the register creates the properties
 * and units, tenancy records each lease from paper and billing issues and accrues its invoices
 * (P01, P02), money posts through the billing engine's provider path (P03, with P17's rent tax),
 * and expenses through P15. Work runs on a small pool of concurrent workers; the company's counter
 * lock serialises only the numbering.
 */
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import type { StoragePort } from '@rent/integrations';
import type { InvoicingService } from '../src/billing/invoicing.service';
import type { MoneyService } from '../src/billing/money.service';
import type { OwnersService } from '../src/companies/owners.service';
import type { AppConfig } from '../src/core/config';
import type { ExpensesService } from '../src/maintenance/expenses.service';
import type { RegisterReadService } from '../src/portfolio/register-read.service';
import type { RegisterService } from '../src/portfolio/register.service';
import type { LeasesService } from '../src/tenancy/leases.service';
import type { TenantsService } from '../src/tenancy/tenants.service';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

export interface PerfFixtureServices {
  readonly owners: Pick<OwnersService, 'create'>;
  readonly register: Pick<RegisterService, 'createProperty'>;
  readonly read: Pick<RegisterReadService, 'getProperty'>;
  readonly tenants: Pick<TenantsService, 'create'>;
  readonly leases: Pick<LeasesService, 'createUpload' | 'recordPaper'>;
  readonly invoicing: Pick<InvoicingService, 'onLeaseSigned'>;
  readonly money: Pick<MoneyService, 'recordProviderPayment'>;
  readonly expenses: Pick<ExpensesService, 'record'>;
  readonly storage: StoragePort;
  readonly config: Pick<AppConfig, 'S3_BUCKET_FILES'>;
}

export interface PerfFixtureOptions {
  readonly companyId: string;
  /** An agency admin (creates owners) and a manager (everything else). */
  readonly admin: StaffActor;
  readonly manager: StaffActor;
  /** The company's business date today. */
  readonly today: string;
  readonly units: number;
  readonly unitsPerProperty?: number;
  readonly owners?: number;
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface PerfFixtureResult {
  readonly properties: string[];
  readonly owners: string[];
  readonly leases: number;
  readonly payments: number;
  readonly expenses: number;
  readonly ms: number;
}

const SCAN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

/** Runs `work` over `items` with at most `limit` running at once, in order of start. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await work(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * A portfolio of `units` units, each with a lease: started 1 to 11 months ago, monthly, for a
 * year; seven in ten paid up to date, one in seven a month behind, one in ten six months ahead,
 * the rest never paid; a deposit on every fourth; and three expenses per property.
 */
export async function buildPerfFixture(
  services: PerfFixtureServices,
  options: PerfFixtureOptions,
): Promise<PerfFixtureResult> {
  const started = Date.now();
  const perProperty = options.unitsPerProperty ?? 100;
  const concurrency = options.concurrency ?? 6;
  const owners: string[] = [];
  for (let i = 0; i < (options.owners ?? 5); i += 1)
    owners.push(
      (
        await services.owners.create(options.admin, {
          kind: 'individual',
          displayName: `Perf owner ${i + 1}`,
        })
      ).id,
    );
  const propertyCount = Math.ceil(options.units / perProperty);
  const properties: string[] = [];
  const units: { unitId: string; propertyId: string }[] = [];
  for (let p = 0; p < propertyCount; p += 1) {
    const count = Math.min(perProperty, options.units - p * perProperty);
    const third = Math.floor(count / 3);
    const propertyId = await services.register.createProperty(options.manager, {
      areaCode: 'PRF',
      propertyPart: `P${String(p + 1).padStart(3, '0')}`,
      name: `Perf property ${p + 1}`,
      propertyType: 'apartment_block',
      use: 'residential',
      ownerId: owners[p % owners.length]!,
      address: { region: p % 4 === 0 ? 'Ashanti' : 'Greater Accra', town: 'Accra' },
      units: [
        { unitType: 'apartment', count: count - 2 * third, bedrooms: 2 },
        ...(third > 0 ? [{ unitType: 'single_room' as const, count: third }] : []),
        ...(third > 0 ? [{ unitType: 'chamber_and_hall' as const, count: third }] : []),
      ],
    });
    properties.push(propertyId);
    const detail = await services.read.getProperty(options.manager, propertyId);
    for (const block of detail.blocks)
      for (const unit of block.units) units.push({ unitId: unit.id, propertyId });
  }

  let payments = 0;
  let done = 0;
  await pool(units, concurrency, async ({ unitId }, i) => {
    const monthsAgo = 1 + (i % 11);
    const start = plusMonths(options.today, -monthsAgo);
    const rent = 50_000 + (i % 16) * 10_000;
    const deposit = i % 4 === 0 ? 2 * rent : null;
    const tenantId = (
      await services.tenants.create(options.manager, {
        kind: 'individual',
        displayName: `Perf tenant ${i + 1}`,
      })
    ).tenant.id;
    const upload = await services.leases.createUpload(options.manager, {
      contentType: 'application/pdf',
      sizeBytes: SCAN.length,
    });
    await services.storage.put({
      bucket: services.config.S3_BUCKET_FILES,
      key: upload.fields.key!,
      body: SCAN,
      contentType: 'application/pdf',
    });
    const lease = await services.leases.recordPaper(options.manager, {
      unitId,
      tenantId,
      startDate: start,
      endDate: plusDays(plusMonths(start, 12), -1),
      monthlyRentMinor: rent,
      cycle: 'monthly',
      depositMinor: deposit,
      noticeDays: 30,
      parties: [{ role: 'tenant', name: `Perf tenant ${i + 1}` }],
      scanUploadId: upload.uploadId,
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await services.invoicing.onLeaseSigned(options.companyId, lease.id);
    // Months due so far: the start's and each since, today's included.
    const due = monthsAgo + 1;
    const pattern = i % 20;
    const months = pattern < 14 ? due : pattern < 17 ? due - 1 : pattern < 19 ? due + 6 : 0;
    if (months > 0) {
      await services.money.recordProviderPayment(options.companyId, {
        leaseId: lease.id,
        amountMinor: months * rent + (deposit ?? 0),
        receivedOn: options.today,
      });
      payments += 1;
    }
    done += 1;
    options.onProgress?.(done, units.length);
  });

  let expenses = 0;
  await pool(properties, concurrency, async (propertyId, p) => {
    for (let m = 0; m < 3; m += 1) {
      await services.expenses.record(options.manager, {
        propertyId,
        category: m === 0 ? 'repairs' : m === 1 ? 'cleaning' : 'security',
        supplierName: `Perf supplier ${(p % 7) + 1}`,
        amountMinor: 25_000 + m * 5_000,
        // The register records ownership from the day the property is added, so expenses are dated
        // today: an earlier date would find the property with no owner.
        expenseDate: options.today,
        paidBy: m === 2 ? 'unpaid' : 'owner',
      });
      expenses += 1;
    }
  });
  return {
    properties,
    owners,
    leases: units.length,
    payments,
    expenses,
    ms: Date.now() - started,
  };
}
