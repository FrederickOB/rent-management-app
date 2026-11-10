import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { OWNER_COLUMNS } from '@rent/domain/onboarding';
import { PROPERTY_COLUMNS, UNIT_COLUMNS, XLSX_CONTENT_TYPE } from '@rent/domain/portfolio';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemindersService } from '../src/payments/reminders.service';
import { startServerTest, type ServerTestContext } from './support';
import {
  billingServices,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import {
  batchRecord,
  committed,
  countOf,
  onboardingServices,
  onboardingWorkbook,
  outboxOf,
  uploadBatch,
  validated,
  type OnboardingServices,
} from './support/onboarding';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * Pilot onboarding, steps 1 and 2 (M11 decision 2; PR-08, TL-01, TL-06, CM-09, BC-09, AD-02),
 * against the real database: the register's Owners sheet, the Tenants and Leases workbook with
 * its dry run, commit and re-import, paper leases whose scan follows, and an import that never
 * messages a tenant, now or through the reminders that follow it. Fictional numbers only.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let o: OnboardingServices;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let today: string;
let cutOver: string;
let units: string[];
let ownerId: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));

const PHONE_KOFI = '024 000 0101';
const PHONE_KOFI_E164 = '+233240000101';
const PHONE_AMA = '024 000 0102';
const COMPANY_TIN = 'C0000000101';

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  o = onboardingServices(ctx, s, b);
  agency = await moneyCompany(ctx, s, 'agency', 'Onboarding Tenancies Agency');
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  cutOver = `${today.slice(0, 7)}-01`;
  ownerId = (
    await s.owners.create(agency.admin, {
      kind: 'individual',
      displayName: 'Owner One',
      reference: 'OWN-T1',
    })
  ).id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'TEN',
    ownerId,
    units: [{ unitType: 'apartment', count: 6, bedrooms: 2 }],
  });
  units = Object.keys(property.units).sort();
});

afterAll(async () => {
  await ctx.close();
});

/** A lease that started four months before the cut-over's month, for a year. */
const leaseStart = () => toIsoDate(addMonths(parseBusinessDate(cutOver), -4));
const leaseEnd = (start: string) => toIsoDate(addDays(addMonths(parseBusinessDate(start), 12), -1));

const tenancies = (
  unitA: string,
  unitB: string,
  extra: {
    tenants?: Record<string, string | null>[];
    leases?: Record<string, string | null>[];
  } = {},
) => {
  const start = leaseStart();
  return onboardingWorkbook('tenancies', {
    tenants: [
      {
        kind: 'Individual',
        name: 'Kofi Asante',
        phone: PHONE_KOFI,
        idType: 'Ghana Card',
        idNumber: 'GHA-000000101-1',
        consentWhatsapp: 'Yes',
        consentSms: 'Yes',
        consentEmail: 'No',
      },
      {
        kind: 'Company',
        name: 'Osu Traders Ltd',
        legalName: 'Osu Traders Limited',
        tin: COMPANY_TIN,
        consentSms: 'No',
      },
      ...(extra.tenants ?? []),
    ],
    leases: [
      {
        unit: unitA,
        tenantPhone: PHONE_KOFI,
        startDate: start,
        endDate: leaseEnd(start),
        monthlyRent: '1500',
        cycle: 'Monthly',
        deposit: '3000',
        noticeDays: '90',
        signedOn: plusDays(start, -10),
      },
      {
        unit: unitB,
        tenantName: 'Osu Traders Ltd',
        tenantTin: COMPANY_TIN,
        startDate: start,
        endDate: leaseEnd(start),
        monthlyRent: '2000',
        cycle: 'Monthly',
        use: 'Commercial',
        noticeDays: '30',
        signedOn: plusDays(start, -3),
      },
      ...(extra.leases ?? []),
    ],
  });
};

