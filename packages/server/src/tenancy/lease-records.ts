import { and, asc, eq, schema, sql, type Tx } from '@rent/db';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import type { CompanyKind } from '@rent/domain/policy';
import {
  parseCompanySettings,
  tenancySettingsOf,
  type TenancySettings,
} from '@rent/domain/settings';
import {
  checkLeaseTerms,
  type LeaseStatus,
  type LeaseTerms,
  type LeaseUse,
  type RentCycle,
} from '@rent/domain/tenancy';
import type { Clock } from '../core/clock';
import { conflict, notFound } from '../core/errors';
import { isUniqueViolation, sqlStateOf } from '../core/db-errors';

/** Lease rows and the facts around them, shared by the tenancy services. Not exported by the module. */
export type LeaseRow = typeof schema.lease.$inferSelect;

export interface CompanyFacts {
  readonly id: string;
  readonly kind: CompanyKind;
  readonly displayName: string;
  readonly legalName: string;
  readonly senderName: string;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly primaryColour: string;
  readonly accentColour: string;
  readonly settings: TenancySettings;
}

export async function companyFacts(tx: Tx, companyId: string): Promise<CompanyFacts> {
  const [row] = await tx.select().from(schema.company).where(eq(schema.company.id, companyId));
  if (!row) throw notFound('Company');
  return {
    id: row.id,
    kind: row.kind as CompanyKind,
    displayName: row.displayName,
    legalName: row.legalName,
    senderName: row.senderName,
    countryCode: row.countryCode,
    timeZone: row.timeZone,
    primaryColour: row.primaryColour,
    accentColour: row.accentColour,
    settings: tenancySettingsOf(parseCompanySettings(row.settings)),
  };
}

/** Today in the company's time zone (CLAUDE.md section 11). */
export const todayIn = (clock: Clock, timeZone: string): string =>
  toIsoDate(businessDateOf(instantFrom(clock.now()), timeZone));

/** The business date an instant falls on in the company's time zone. */
export const dateIn = (instant: Date, timeZone: string): string =>
  toIsoDate(businessDateOf(instantFrom(instant), timeZone));

export async function leaseRow(
  tx: Tx,
  leaseId: string,
  options: { readonly lock?: boolean } = {},
): Promise<LeaseRow> {
  const query = tx.select().from(schema.lease).where(eq(schema.lease.id, leaseId));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw notFound('Lease');
  return row;
}

/** A lease's terms, checked again by the domain rules (TL-06), with its steps and service charge. */
export async function termsOf(tx: Tx, row: LeaseRow): Promise<LeaseTerms> {
  const steps = await tx
    .select({
      effectiveFrom: schema.rentStep.effectiveFrom,
      monthlyRentMinor: schema.rentStep.monthlyRentMinor,
    })
    .from(schema.rentStep)
    .where(eq(schema.rentStep.leaseId, row.id))
    .orderBy(asc(schema.rentStep.effectiveFrom));
  const [charge] = await tx
    .select({ monthly: schema.leaseCharge.monthlyAmountMinor })
    .from(schema.leaseCharge)
    .where(
      and(
        eq(schema.leaseCharge.leaseId, row.id),
        eq(schema.leaseCharge.chargeType, 'service_charge'),
      ),
    );
  return checkLeaseTerms({
    startDate: row.startDate,
    endDate: row.endDate,
    monthlyRentMinor: row.monthlyRentMinor,
    cycle: row.rentCycle as RentCycle,
    initialAdvanceMonths: row.initialAdvanceMonths,
    depositMinor: row.depositMinor,
    serviceChargeMonthlyMinor: charge?.monthly ?? null,
    steps,
    breakClause: row.breakFromDate
      ? {
          fromDate: row.breakFromDate,
          party: row.breakParty as 'tenant' | 'landlord' | 'either',
          noticeDays: row.breakNoticeDays!,
          creditUnusedDays: row.breakCreditUnusedDays === true,
        }
      : null,
    noticeDays: row.noticeDays,
    use: row.use as LeaseUse,
  });
}

/** Leases in these states hold their unit; no two of them may overlap (PB-09). */
export const HOLDING_STATUSES: readonly LeaseStatus[] = [
  'signed',
  'active',
  'ending',
  'holding_over',
];

/** Refuses, kindly, a lease that would overlap one already holding the unit (the database also does). */
export async function assertNoOverlap(tx: Tx, row: LeaseRow): Promise<void> {
  const clash = await tx.execute<{ id: string }>(
    sql`select id from lease where company_id = ${row.companyId} and unit_id = ${row.unitId}
        and id <> ${row.id} and status in ('signed', 'active', 'ending', 'holding_over')
        and daterange(start_date, end_date, '[]') && daterange(${row.startDate}::date, ${row.endDate}::date, '[]')
        limit 1`,
  );
  if (clash.rows.length > 0)
    throw conflict('lease_overlap', 'Another lease holds this unit for some of these dates');
}

/** Maps the database's refusals of a lease change to clear errors. */
export function leaseWriteError(error: unknown): unknown {
  const state = sqlStateOf(error);
  if (state === '23P01')
    return conflict('lease_overlap', 'Another lease holds this unit for some of these dates');
  if (isUniqueViolation(error, 'lease_one_renewal'))
    return conflict('renewal_exists', 'This lease already has a renewal');
  if (state === 'RA026')
    return conflict('unit_not_lettable', 'The unit is archived or not lettable');
  if (state === 'RA021' || state === 'RA024')
    return conflict('lease_not_draft', 'Only a draft lease can be changed');
  if (state === 'RA022')
    return conflict('lease_transition', 'The lease cannot change like that now');
  return error;
}
