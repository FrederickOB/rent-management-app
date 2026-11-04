import { and, asc, eq, inArray, schema, sql, type Tx } from '@rent/db';
import type { ScheduleRow } from '@rent/domain/billing';
import type { LeaseStatus, LeaseTerms, LeaseUse, RentCycle } from '@rent/domain/tenancy';
import { notFound } from '../core/errors';
import { leaseRow, termsOf } from './lease-records';

/**
 * What billing needs to know about a lease (M4a plan 4.1): tenancy owns leases, tenants and the
 * rent schedule, and billing reads them only through these helpers, in its own transaction.
 */
export interface BillingLease {
  readonly id: string;
  readonly companyId: string;
  readonly propertyId: string;
  readonly unitId: string;
  readonly tenantId: string;
  readonly status: LeaseStatus;
  readonly use: LeaseUse;
  readonly cycle: RentCycle;
  readonly startDate: string;
  readonly endDate: string;
  readonly billingStartDate: string | null;
  readonly initialAdvanceMonths: number | null;
  readonly depositMinor: number | null;
  readonly renewsLeaseId: string | null;
  readonly moveOutDate: string | null;
  readonly endedOn: string | null;
  readonly signingMethod: 'esign' | 'paper' | null;
  readonly terms: LeaseTerms;
  readonly unitCode: string;
  readonly propertyName: string;
  /** The name invoices and receipts are addressed to: a company tenant's registered name. */
  readonly tenantName: string;
  /** Masked (CLAUDE.md section 10): the full TIN is revealed only with a reason, and audited. */
  readonly tenantTinMasked: string | null;
}

export async function billingLeaseOf(tx: Tx, leaseId: string): Promise<BillingLease> {
  const row = await leaseRow(tx, leaseId);
  const [place] = await tx
    .select({ unitCode: schema.unit.code, propertyName: schema.property.name })
    .from(schema.unit)
    .innerJoin(
      schema.property,
      and(
        eq(schema.property.companyId, schema.unit.companyId),
        eq(schema.property.id, schema.unit.propertyId),
      ),
    )
    .where(eq(schema.unit.id, row.unitId));
  const [tenant] = await tx
    .select({
      displayName: schema.tenant.displayName,
      legalName: schema.tenant.legalName,
      tinMasked: schema.tenant.tinMasked,
    })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, row.tenantId));
  if (!place || !tenant) throw notFound('Lease');
  return {
    id: row.id,
    companyId: row.companyId,
    propertyId: row.propertyId,
    unitId: row.unitId,
    tenantId: row.tenantId,
    status: row.status as LeaseStatus,
    use: row.use as LeaseUse,
    cycle: row.rentCycle as RentCycle,
    startDate: row.startDate,
    endDate: row.endDate,
    billingStartDate: row.billingStartDate,
    initialAdvanceMonths: row.initialAdvanceMonths,
    depositMinor: row.depositMinor,
    renewsLeaseId: row.renewsLeaseId,
    moveOutDate: row.moveOutDate,
    endedOn: row.endedOn,
    signingMethod: row.signingMethod as BillingLease['signingMethod'],
    terms: await termsOf(tx, row),
    unitCode: place.unitCode,
    propertyName: place.propertyName,
    tenantName: tenant.legalName ?? tenant.displayName,
    tenantTinMasked: tenant.tinMasked,
  };
}

/** The lease's rent schedule (TL-06), in sequence order: what billing invoices. */
export async function scheduleRowsOf(tx: Tx, leaseId: string): Promise<ScheduleRow[]> {
  const rows = await tx
    .select()
    .from(schema.chargePeriod)
    .where(eq(schema.chargePeriod.leaseId, leaseId))
    .orderBy(asc(schema.chargePeriod.periodStart), asc(schema.chargePeriod.chargeType));
  return rows.map((r) => ({
    id: r.id,
    sequence: r.sequence,
    chargeType: r.chargeType as ScheduleRow['chargeType'],
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    amountMinor: r.amountMinor,
    source: r.source as ScheduleRow['source'],
  }));
}

/** The company's leases in these states, oldest first: the daily billing jobs' work list. */
export async function leaseIdsIn(tx: Tx, statuses: readonly LeaseStatus[]): Promise<string[]> {
  const rows = await tx
    .select({ id: schema.lease.id })
    .from(schema.lease)
    .where(inArray(schema.lease.status, [...statuses]))
    .orderBy(asc(schema.lease.startDate), asc(schema.lease.id));
  return rows.map((r) => r.id);
}

/** Leases that renew `leaseId` and have started: the renewal a carry-over moves balances to. */
export async function startedRenewalOf(tx: Tx, leaseId: string): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(
    sql`select id from lease where renews_lease_id = ${leaseId}
        and status in ('active', 'ending', 'holding_over', 'ended', 'terminated') limit 1`,
  );
  return rows.rows[0]?.id ?? null;
}

/** Display labels for leases, for lists of money: tenant, unit and property. */
export interface LeaseLabel {
  readonly leaseId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly propertyId: string;
  readonly propertyName: string;
}

export async function leaseLabels(
  tx: Tx,
  leaseIds: readonly string[],
): Promise<Map<string, LeaseLabel>> {
  if (leaseIds.length === 0) return new Map();
  const rows = await tx.execute<{
    lease_id: string;
    tenant_id: string;
    tenant_name: string;
    unit_id: string;
    unit_code: string;
    property_id: string;
    property_name: string;
  }>(
    sql`select l.id as lease_id, t.id as tenant_id, coalesce(t.legal_name, t.display_name) as tenant_name,
          u.id as unit_id, u.code as unit_code, p.id as property_id, p.name as property_name
        from lease l
        join tenant t on t.company_id = l.company_id and t.id = l.tenant_id
        join unit u on u.company_id = l.company_id and u.id = l.unit_id
        join property p on p.company_id = l.company_id and p.id = l.property_id
        where l.id = any(${`{${[...new Set(leaseIds)].join(',')}}`}::uuid[])`,
  );
  return new Map(
    rows.rows.map((r) => [
      r.lease_id,
      {
        leaseId: r.lease_id,
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        unitId: r.unit_id,
        unitCode: r.unit_code,
        propertyId: r.property_id,
        propertyName: r.property_name,
      },
    ]),
  );
}

/** The lease a lease renews, if it is a renewal (TL-09). */
export async function renewedLeaseOf(tx: Tx, leaseId: string): Promise<string | null> {
  const [row] = await tx
    .select({ renews: schema.lease.renewsLeaseId })
    .from(schema.lease)
    .where(eq(schema.lease.id, leaseId));
  return row?.renews ?? null;
}

/** Renewals that have started by a date: billing carries their old lease's balances over (P29). */
export async function startedRenewalIds(tx: Tx, date: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`select id from lease where renews_lease_id is not null and start_date <= ${date}::date
        and status in ('active', 'ending', 'holding_over') order by id`,
  );
  return rows.rows.map((r) => r.id);
}