describe('PR-08 register Owners sheet (M11 decision 2, step 1)', () => {
  it('offers the register template with an Owners sheet first for onboarding', async () => {
    const sheets = await readXlsxFile(await o.onboarding.registerTemplate(agency.admin));
    expect(sheets.map((x) => x.sheet)).toEqual(['Owners', 'Properties', 'Units', 'Lists']);
    expect(sheets[0]!.data[0]).toEqual(OWNER_COLUMNS.map((c) => c.header));
    // The register import's own template is unchanged.
    const plain = await readXlsxFile(await o.registerImports.template(agency.admin));
    expect(plain.map((x) => x.sheet)).toEqual(['Properties', 'Units', 'Lists']);
  });

  it('creates owners before the properties that name them, encrypts their TINs, and changes nothing on re-import', async () => {
    const row = (
      columns: readonly { key: string }[],
      values: Record<string, string | number | null>,
    ) =>
      columns.map((c) =>
        values[c.key] == null ? null : { value: values[c.key] as string | number },
      );
    const header = (columns: readonly { header: string }[]) =>
      columns.map((c) => ({ value: c.header }));
    const file = await writeXlsxFile([
      {
        sheet: 'Owners',
        data: [
          header(OWNER_COLUMNS),
          row(OWNER_COLUMNS, {
            reference: 'OWN-N1',
            kind: 'Individual',
            displayName: 'New Owner',
            phone: '024 000 0190',
            tin: 'C0000000190',
          }),
          row(OWNER_COLUMNS, {
            reference: 'OWN-N2',
            kind: 'Company',
            displayName: 'New Owner Ltd',
          }),
        ],
      },
      {
        sheet: 'Properties',
        data: [
          header(PROPERTY_COLUMNS),
          row(PROPERTY_COLUMNS, {
            code: 'ACC-OWN',
            name: 'Owners house',
            type: 'Compound house',
            use: 'Residential',
            owner: 'OWN-N1',
            region: 'Greater Accra',
          }),
        ],
      },
      {
        sheet: 'Units',
        data: [
          header(UNIT_COLUMNS),
          row(UNIT_COLUMNS, {
            property: 'ACC-OWN',
            block: 'B1',
            label: 1,
            type: 'Single room',
            availability: 'Available',
          }),
        ],
      },
    ]).toBuffer();
    const run = async () => {
      const { importId, upload } = await o.registerImports.createUpload(agency.admin, {
        sizeBytes: file.length,
        fileName: 'register.xlsx',
      });
      await ctx.storage.put({
        bucket: ctx.config.S3_BUCKET_FILES,
        key: upload.fields.key!,
        body: file,
        contentType: XLSX_CONTENT_TYPE,
      });
      await o.registerImports.startValidation(agency.admin, importId);
      await o.registerImports.validate(agency.companyId, importId);
      const checked = await o.registerImports.get(agency.admin, importId);
      expect(checked.report?.issueCount, JSON.stringify(checked.report?.issues)).toBe(0);
      await o.registerImports.startCommit(agency.admin, importId);
      await o.registerImports.commit(agency.companyId, importId);
      return { checked, done: await o.registerImports.get(agency.admin, importId) };
    };
    const first = await run();
    expect(first.checked.report!.counts.owners).toEqual({ create: 2, update: 0, unchanged: 0 });
    expect(first.done.status).toBe('committed');
    const owners = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{
          reference: string;
          tin_masked: string | null;
          tin_encrypted: string | null;
          owner_ref: string | null;
        }>(
          sql`select o.reference, o.tin_masked, o.tin_encrypted::text as tin_encrypted,
              (select o2.reference from property p join property_current_ownership c on c.company_id = p.company_id and c.property_id = p.id
                 join owner o2 on o2.company_id = c.company_id and o2.id = c.owner_id where p.code = 'ACC-OWN') as owner_ref
            from owner o where o.reference in ('OWN-N1', 'OWN-N2') order by o.reference`,
        ),
    );
    expect(owners.rows.map((r) => r.reference)).toEqual(['OWN-N1', 'OWN-N2']);
    expect(owners.rows[0]!.tin_masked).toBe('*******0190');
    expect(owners.rows[0]!.tin_encrypted).not.toContain('C0000000190');
    expect(owners.rows[0]!.owner_ref).toBe('OWN-N1');
    const again = await run();
    expect(again.checked.report!.counts.owners).toEqual({ create: 0, update: 0, unchanged: 2 });
    expect(again.checked.report!.counts.properties).toEqual({ create: 0, update: 0, unchanged: 1 });
  });

  it('reports no owner counts for a file without an Owners sheet', async () => {
    const file = await writeXlsxFile([
      {
        sheet: 'Properties',
        data: [
          PROPERTY_COLUMNS.map((c) => ({ value: c.header })),
          [
            { value: 'ACC-NOO' },
            { value: 'No owners sheet' },
            { value: 'Compound house' },
            { value: 'Residential' },
            { value: 'OWN-T1' },
            null,
            { value: 'Greater Accra' },
          ],
        ],
      },
    ]).toBuffer();
    const { importId, upload } = await o.registerImports.createUpload(agency.admin, {
      sizeBytes: file.length,
    });
    await ctx.storage.put({
      bucket: ctx.config.S3_BUCKET_FILES,
      key: upload.fields.key!,
      body: file,
      contentType: XLSX_CONTENT_TYPE,
    });
    await o.registerImports.startValidation(agency.admin, importId);
    await o.registerImports.validate(agency.companyId, importId);
    const checked = await o.registerImports.get(agency.admin, importId);
    expect(checked.report!.issueCount).toBe(0);
    expect(checked.report!.counts.owners).toBeUndefined();
  });
});

