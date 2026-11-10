/**
 * The month-end load test's fixture and measurements (M11 decision 7; plan 4.6; load/README.md).
 * It extends the 5,000-unit speed fixture (scripts/perf-fixture.ts) from one user to a working
 * agency at month end, and only ever runs on a scratch database (never `rent`):
 *
 *   build  --out FILE        an agency with LOAD_UNITS units (5,000) in properties of 100, five
 *                            owners with approved settlement accounts (through the fake provider)
 *                            and agreements in force, LOAD_STAFF staff (50: admins, managers,
 *                            accountants, caretakers each assigned a property) with signed-in
 *                            sessions, and a tenant per unit with a phone, SMS consent and a paper
 *                            lease started 1 to 11 months ago, billed on the platform from its
 *                            start (one in ten) or from last month (the rest). Rent is paid up to
 *                            last month (one in ten a month behind), so every lease has an
 *                            invoice due today, the month end. Also the platform company. Writes the session cookies and a pay link per tenant
 *                            to FILE (mode 0600): secrets of a scratch database, never logged.
 *   sample --out FILE        every LOAD_SAMPLE_MS (2 s) until stopped: queue depths, unprocessed
 *                            webhooks, lock waits and waits on the audit chain head (JSON lines).
 *   drain  [--timeout-ms N]  waits until no job, webhook or outbox event is waiting; prints the time.
 *   report --since ISO --out FILE [--samples FILE] [--functions-before FILE]
 *                            what the run left in the database: duplicates, receipt-number gaps,
 *                            payment-to-receipt latency, webhook outcomes, queue and lock samples.
 *   functions --out FILE     a snapshot of pg_stat_user_functions (audit.append's calls and time).
 *
 * Everything is created through the services, as the speed fixture does, so every rule holds.
 */
import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import type { Actor, CompanyKind } from '@rent/domain/policy';
import type { StoragePort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { ApprovalsService } from '../src/approvals';
import { BillingModule, InvoicingService, MoneyService } from '../src/billing';
import { OwnersService } from '../src/companies/owners.service';
import {
  CONFIG,
  CoreModule,
  DATABASE,
  loadConfig,
  STORAGE_PORT,
  type AppConfig,
} from '../src/core';
import type { Clock } from '../src/core/clock';
import { IdentityModule } from '../src/identity';
import { LedgerModule } from '../src/ledger';
import { MessagingModule } from '../src/messaging';
import { PayLinksService, PaymentsModule, SettlementAccountsService } from '../src/payments';
import { PortfolioModule, RegisterReadService, RegisterService } from '../src/portfolio';
import { ReportingMoneyModule } from '../src/reporting';
import { TaxModule } from '../src/tax';
import { LeasesService, TenancyModule, TenantsService } from '../src/tenancy';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    since: { type: 'string' },
    samples: { type: 'string' },
    'functions-before': { type: 'string' },
    'timeout-ms': { type: 'string' },
  },
});
const command = positionals[0];

const config = loadConfig();
const databaseName = new URL(config.DATABASE_URL).pathname.slice(1);
if (
  databaseName === 'rent' ||
  config.NODE_ENV === 'production' ||
  !/^(rent_scratch_|rent_load)/.test(databaseName)
) {
  console.error(
    `load-fixture runs only on a scratch database (rent_scratch_* or rent_load*), not ${databaseName}.`,
  );
  process.exit(2);
}

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const SCAN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/** Runs `work` over `items` with at most `limit` at once (as perf-fixture.ts does). */
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

