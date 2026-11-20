import { schema, sql, type Tx } from '@rent/db';
import { firstPeriodStartOnOrAfter } from '@rent/domain/billing';
import { compareDates, parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import {
  checkLeaseRows,
  checkTenantRows,
  leaseImportDifferences,
  ONBOARDING_SHEETS,
  tenantFieldsAfterImport,
  tenantPhoneKey,
  type LeaseImportRow,
  type OnboardingSheetKey,
  type OnboardingSheetRows,
  type TenantImportFields,
  type TenantImportRow,
} from '@rent/domain/onboarding';
import type { ImportIssue } from '@rent/domain/portfolio';
import { checkLeaseTerms, type LeaseUse, type RentCycle } from '@rent/domain/tenancy';
import type { LeasesService } from '../tenancy/leases.service';
import type { TenantsService } from '../tenancy/tenants.service';
import type { SheetCounts } from './records';

/**
 * Step 2 of onboarding, the Tenants and Leases sheets (M11 decision 2; plan 4.1; TL-01, TL-06,
 * CM-09), against the company's records: tenants matched by phone (E.164) within the company, or a
 * company tenant by name and TIN (its keyed hash, never the TIN); leases by unit and start date,
 * recorded as paper leases whose scan may follow. A unit with an active lease refuses a second. A
 * re-import of the same file finds every row and changes nothing. The whole company is read: the
 * policy lets only people who see it import (`onboarding.import`).
 */

/** Lease states that hold a unit (PB-09): a second lease over the same days is refused. */
const HOLDING = ['pending_signatures', 'signed', 'active', 'ending', 'holding_over'] as const;

interface RecordedTenant {
  readonly id: string;
  readonly kind: string;
  readonly fields: TenantImportFields;
  readonly tinIndex: string | null;
  readonly idIndex: string | null;
}

interface RecordedLease {
  readonly id: string;
  readonly unitCode: string;
  readonly tenantId: string;
  readonly status: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly monthlyRentMinor: number;
  readonly cycle: RentCycle;
  readonly depositMinor: number | null;
  readonly serviceChargeMonthlyMinor: number | null;
  readonly use: LeaseUse;
  readonly noticeDays: number;
  readonly signedOn: string | null;
}

/** Who a lease to create belongs to: a tenant row of this file, or a tenant already recorded. */
type LeaseTenant = { readonly row: number } | { readonly id: string };

export interface TenancyPlan {
  readonly tenantsToCreate: TenantImportRow[];
  readonly tenantsToUpdate: { readonly id: string; readonly row: TenantImportRow }[];
  readonly tenantsUnchanged: number;
  readonly leasesToCreate: {
    readonly row: LeaseImportRow;
    readonly unitId: string;
    readonly tenant: LeaseTenant;
    readonly billingStartDate: string;
    readonly use: LeaseUse;
  }[];
  readonly leasesUnchanged: number;
}

export interface TenancyCheck {
  readonly plan: TenancyPlan;
  readonly issues: ImportIssue[];
  readonly counts: Record<string, SheetCounts>;
}

const T = ONBOARDING_SHEETS.tenants;
const L = ONBOARDING_SHEETS.leases;

const before = (a: string, b: string) =>
  compareDates(parseBusinessDate(a), parseBusinessDate(b)) < 0;

const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Checks the Tenants and Leases sheets against the records; writes nothing. */
export async function checkTenancies(
  tx: Tx,
  deps: { readonly tenants: TenantsService; readonly leases: LeasesService },
  input: {
    readonly companyId: string;
    readonly sheets: Partial<Record<OnboardingSheetKey, OnboardingSheetRows>>;
    readonly cutOver: string;
    readonly today: string;
  },
): Promise<TenancyCheck> {
  const { companyId } = input;
  const issues: ImportIssue[] = [];
  const issue = (sheet: string, row: number, column: string | null, message: string) =>
    issues.push({ sheet, row, column, message });
  const tenantRows = checkTenantRows(input.sheets.tenants ?? []);
  const leaseRows = checkLeaseRows(input.sheets.leases ?? [], {
    today: input.today,
    tenants: tenantRows.rows,
  });
  issues.push(...tenantRows.issues, ...leaseRows.issues);

  // The tenants recorded, by phone and by a company's name and TIN.
  const recorded = (
    await tx
      .select()
      .from(schema.tenant)
      .where(sql`${schema.tenant.archivedAt} is null`)
  ).map((t): RecordedTenant => ({
    id: t.id,
    kind: t.kind,
    fields: {
      displayName: t.displayName,
      legalName: t.legalName,
      phone: t.phone,
      whatsappPhone: t.whatsappPhone,
      email: t.email,
      occupation: t.occupation,
      businessType: t.businessType,
      registrationNumber: t.registrationNumber,
    },
    tinIndex: t.tinIndex,
    idIndex: t.idNumberIndex,
  }));
  const byPhone = new Map<string, RecordedTenant[]>();
  const byCompany = new Map<string, RecordedTenant>();
  for (const t of recorded) {
    if (t.fields.phone) byPhone.set(t.fields.phone, [...(byPhone.get(t.fields.phone) ?? []), t]);
    if (t.kind === 'company' && t.tinIndex)
      byCompany.set(`${nameKey(t.fields.displayName)}|${t.tinIndex}`, t);
  }
  const tinIndex = (tin: string) => deps.tenants.tinIndexFor(companyId, tin);
  /** The recorded tenant a key names, or `ambiguous` when several share its phone. */
  const findByKey = (
    key: string,
    phone: string | null,
    company: { name: string; tin: string } | null,
  ): RecordedTenant | 'ambiguous' | null => {
    if (phone && key === tenantPhoneKey(phone)) {
      const found = byPhone.get(phone) ?? [];
      return found.length > 1 ? 'ambiguous' : (found[0] ?? null);
    }
    if (company) return byCompany.get(`${nameKey(company.name)}|${tinIndex(company.tin)}`) ?? null;
    return null;
  };

  const consent = await deps.tenants.importConsent(
    tx,
    recorded.map((t) => t.id),
  );
  const plan = {
    tenantsToCreate: [] as TenantImportRow[],
    tenantsToUpdate: [] as { id: string; row: TenantImportRow }[],
    tenantsUnchanged: 0,
    leasesToCreate: [] as TenancyPlan['leasesToCreate'][number][],
    leasesUnchanged: 0,
  };
  /** Tenant rows that will exist after the commit, by every key that names them. */
  const fileTenants = new Map<string, number>();
  /** Recorded tenants the file's rows matched, by row. */
  const matchedRow = new Map<number, string>();
  for (const row of tenantRows.rows) {
    const company =
      row.kind === 'company' && row.tin ? { name: row.displayName, tin: row.tin } : null;
    let match: RecordedTenant | 'ambiguous' | null = null;
    for (const key of row.keys) {
      const found = findByKey(key, row.phone, key.startsWith('tenant:company:') ? company : null);
      if (found === 'ambiguous') {
        match = 'ambiguous';
        break;
      }
      if (found && match && match !== found) {
        issue(T, row.row, 'TIN', 'The phone and the name and TIN belong to different tenants');
        match = 'ambiguous';
        break;
      }
      if (found) match = found;
    }
    if (match === 'ambiguous') {
      if (!issues.some((i) => i.sheet === T && i.row === row.row))
        issue(T, row.row, 'Phone', 'More than one tenant has this phone; record the lease by hand');
      continue;
    }
    let problem = false;
    if (row.kind === 'individual' && row.tin) {
      issue(T, row.row, 'TIN', 'A TIN is for company tenants; an individual’s is their Ghana Card');
      problem = true;
    }
    if (row.kind === 'company' && row.identity) {
      issue(T, row.row, 'ID number', 'ID numbers are for individual tenants');
      problem = true;
    }
    if (match && match.kind !== row.kind) {
      issue(
        T,
        row.row,
        'Kind',
        `This tenant is recorded as ${match.kind === 'company' ? 'a company' : 'an individual'}`,
      );
      problem = true;
    }
    if (problem) continue;
    for (const key of row.keys) fileTenants.set(key, row.row);
    if (!match) {
      plan.tenantsToCreate.push(row);
      continue;
    }
    matchedRow.set(row.row, match.id);
    const next = tenantFieldsAfterImport(match.fields, row);
    const fieldsChanged = (Object.keys(next) as (keyof TenantImportFields)[]).some(
      (k) => (next[k] ?? null) !== (match.fields[k] ?? null),
    );
    const tinChanged = row.tin !== null && match.tinIndex !== tinIndex(row.tin);
    const idChanged =
      row.identity !== null &&
      match.idIndex !==
        deps.tenants.idIndexFor(
          companyId,
          row.identity.type,
          row.identity.number,
          row.identity.country,
        );
    const now = consent.get(match.id) ?? { whatsapp: false, sms: false, email: false };
    // An import only grants (CM-09: `sourceAllows('import', …)`): a No never withdraws consent
    // given on record; withdrawing is the tenant's (STOP, the app) or staff's.
    const consentChanged = (['whatsapp', 'sms', 'email'] as const).some(
      (c) => row.consent[c] === true && !now[c],
    );
    if (fieldsChanged || tinChanged || idChanged || consentChanged)
      plan.tenantsToUpdate.push({ id: match.id, row });
    else plan.tenantsUnchanged += 1;
  }

  // Units and their leases.
  const units = new Map(
    (
      await tx
        .select({
          id: schema.unit.id,
          code: schema.unit.code,
          archivedAt: schema.unit.archivedAt,
          availability: schema.unit.availability,
          billingBand: schema.unit.billingBand,
        })
        .from(schema.unit)
    ).map((u) => [u.code, u]),
  );
  const leases = (
    await tx.execute<{
      id: string;
      unit_code: string;
      tenant_id: string;
      status: string;
      start_date: string;
      end_date: string;
      monthly_rent_minor: number;
      rent_cycle: RentCycle;
      deposit_minor: number | null;
      service_charge: number | null;
      use: LeaseUse;
      notice_days: number;
      signed_on: string | null;
    }>(
      sql`select l.id, u.code as unit_code, l.tenant_id, l.status, l.start_date::text as start_date,
            l.end_date::text as end_date, l.monthly_rent_minor, l.rent_cycle, l.deposit_minor,
            (select c.monthly_amount_minor from lease_charge c where c.company_id = l.company_id
               and c.lease_id = l.id and c.charge_type = 'service_charge' limit 1) as service_charge,
            l.use, l.notice_days,
            (select min(p.paper_signed_on)::text from lease_party p
               where p.company_id = l.company_id and p.lease_id = l.id) as signed_on
          from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
          where l.status <> 'cancelled'`,
    )
  ).rows.map((r): RecordedLease => ({
    id: r.id,
    unitCode: r.unit_code,
    tenantId: r.tenant_id,
    status: r.status,
    startDate: r.start_date,
    endDate: r.end_date,
    monthlyRentMinor: Number(r.monthly_rent_minor),
    cycle: r.rent_cycle,
    depositMinor: r.deposit_minor === null ? null : Number(r.deposit_minor),
    serviceChargeMonthlyMinor: r.service_charge === null ? null : Number(r.service_charge),
    use: r.use,
    noticeDays: r.notice_days,
    signedOn: r.signed_on,
  }));
  const leasesOf = new Map<string, RecordedLease[]>();
  for (const l of leases) leasesOf.set(l.unitCode, [...(leasesOf.get(l.unitCode) ?? []), l]);

  for (const row of leaseRows.rows) {
    const unit = units.get(row.unitCode);
    if (!unit) {
      issue(L, row.row, 'Unit', `No unit has the code ${row.unitCode}; import the register first`);
      continue;
    }
    if (unit.archivedAt) {
      issue(L, row.row, 'Unit', `Unit ${row.unitCode} is archived`);
      continue;
    }
    // The tenant: on the Tenants sheet of this file, or recorded already.
    let tenant: LeaseTenant;
    let tenantId: string | null;
    const fileRow = fileTenants.get(row.tenantKey);
    if (fileRow !== undefined) {
      tenantId = matchedRow.get(fileRow) ?? null;
      tenant = tenantId ? { id: tenantId } : { row: fileRow };
    } else if (row.tenantRow !== null) {
      issue(
        L,
        row.row,
        'Tenant phone',
        `The tenant on row ${row.tenantRow} of the Tenants sheet has problems`,
      );
      continue;
    } else {
      const found = findByKey(
        row.tenantKey,
        row.tenant.by === 'phone' ? row.tenant.phone : null,
        row.tenant.by === 'name_and_tin' ? { name: row.tenant.name, tin: row.tenant.tin } : null,
      );
      if (found === 'ambiguous') {
        issue(L, row.row, 'Tenant phone', 'More than one tenant has this phone');
        continue;
      }
      if (!found) {
        issue(
          L,
          row.row,
          row.tenant.by === 'phone' ? 'Tenant phone' : 'Tenant TIN',
          'No tenant like this is on the Tenants sheet or recorded',
        );
        continue;
      }
      tenantId = found.id;
      tenant = { id: found.id };
    }
    const onUnit = leasesOf.get(row.unitCode) ?? [];
    const existing = onUnit.find((l) => l.startDate === row.startDate && l.status !== 'draft');
    if (existing) {
      const differs = leaseImportDifferences(
        {
          endDate: existing.endDate,
          monthlyRentMinor: existing.monthlyRentMinor,
          cycle: existing.cycle,
          depositMinor: existing.depositMinor,
          serviceChargeMonthlyMinor: existing.serviceChargeMonthlyMinor,
          use: existing.use,
          noticeDays: existing.noticeDays,
          signedOn: existing.signedOn ?? row.signedOn,
        },
        row,
      );
      if (tenantId !== existing.tenantId)
        issue(L, row.row, 'Tenant phone', 'This unit’s lease from this date is another tenant’s');
      else if (differs.length > 0)
        issue(
          L,
          row.row,
          differs[0]!,
          `This lease is recorded with other terms (${differs.join(', ')}); a signed lease is never changed by an import`,
        );
      else plan.leasesUnchanged += 1;
      continue;
    }
    if (unit.availability === 'not_lettable') {
      issue(L, row.row, 'Unit', `Unit ${row.unitCode} is not lettable`);
      continue;
    }
    const overlap = onUnit.find(
      (l) =>
        (HOLDING as readonly string[]).includes(l.status) &&
        !before(row.endDate, l.startDate) &&
        !before(l.endDate, row.startDate),
    );
    if (overlap) {
      issue(
        L,
        row.row,
        'Start date',
        `${row.unitCode} already has a lease from ${overlap.startDate} to ${overlap.endDate}; a unit holds one lease at a time`,
      );
      continue;
    }
    if (before(row.endDate, input.cutOver)) {
      issue(
        L,
        row.row,
        'End date',
        `The lease ended before the cut-over (${input.cutOver}); only current leases are imported`,
      );
      continue;
    }
    const use: LeaseUse =
      row.use ?? (unit.billingBand === 'commercial' ? 'commercial' : 'residential');
    const termsInput = {
      startDate: row.startDate,
      endDate: row.endDate,
      monthlyRentMinor: row.monthlyRentMinor,
      cycle: row.cycle,
      depositMinor: row.depositMinor,
      serviceChargeMonthlyMinor: row.serviceChargeMonthlyMinor,
      noticeDays: row.noticeDays,
      use,
    };
    let billingStartDate: string;
    try {
      billingStartDate = firstPeriodStartOnOrAfter(checkLeaseTerms(termsInput), input.cutOver);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issue(L, row.row, null, error.message);
      continue;
    }
    const refusal = await deps.leases.advanceRefusal(tx, companyId, termsInput);
    if (refusal) {
      issue(L, row.row, 'Rent cycle', refusal);
      continue;
    }
    plan.leasesToCreate.push({ row, unitId: unit.id, tenant, billingStartDate, use });
  }

  return {
    plan,
    issues,
    counts: {
      [T]: {
        create: plan.tenantsToCreate.length,
        update: plan.tenantsToUpdate.length,
        unchanged: plan.tenantsUnchanged,
      },
      [L]: { create: plan.leasesToCreate.length, update: 0, unchanged: plan.leasesUnchanged },
    },
  };
}

/**
 * Writes a checked plan in the commit's transaction: tenants first (created or brought up to
 * date, consent as events of source `import`), then each lease as a paper lease imported by the
 * batch. No message is queued here, and none follows from the lease events (billing only issues
 * what is due); welcome messages are staff's, from broadcasts (decision 2).
 */
export async function applyTenancies(
  tx: Tx,
  deps: { readonly tenants: TenantsService; readonly leases: LeasesService },
  who: { readonly companyId: string; readonly personId: string },
  batchId: string,
  plan: TenancyPlan,
): Promise<{ tenants: number; leases: number }> {
  const idOfRow = new Map<number, string>();
  const inputOf = (row: TenantImportRow, base: TenantImportFields | null) => {
    const fields = base ? tenantFieldsAfterImport(base, row) : null;
    return {
      kind: row.kind,
      displayName: fields?.displayName ?? row.displayName,
      legalName: fields ? fields.legalName : row.legalName,
      phone: fields ? fields.phone : row.phone,
      whatsappPhone: fields ? fields.whatsappPhone : row.whatsappPhone,
      email: fields ? fields.email : row.email,
      occupation: fields ? fields.occupation : row.occupation,
      businessType: fields ? fields.businessType : row.businessType,
      registrationNumber: fields ? fields.registrationNumber : row.registrationNumber,
      tin: row.tin ?? undefined,
      idType: row.identity?.type,
      idNumber: row.identity?.number,
      idCountry: row.identity?.country,
      consent: row.consent,
    };
  };
  for (const row of plan.tenantsToCreate)
    idOfRow.set(row.row, await deps.tenants.importInTx(tx, who, inputOf(row, null), null));
  for (const { id, row } of plan.tenantsToUpdate) {
    const [t] = await tx
      .select()
      .from(schema.tenant)
      .where(sql`${schema.tenant.id} = ${id}`);
    const base: TenantImportFields = {
      displayName: t!.displayName,
      legalName: t!.legalName,
      phone: t!.phone,
      whatsappPhone: t!.whatsappPhone,
      email: t!.email,
      occupation: t!.occupation,
      businessType: t!.businessType,
      registrationNumber: t!.registrationNumber,
    };
    idOfRow.set(row.row, await deps.tenants.importInTx(tx, who, inputOf(row, base), id));
  }
  for (const lease of plan.leasesToCreate) {
    const tenantId = 'id' in lease.tenant ? lease.tenant.id : idOfRow.get(lease.tenant.row);
    if (!tenantId) throw new Error(`No tenant for lease row ${lease.row.row}`);
    const [t] = await tx
      .select({ displayName: schema.tenant.displayName, legalName: schema.tenant.legalName })
      .from(schema.tenant)
      .where(sql`${schema.tenant.id} = ${tenantId}`);
    const r = lease.row;
    await deps.leases.recordImportedInTx(
      tx,
      who,
      {
        unitId: lease.unitId,
        tenantId,
        startDate: r.startDate,
        endDate: r.endDate,
        monthlyRentMinor: r.monthlyRentMinor,
        cycle: r.cycle,
        depositMinor: r.depositMinor,
        serviceChargeMonthlyMinor: r.serviceChargeMonthlyMinor,
        noticeDays: r.noticeDays,
        use: lease.use,
        signedOn: r.signedOn,
        billingStartDate: lease.billingStartDate,
        signerName: (t?.legalName ?? t?.displayName ?? 'Tenant').slice(0, 160),
      },
      batchId,
    );
  }
  return {
    tenants: plan.tenantsToCreate.length + plan.tenantsToUpdate.length,
    leases: plan.leasesToCreate.length,
  };
}