describe('TL-01 onboarding tenancies (M11 decision 2, step 2)', () => {
  it('needs the cut-over, and the register’s units first: 409 STEP_ORDER', async () => {
    const empty = await moneyCompany(ctx, s, 'landlord', 'Onboarding Empty Landlord');
    const batchId = await uploadBatch(
      ctx,
      o,
      empty.admin,
      'tenancies',
      await tenancies('ACC-X-B1-01', 'ACC-X-B1-02'),
    );
    await expect(o.onboarding.startValidation(empty.admin, batchId)).rejects.toMatchObject({
      code: 'cut_over_missing',
    });
    await o.onboarding.setCutOver(empty.admin, cutOver);
    await expect(o.onboarding.startValidation(empty.admin, batchId)).rejects.toMatchObject({
      code: 'step_order',
    });
    await expect(o.onboarding.setCutOver(empty.admin, plusDays(today, 1))).rejects.toMatchObject({
      code: 'cut_over_future',
    });
  });

  it('lists every problem by sheet, row and column, and writes nothing', async () => {
    await o.onboarding.setCutOver(agency.admin, cutOver);
    const before = await countOf(ctx, agency.companyId, 'tenant');
    const file = await onboardingWorkbook('tenancies', {
      tenants: [
        { kind: 'Individual', name: 'No Phone' },
        { kind: 'Individual', name: 'Has Tin', phone: '024 000 0103', tin: 'C0000000103' },
        {
          kind: 'Company',
          name: 'Id Company',
          tin: 'C0000000104',
          idType: 'Ghana Card',
          idNumber: 'GHA-000000104-1',
        },
        { kind: 'Individual', name: 'Valid Person', phone: '024 000 0105' },
      ],
      leases: [
        {
          unit: 'ACC-NONE-B1-01',
          tenantPhone: '024 000 0103',
          startDate: leaseStart(),
          endDate: leaseEnd(leaseStart()),
          monthlyRent: '1000',
          cycle: 'Monthly',
          noticeDays: '30',
          signedOn: leaseStart(),
        },
        {
          unit: units[5]!,
          tenantPhone: '024 000 0199',
          startDate: leaseStart(),
          endDate: leaseEnd(leaseStart()),
          monthlyRent: '1000',
          cycle: 'Monthly',
          noticeDays: '30',
          signedOn: leaseStart(),
        },
        {
          unit: units[5]!,
          tenantPhone: '024 000 0105',
          startDate: '2020-01-01',
          endDate: '2020-12-31',
          monthlyRent: '1000',
          cycle: 'Monthly',
          noticeDays: '30',
          signedOn: '2019-12-01',
        },
      ],
    });
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'tenancies', file),
    );
    expect(batch.status).toBe('invalid');
    const at = (sheet: string, row: number) =>
      batch.report!.issues.filter((i) => i.sheet === sheet && i.row === row).map((i) => i.column);
    expect(at('Tenants', 2)).toContain('Phone');
    expect(at('Tenants', 3)).toContain('TIN');
    expect(at('Tenants', 4)).toContain('ID number');
    expect(at('Leases', 2)).toContain('Unit');
    expect(at('Leases', 3)).toContain('Tenant phone');
    expect(at('Leases', 4)).toContain('End date');
    // Nothing in a report repeats a cell's value.
    expect(JSON.stringify(batch.report)).not.toContain('0000000103');
    expect(await countOf(ctx, agency.companyId, 'tenant')).toBe(before);
    await expect(o.onboarding.commit(agency.admin, batch.id)).rejects.toMatchObject({
      code: 'not_validated',
    });
  });

  it('imports tenants and paper leases with their consent, scans to follow, and never messages a tenant', async () => {
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'tenancies', await tenancies(units[0]!, units[1]!)),
    );
    expect(batch.report!.issues).toEqual([]);
    expect(batch.report!.counts).toEqual({
      Tenants: { create: 2, update: 0, unchanged: 0 },
      Leases: { create: 2, update: 0, unchanged: 0 },
    });
    const done = await committed(ctx, o, agency.admin, batch.id);
    expect(done.status).toBe('committed');
    const leases = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{
          status: string;
          signing_method: string;
          signed_document_id: string | null;
          imported_batch_id: string;
          billing_start_date: string;
          start_date: string;
        }>(
          sql`select status, signing_method, signed_document_id, imported_batch_id, billing_start_date::text, start_date::text
            from lease where imported_batch_id is not null order by monthly_rent_minor`,
        ),
    );
    expect(leases.rows).toHaveLength(2);
    for (const l of leases.rows) {
      expect(l).toMatchObject({
        status: 'active',
        signing_method: 'paper',
        signed_document_id: null,
        imported_batch_id: batch.id,
      });
      // Billing starts at the first rent period on or after the cut-over.
      expect(l.billing_start_date >= cutOver).toBe(true);
      expect(l.billing_start_date < plusDays(cutOver, 32)).toBe(true);
    }
    const tenant = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      async (tx) =>
        (
          await tx
            .select()
            .from(schema.tenant)
            .where(sql`${schema.tenant.phone} = ${PHONE_KOFI_E164}`)
        )[0]!,
    );
    expect(tenant.idNumberMasked).toBe('GHA-*******01-1');
    expect(String(tenant.idNumberEncrypted)).not.toContain('000000101');
    const consent = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ channel: string; action: string; source: string }>(
          sql`select channel, action, source from consent_event where tenant_id = ${tenant.id} order by channel`,
        ),
    );
    // Yes grants, No records nothing new for a tenant with no consent (nothing to withdraw).
    expect(consent.rows).toEqual([
      { channel: 'sms', action: 'grant', source: 'import' },
      { channel: 'whatsapp', action: 'grant', source: 'import' },
    ]);
    const state = await o.onboarding.state(agency.admin);
    expect(state.leasesMissingScan).toBe(2);
    expect(state.steps.find((x) => x.step === 'tenancies')).toMatchObject({
      status: 'done',
      lastBatchId: batch.id,
    });

    // Billing's reaction to the signings issues what is due and sends nothing; nor do the reminders.
    await runLeaseEvents(ctx, b, agency.companyId);
    expect(await countOf(ctx, agency.companyId, 'message', `recipient_type = 'tenant'`)).toBe(0);
    expect((await outboxOf(ctx, agency.companyId, 'messaging.send')).length).toBe(0);
    // The daily reminders, run late for every day back to before the cut-over and for today: a step
    // dated before the import day is recorded as skipped, never sent (no catch-up); only a step
    // that falls due from today on may go, as for any lease.
    const reminders = new RemindersService(ctx.database, b.engine, {
      error: () => undefined,
    } as never);
    for (let day = 20; day >= 1; day -= 1)
      await reminders.run(agency.companyId, plusDays(today, -day));
    await reminders.run(agency.companyId, today);
    expect(
      await countOf(
        ctx,
        agency.companyId,
        'reminder_sent',
        `status = 'sent' and step_date < '${today}'`,
      ),
    ).toBe(0);
    expect(
      await countOf(ctx, agency.companyId, 'reminder_sent', `status = 'skipped'`),
    ).toBeGreaterThan(0);
    const toTenants = await countOf(
      ctx,
      agency.companyId,
      'outbox_event',
      `type = 'messaging.send' and payload -> 'recipient' ->> 'type' = 'tenant'`,
    );
    expect(toTenants).toBe(
      await countOf(ctx, agency.companyId, 'reminder_sent', `status = 'sent'`),
    );
  });

  it('changes nothing when the same file is imported again', async () => {
    const tenantsBefore = await countOf(ctx, agency.companyId, 'tenant');
    const leasesBefore = await countOf(ctx, agency.companyId, 'lease');
    const consentBefore = await countOf(ctx, agency.companyId, 'consent_event');
    const batch = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'tenancies', await tenancies(units[0]!, units[1]!)),
    );
    expect(batch.report!.issues).toEqual([]);
    expect(batch.report!.counts).toEqual({
      Tenants: { create: 0, update: 0, unchanged: 2 },
      Leases: { create: 0, update: 0, unchanged: 2 },
    });
    expect((await committed(ctx, o, agency.admin, batch.id)).status).toBe('committed');
    expect(await countOf(ctx, agency.companyId, 'tenant')).toBe(tenantsBefore);
    expect(await countOf(ctx, agency.companyId, 'lease')).toBe(leasesBefore);
    expect(await countOf(ctx, agency.companyId, 'consent_event')).toBe(consentBefore);
  });

  it('refuses a second lease on a unit that has one, and a changed lease', async () => {
    const start = leaseStart();
    const file = await tenancies(units[0]!, units[1]!, {
      tenants: [{ kind: 'Individual', name: 'Ama Mensah', phone: PHONE_AMA }],
      leases: [
        {
          unit: units[0]!,
          tenantPhone: PHONE_AMA,
          startDate: plusDays(start, 31),
          endDate: leaseEnd(start),
          monthlyRent: '1500',
          cycle: 'Monthly',
          noticeDays: '30',
          signedOn: start,
        },
      ],
    });
    const changed = await onboardingWorkbook('tenancies', {
      leases: [
        {
          unit: units[1]!,
          tenantName: 'Osu Traders Ltd',
          tenantTin: COMPANY_TIN,
          startDate: start,
          endDate: leaseEnd(start),
          monthlyRent: '2500',
          cycle: 'Monthly',
          use: 'Commercial',
          noticeDays: '30',
          signedOn: plusDays(start, -3),
        },
      ],
    });
    const second = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'tenancies', file),
    );
    expect(second.status).toBe('invalid');
    expect(second.report!.issues.find((i) => i.sheet === 'Leases' && i.row === 4)).toMatchObject({
      column: 'Start date',
    });
    const other = await validated(
      ctx,
      o,
      agency.admin,
      await uploadBatch(ctx, o, agency.admin, 'tenancies', changed),
    );
    expect(other.report!.issues.find((i) => i.sheet === 'Leases' && i.row === 2)).toMatchObject({
      column: 'Monthly rent',
    });
  });

  it('fixes the cut-over once tenancies are imported', async () => {
    await expect(
      o.onboarding.setCutOver(agency.admin, plusDays(cutOver, -1)),
    ).rejects.toMatchObject({ code: 'cut_over_fixed' });
    // Setting it to what it is changes nothing and is allowed.
    expect((await o.onboarding.setCutOver(agency.admin, cutOver)).cutOverDate).toBe(cutOver);
  });
});