/** The pesewas as the pay form takes them: `1500.00`. */
const amountText = (minor: number) =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/** Better Auth's session cookie (better-call's signed cookie): token.HMAC-SHA256(token), base64. */
const sessionCookie = (token: string) =>
  `rent.session_token=${encodeURIComponent(
    `${token}.${createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64')}`,
  )}`;

// --- build ----------------------------------------------------------------------------------------

/** The fixture's clock: the real time, moved back while approvals need to be in the past. */
const clock: Clock & { offsetMs: number } = {
  offsetMs: 0,
  now() {
    return new Date(Date.now() + this.offsetMs);
  },
};

@Module({
  imports: [
    CoreModule.forRoot({ config, clock, applicationName: 'rent-load-fixture' }),
    IdentityModule,
    PortfolioModule,
    TenancyModule,
    LedgerModule,
    BillingModule,
    PaymentsModule,
    TaxModule,
    MessagingModule,
    ReportingMoneyModule,
  ],
})
class LoadFixtureModule {}

async function build(out: string): Promise<void> {
  const units = env('LOAD_UNITS', 5_000);
  const staffCount = env('LOAD_STAFF', 50);
  const ownerCount = env('LOAD_OWNERS', 5);
  const perProperty = env('LOAD_UNITS_PER_PROPERTY', 100);
  const concurrency = env('LOAD_FIXTURE_CONCURRENCY', 8);
  const started = Date.now();
  const app = await NestFactory.createApplicationContext(LoadFixtureModule, {
    logger: ['error'],
    abortOnError: false,
  });
  try {
    const database = app.get<Database>(DATABASE);
    const cfg = app.get<AppConfig>(CONFIG);
    const storage = app.get<StoragePort>(STORAGE_PORT);
    await storage.ensureBuckets({ files: cfg.S3_BUCKET_FILES, evidence: cfg.S3_BUCKET_EVIDENCE });
    const today = toIsoDate(businessDateOf(instantFrom(clock.now()), 'Africa/Accra'));

    // The platform company every deployment has (pnpm platform:bootstrap; M10 decision 14): the
    // worker's document and subscription hooks need it.
    await withSystem(database, {}, async (tx) => {
      const found = await tx.execute<{ id: string | null }>(
        sql`select app.platform_company_id() as id`,
      );
      if (!found.rows[0]?.id)
        await tx.execute(
          sql`select app.create_company(null, 'platform', 'Rent Platform (load test)', 'Rent Platform', 'GH', 'Africa/Accra', 'Rent Platform', '{}'::jsonb)`,
        );
    });
    const companyId = await withSystem(database, {}, async (tx) => {
      const result = await tx.execute<{ id: string }>(
        sql`select app.create_company(null, 'agency', 'Load Test Agency', 'Load Test Agency', 'GH', 'Africa/Accra', 'Load Agency', '{}'::jsonb) as id`,
      );
      return result.rows[0]!.id;
    });
    const kind: CompanyKind = 'agency';

    // Staff: people, memberships and signed-in sessions (password and TOTP done), in groups: 8%
    // admins (at least two, so a second person approves), 20% accountants, 32% caretakers and
    // the rest managers.
    type StaffRole = 'agency_admin' | 'accountant' | 'caretaker' | 'property_manager';
    const admins = Math.max(2, Math.ceil((staffCount * 8) / 100));
    const accountants = Math.floor((staffCount * 20) / 100);
    const caretakers = Math.floor((staffCount * 32) / 100);
    const groups: [StaffRole, number][] = [
      ['agency_admin', admins],
      ['accountant', accountants],
      ['caretaker', caretakers],
      ['property_manager', Math.max(1, staffCount - admins - accountants - caretakers)],
    ];
    type StaffEntry = { actor: StaffActor; cookie: string; role: StaffRole };
    const byRole: Record<StaffRole, StaffEntry[]> = {
      agency_admin: [],
      accountant: [],
      caretaker: [],
      property_manager: [],
    };
    let n = 0;
    for (const [role, count] of groups)
      for (let k = 0; k < count; k += 1) {
        n += 1;
        const personId = uuidv7();
        const token = randomBytes(24).toString('base64url');
        await withSystem(database, {}, (tx) =>
          tx.insert(schema.person).values({
            id: personId,
            name: `Load ${role.replace('_', ' ')} ${k + 1}`,
            email: `load-staff-${n}-${companyId.slice(0, 8)}@load.invalid`,
            isTestContact: true,
            twoFactorEnabled: true,
          }),
        );
        const membershipId = await withCompany(
          database,
          { companyId, actorKind: 'system' },
          async (tx) => {
            const [row] = await tx
              .insert(schema.membership)
              .values({ companyId, personId, role })
              .returning({ id: schema.membership.id });
            return row!.id;
          },
        );
        await withSystem(database, { personId }, (tx) =>
          tx.insert(schema.session).values({
            token,
            userId: personId,
            expiresAt: new Date(Date.now() + 12 * 3_600_000),
            authMethod: 'password_totp',
            activeCompanyId: companyId,
            userAgent: 'rent-load-fixture',
          }),
        );
        byRole[role].push({
          role,
          cookie: sessionCookie(token),
          actor: {
            kind: 'staff',
            personId,
            companyId,
            companyKind: kind,
            membershipId,
            role,
            nominatedApprover: false,
            scope: {},
            authMethod: 'password_totp',
          } as StaffActor,
        });
      }
    const staff = groups.flatMap(([role]) => byRole[role]);
    const [admin, approver] = byRole.agency_admin.map((s) => s.actor);
    const manager = byRole.property_manager[0]?.actor ?? admin!;

    // Owners, each with an approved settlement account set up with the provider (ADR-008: asked
    // 49 hours ago, approved 25 hours ago) and an agreement in force (asked 74 hours ago, approved
    // 49 hours ago), as the demo seed does.
    const owners = app.get(OwnersService);
    const accounts = app.get(SettlementAccountsService);
    const approvals = app.get(ApprovalsService);
    const ownerIds: string[] = [];
    for (let i = 0; i < ownerCount; i += 1)
      ownerIds.push(
        (await owners.create(admin!, { kind: 'individual', displayName: `Load owner ${i + 1}` }))
          .id,
      );
    const requested: { accountId: string; approvalId: string }[] = [];
    clock.offsetMs = -49 * 3_600_000;
    try {
      for (const [i, ownerId] of ownerIds.entries())
        requested.push(
          await accounts.request(admin!, {
            holder: 'owner',
            ownerId,
            bankCode: 'FAKEBANK1',
            accountNumber: `0${String(1_000_000_000 + i * 7_919).padStart(10, '0')}`,
            accountName: `Load Owner ${i + 1}`,
          }),
        );
      clock.offsetMs = -25 * 3_600_000;
      for (const r of requested)
        await approvals.decide(approver!, r.approvalId, { decision: 'approve' });
    } finally {
      clock.offsetMs = 0;
    }
    for (const r of requested) await accounts.ready(companyId, r.accountId);
    const agreements: string[] = [];
    clock.offsetMs = -74 * 3_600_000;
    try {
      const askedOn = toIsoDate(businessDateOf(instantFrom(clock.now()), 'Africa/Accra'));
      for (const ownerId of ownerIds) {
        const view = await accounts.setAgreement(admin!, ownerId, {
          destination: 'owner_account',
          effectiveFrom: askedOn,
        });
        if (view.openRequest) agreements.push(view.openRequest.approvalId);
      }
      clock.offsetMs = -49 * 3_600_000;
      for (const approvalId of agreements)
        await approvals.decide(approver!, approvalId, { decision: 'approve' });
    } finally {
      clock.offsetMs = 0;
    }

    // The register: properties of 100 units, each owner's in turn.
    const register = app.get(RegisterService);
    const read = app.get(RegisterReadService);
    const propertyIds: string[] = [];
    const unitIds: string[] = [];
    for (let p = 0; p * perProperty < units; p += 1) {
      const count = Math.min(perProperty, units - p * perProperty);
      const third = Math.floor(count / 3);
      const propertyId = await register.createProperty(manager, {
        areaCode: 'LDT',
        propertyPart: `P${String(p + 1).padStart(3, '0')}`,
        name: `Load property ${p + 1}`,
        propertyType: 'apartment_block',
        use: 'residential',
        ownerId: ownerIds[p % ownerIds.length]!,
        address: { region: 'Greater Accra', town: 'Accra' },
        units: [
          { unitType: 'apartment', count: count - 2 * third, bedrooms: 2 },
          ...(third > 0 ? [{ unitType: 'single_room' as const, count: third }] : []),
          ...(third > 0 ? [{ unitType: 'chamber_and_hall' as const, count: third }] : []),
        ],
      });
      propertyIds.push(propertyId);
      const detail = await read.getProperty(manager, propertyId);
      for (const block of detail.blocks) for (const unit of block.units) unitIds.push(unit.id);
    }
    // Caretakers each look after one property (AD-02).
    const caretakerRows = byRole.caretaker;
    for (const [i, c] of caretakerRows.entries())
      await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
        tx
          .update(schema.membership)
          .set({ scope: { properties: [propertyIds[i % propertyIds.length]!] } })
          .where(eq(schema.membership.id, c.actor.membershipId)),
      );
    console.log(
      `load fixture: company, ${staff.length} staff, ${ownerIds.length} owners, ${propertyIds.length} properties and ${unitIds.length} units in ${Date.now() - started} ms`,
    );

    // A tenant and a paper lease per unit, paid up to last month, the month end's invoice due.
    const tenants = app.get(TenantsService);
    const leases = app.get(LeasesService);
    const invoicing = app.get(InvoicingService);
    const money = app.get(MoneyService);
    const links = app.get(PayLinksService);
    const rows: {
      token: string;
      tenantId: string;
      leaseId: string;
      amountMinor: number;
      amountText: string;
      momoPhone: string;
      /** Billed from its start, up to 11 months ago: the lease balance reads use these. */
      history: boolean;
    }[] = new Array(unitIds.length);
    let done = 0;
    let lastLog = Date.now();
    await pool(unitIds, concurrency, async (unitId, i) => {
      const monthsAgo = 1 + (i % 11);
      const start = plusMonths(today, -monthsAgo);
      const rent = 50_000 + (i % 16) * 10_000;
      // One lease in ten is billed on the platform from its start (up to 11 months of invoices,
      // allocations and accruals: the month-end balance reads' worst case). The rest came onto the
      // platform last month, so each has two invoices and two invoice PDFs, not up to twelve: at
      // 5,000 units the worker renders some 12,000 PDFs rather than 32,000 before the run.
      const history = i % 10 === 0;
      const billedFrom = history ? start : plusMonths(today, -1);
      const billedMonths = history ? monthsAgo : 1;
      // A deposit is invoiced only when billing starts with the lease (a lease billed from a later
      // date brings its deposit in as an opening balance, P25), so only those leases carry one.
      const deposit = history && i % 4 === 0 ? 2 * rent : null;
      const phone = `+23320${String(1_000_000 + i).padStart(7, '0')}`;
      const tenantId = (
        await tenants.create(manager, {
          kind: 'individual',
          displayName: `Load tenant ${i + 1}`,
          phone,
        })
      ).tenant.id;
      await tenants.recordConsent(manager, tenantId, { channel: 'sms', action: 'grant' });
      const upload = await leases.createUpload(manager, {
        contentType: 'application/pdf',
        sizeBytes: SCAN.length,
      });
      await storage.put({
        bucket: cfg.S3_BUCKET_FILES,
        key: upload.fields.key!,
        body: SCAN,
        contentType: 'application/pdf',
      });
      const lease = await leases.recordPaper(manager, {
        unitId,
        tenantId,
        startDate: start,
        endDate: plusDays(plusMonths(start, 12), -1),
        monthlyRentMinor: rent,
        cycle: 'monthly',
        depositMinor: deposit,
        noticeDays: 30,
        parties: [{ role: 'tenant', name: `Load tenant ${i + 1}` }],
        scanUploadId: upload.uploadId,
        signedOn: plusDays(start, -1),
        billingStartDate: billedFrom,
      });
      await invoicing.onLeaseSigned(companyId, lease.id);
      // Paid through last month (and the deposit); one in ten is a month behind.
      const behind = i % 10 === 9 ? 1 : 0;
      const paidMonths = billedMonths - behind;
      if (paidMonths > 0)
        await money.recordProviderPayment(companyId, {
          leaseId: lease.id,
          amountMinor: paidMonths * rent + (deposit ?? 0),
          receivedOn: plusDays(today, -1),
        });
      // The pay link for the invoice due today, as the month-end reminder carries it.
      const token = await withCompany(database, { companyId, actorKind: 'system' }, async (tx) => {
        const [invoice] = await tx
          .select({ id: schema.invoice.id })
          .from(schema.invoice)
          .where(eq(schema.invoice.leaseId, lease.id))
          .orderBy(sql`${schema.invoice.dueDate} desc`)
          .limit(1);
        const { url } = await links.mint(tx, await links.invoice(tx, invoice!.id));
        return url.split('/p/')[1]!;
      });
      rows[i] = {
        token,
        tenantId,
        leaseId: lease.id,
        amountMinor: rent,
        amountText: amountText(rent),
        momoPhone: `024 ${String(i).padStart(7, '0').slice(0, 3)} ${String(i).padStart(7, '0').slice(3)}`,
        history,
      };
      done += 1;
      if (Date.now() - lastLog > 30_000 || done === unitIds.length) {
        lastLog = Date.now();
        console.log(`load fixture: ${done}/${unitIds.length} tenancies`);
      }
    });
    writeFileSync(
      out,
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        database: databaseName,
        companyId,
        today,
        propertyIds,
        staff: staff.map((s) => ({ role: s.role, cookie: s.cookie })),
        tenants: rows,
      })}\n`,
      { mode: 0o600 },
    );
    console.log(
      `load fixture: ${rows.length} tenancies, ${staff.length} staff sessions; built in ${Math.ceil((Date.now() - started) / 1000)} s`,
    );
  } finally {
    await app.close();
  }
}