describe('TL-06 imported paper leases: the scan follows', () => {
  it('lists imported leases without a scan, and attaches each scan once', async () => {
    const missing = await o.onboarding.leasesMissingScan(agency.admin);
    expect(missing).toHaveLength(2);
    const leaseId = missing[0]!.leaseId;
    const upload = await uploadLeaseFile(ctx, s, agency.admin);
    const attached = await o.onboarding.attachScan(agency.admin, leaseId, upload);
    expect(attached.leaseId).toBe(leaseId);
    const again = await uploadLeaseFile(ctx, s, agency.admin);
    await expect(o.onboarding.attachScan(agency.admin, leaseId, again)).rejects.toMatchObject({
      code: 'scan_present',
    });
    expect(await o.onboarding.leasesMissingScan(agency.admin)).toHaveLength(1);
    // The database allows the scan once, for an imported lease only (RA122).
    await expect(
      withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
        tx.execute(sql`update lease set signed_document_id = null where id = ${leaseId}`),
      ),
    ).rejects.toThrow();
  });
});

describe('AD-02 onboarding is for people who see the whole company', () => {
  it('refuses a scoped manager and a caretaker', async () => {
    const scoped = await staffIn(
      ctx,
      agency.companyId,
      'agency',
      'property_manager',
      'Scoped manager',
      { owners: [ownerId] },
    );
    const caretaker = await staffIn(ctx, agency.companyId, 'agency', 'caretaker', 'Caretaker');
    for (const who of [scoped, caretaker]) {
      await expect(o.onboarding.state(who)).rejects.toMatchObject({ status: 403 });
      await expect(o.onboarding.template(who, 'tenancies')).rejects.toMatchObject({ status: 403 });
      await expect(o.onboarding.leasesMissingScan(who)).rejects.toMatchObject({ status: 403 });
    }
    // An unscoped manager imports.
    expect((await o.onboarding.state(agency.manager)).cutOverDate).toBe(cutOver);
  });
});

describe('NFR-SEC onboarding cross-company isolation', () => {
  it('never shows another company’s batches, and never finds its units or tenants', async () => {
    const other = await moneyCompany(ctx, s, 'agency', 'Onboarding Other Agency');
    const otherOwner = (
      await s.owners.create(other.admin, { kind: 'individual', displayName: 'Other owner' })
    ).id;
    await propertyWithUnits(s, other.manager, {
      areaCode: 'KUM',
      propertyPart: 'OTH',
      ownerId: otherOwner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    await o.onboarding.setCutOver(other.admin, cutOver);
    const mine = (await o.onboarding.batches(agency.admin, 'tenancies'))[0]!;
    await expect(o.onboarding.batch(other.admin, mine.id)).rejects.toMatchObject({ status: 404 });
    expect(await o.onboarding.batches(other.admin)).toEqual([]);
    // The first company's unit and tenant are unknown here.
    const start = leaseStart();
    const batch = await validated(
      ctx,
      o,
      other.admin,
      await uploadBatch(
        ctx,
        o,
        other.admin,
        'tenancies',
        await onboardingWorkbook('tenancies', {
          leases: [
            {
              unit: units[2]!,
              tenantPhone: PHONE_KOFI,
              startDate: start,
              endDate: leaseEnd(start),
              monthlyRent: '1000',
              cycle: 'Monthly',
              noticeDays: '30',
              signedOn: start,
            },
          ],
        }),
      ),
    );
    expect(batch.report!.issues.map((i) => i.column)).toEqual(['Unit']);
    expect(await o.onboarding.leasesMissingScan(other.admin)).toEqual([]);
    const row = await batchRecord(ctx, agency.companyId, mine.id);
    expect(row.companyId).toBe(agency.companyId);
  });
});