// --- measurements ---------------------------------------------------------------------------------

/** A bare connection for measuring, as the application role (no services needed). */
async function measuringDatabase() {
  const { createDatabase } = await import('@rent/db');
  return createDatabase(config.DATABASE_URL, { max: 2, applicationName: 'rent-load-measure' });
}

/** The queues the run fills, and how deep each is (jobs due now, not those scheduled later). */
async function depth(database: Database) {
  return withSystem(database, {}, async (tx) => {
    const jobs = await tx.execute<{ name: string; state: string; n: number }>(
      sql`select name, state, count(*)::int as n from pgboss.job
          where state in ('created', 'retry', 'active') and start_after <= now()
          group by name, state`,
    );
    const inbox = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from webhook_inbox where status = 'received'`,
    );
    const byQueue: Record<string, number> = {};
    for (const r of jobs.rows) byQueue[r.name] = (byQueue[r.name] ?? 0) + Number(r.n);
    return {
      jobs: Object.values(byQueue).reduce((a, b) => a + b, 0),
      byQueue,
      inbox: Number(inbox.rows[0]!.n),
    };
  });
}

async function sample(out: string): Promise<void> {
  const database = await measuringDatabase();
  const every = env('LOAD_SAMPLE_MS', 2_000);
  let stop = false;
  process.once('SIGTERM', () => (stop = true));
  process.once('SIGINT', () => (stop = true));
  writeFileSync(out, '');
  while (!stop) {
    const t0 = Date.now();
    try {
      const queues = await depth(database);
      const locks = await withSystem(database, {}, (tx) =>
        tx.execute<{ lock_waiters: number; audit_waiters: number; active: number }>(
          sql`with waiting as (select distinct pid from pg_locks where not granted),
                   audit as (
                     select distinct l.pid from pg_locks l
                     where l.locktype = 'tuple' and l.relation = 'audit_chain_head'::regclass
                       and l.pid in (select pid from waiting))
              select (select count(*) from waiting)::int as lock_waiters,
                     (select count(*) from audit)::int as audit_waiters,
                     (select count(*) from pg_stat_activity
                       where datname = current_database() and state = 'active')::int as active`,
        ),
      );
      appendFileSync(
        out,
        `${JSON.stringify({ at: new Date().toISOString(), ...queues, ...locks.rows[0] })}\n`,
      );
    } catch (error) {
      appendFileSync(
        out,
        `${JSON.stringify({ at: new Date().toISOString(), error: (error as Error).message.slice(0, 200) })}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, every - (Date.now() - t0))));
  }
  await database.close();
}

async function drain(timeoutMs: number): Promise<void> {
  const database = await measuringDatabase();
  const started = Date.now();
  try {
    for (;;) {
      const d = await depth(database);
      if (d.jobs === 0 && d.inbox === 0) {
        console.log(`drained in ${Date.now() - started} ms`);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        console.log(`not drained after ${timeoutMs} ms: ${JSON.stringify(d)}`);
        process.exitCode = 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    await database.close();
  }
}

async function functions(out: string): Promise<void> {
  const database = await measuringDatabase();
  try {
    const rows = await withSystem(database, {}, (tx) =>
      tx.execute<{ name: string; calls: number; total_ms: number; self_ms: number }>(
        sql`select schemaname || '.' || funcname as name, calls::bigint as calls,
                   total_time as total_ms, self_time as self_ms
            from pg_stat_user_functions where schemaname = 'audit'`,
      ),
    );
    writeFileSync(
      out,
      `${JSON.stringify({ at: new Date().toISOString(), functions: rows.rows })}\n`,
    );
  } finally {
    await database.close();
  }
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

async function report(out: string, since: string): Promise<void> {
  const database = await measuringDatabase();
  try {
    const fixture = { companyId: '' };
    const company = await withSystem(database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.company_ids() as id`),
    );
    const companies = company.rows.map((r) => r.id);
    const result: Record<string, unknown> = { database: databaseName, since };
    const perCompany = [];
    for (const companyId of companies) {
      fixture.companyId = companyId;
      const row = await withCompany(database, { companyId, actorKind: 'system' }, async (tx) => {
        const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
          (await tx.execute<T>(q)).rows[0]!;
        const payments = await one<{ n: number; refs: number; intents: number }>(
          sql`select count(distinct p.id)::int as n, count(distinct p.provider_reference)::int as refs,
                     count(distinct p.id) filter (where i.id is not null)::int as intents
              from payment p left join payment_intent i on i.company_id = p.company_id and i.payment_id = p.id
              where p.created_at >= ${since}::timestamptz and p.provider_reference is not null`,
        );
        const intentsTwice = await one<{ n: number }>(
          sql`select count(*)::int as n from (
                select payment_id from payment_intent where payment_id is not null
                group by payment_id having count(*) > 1) d`,
        );
        const receipts = await one<{
          n: number;
          min: number | null;
          max: number | null;
          dup: number;
        }>(
          sql`select count(*)::int as n, min(number)::bigint as min, max(number)::bigint as max,
                     (count(*) - count(distinct (payment_id, kind)))::int as dup from receipt`,
        );
        const deliveries = await tx.execute<{ status: string; latency_ms: number | null }>(
          sql`select status, latency_ms from receipt_delivery where created_at >= ${since}::timestamptz`,
        );
        const intents = await tx.execute<{ status: string; n: number }>(
          sql`select status, count(*)::int as n from payment_intent
              where created_at >= ${since}::timestamptz group by status`,
        );
        return {
          payments,
          intentsTwice,
          receipts,
          deliveries: deliveries.rows,
          intents: intents.rows,
        };
      });
      if (Number(row.payments.n) === 0 && Number(row.receipts.n) === 0) continue;
      const latencies = row.deliveries
        .map((d) => d.latency_ms)
        .filter((v): v is number => v !== null)
        .map(Number);
      const receiptCount = Number(row.receipts.n);
      perCompany.push({
        companyId,
        payments: Number(row.payments.n),
        duplicatePayments: Number(row.payments.n) - Number(row.payments.refs),
        paymentsFromIntents: Number(row.payments.intents),
        intentsSharingAPayment: Number(row.intentsTwice.n),
        intents: Object.fromEntries(row.intents.map((r) => [r.status, Number(r.n)])),
        receipts: receiptCount,
        receiptNumberGaps:
          receiptCount === 0
            ? 0
            : Number(row.receipts.max) - Number(row.receipts.min) + 1 - receiptCount,
        receiptsStartAtOne: receiptCount === 0 || Number(row.receipts.min) === 1,
        duplicateReceipts: Number(row.receipts.dup),
        receiptDeliveries: row.deliveries.length,
        deliveryStatuses: row.deliveries.reduce<Record<string, number>>(
          (acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }),
          {},
        ),
        paymentToReceiptSentMs: {
          count: latencies.length,
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          max: latencies.length ? Math.max(...latencies) : null,
        },
      });
    }
    result.companies = perCompany;
    const inbox = await withSystem(database, {}, (tx) =>
      tx.execute<{ status: string; outcome: string | null; n: number }>(
        sql`select status, outcome, count(*)::int as n from webhook_inbox
            where received_at >= ${since}::timestamptz group by status, outcome order by n desc`,
      ),
    );
    result.webhooks = inbox.rows.map((r) => ({ ...r, n: Number(r.n) }));
    result.queuesNow = await depth(database);
    if (args.samples && existsSync(args.samples)) {
      const samples = readFileSync(args.samples, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, number & string>)
        .filter((s) => s.error === undefined);
      const series = (key: string) => samples.map((s) => Number(s[key] ?? 0));
      const auditWaits = series('audit_waiters');
      result.samples = {
        count: samples.length,
        maxJobsWaiting: Math.max(0, ...series('jobs')),
        maxWebhooksWaiting: Math.max(0, ...series('inbox')),
        maxLockWaiters: Math.max(0, ...series('lock_waiters')),
        maxActive: Math.max(0, ...series('active')),
        auditChainHead: {
          maxWaiting: Math.max(0, ...auditWaits),
          samplesWithAWaiter: auditWaits.filter((n) => n > 0).length,
          shareOfSamples: samples.length
            ? auditWaits.filter((n) => n > 0).length / samples.length
            : 0,
        },
        series: samples.map((s) => ({
          at: s.at,
          jobs: s.jobs,
          inbox: s.inbox,
          auditWaiters: s.audit_waiters,
        })),
      };
    }
    if (args['functions-before']) {
      const before = JSON.parse(readFileSync(args['functions-before'], 'utf8')) as {
        functions: { name: string; calls: number; total_ms: number }[];
      };
      const now = await withSystem(database, {}, (tx) =>
        tx.execute<{ name: string; calls: number; total_ms: number }>(
          sql`select schemaname || '.' || funcname as name, calls::bigint as calls, total_time as total_ms
              from pg_stat_user_functions where schemaname = 'audit'`,
        ),
      );
      result.auditFunctions = now.rows.map((r) => {
        const b = before.functions.find((f) => f.name === r.name);
        const calls = Number(r.calls) - Number(b?.calls ?? 0);
        const ms = Number(r.total_ms) - Number(b?.total_ms ?? 0);
        return {
          name: r.name,
          calls,
          totalMs: Math.ceil(ms),
          meanMs: calls > 0 ? ms / calls : null,
        };
      });
    }
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`load report written to ${out}`);
  } finally {
    await database.close();
  }
}

switch (command) {
  case 'build':
    await build(args.out ?? 'fixture.json');
    break;
  case 'sample':
    await sample(args.out ?? 'samples.jsonl');
    break;
  case 'drain':
    await drain(Number(args['timeout-ms'] ?? 15 * 60_000));
    break;
  case 'functions':
    await functions(args.out ?? 'functions.json');
    break;
  case 'report':
    await report(args.out ?? 'report.json', args.since ?? new Date(0).toISOString());
    break;
  default:
    console.error('usage: load-fixture.ts build|sample|drain|functions|report [--out FILE]');
    process.exit(2);
}
process.exit(process.exitCode ?? 0);
