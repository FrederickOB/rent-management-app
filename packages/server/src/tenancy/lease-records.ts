import { and, asc, eq, schema, sql, type Tx } from '@rent/db';
import { businessDateOf, formatBusinessDate, instantFrom, toIsoDate } from '@rent/domain/dates';
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
import type { SignerRole } from '@rent/domain/esign';
import { companyRecord } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import { isUniqueViolation, sqlStateOf } from '../core/db-errors';
import { activeMemberIds } from '../identity/memberships';

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
  const row = await companyRecord(tx, companyId);
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

/**
 * Leases in these states hold their unit; no two of them may overlap (PB-09). A lease out for
 * signature holds it too, so a completed signing never finds the unit taken (review finding 2).
 */
export const HOLDING_STATUSES: readonly LeaseStatus[] = [
  'pending_signatures',
  'signed',
  'active',
  'ending',
  'holding_over',
];

const statusList = (statuses: readonly LeaseStatus[]) =>
  sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );

/**
 * Serialises, per unit, the transactions that change what holds or charges it (review finding 3).
 * Called before any lease row is locked, so every path takes its locks in the same order; the
 * database triggers take the same lock again, so raw SQL cannot slip between them either.
 */
export async function lockUnit(tx: Tx, companyId: string, unitId: string): Promise<void> {
  await tx.execute(sql`select app.lock_unit_leases(${companyId}::uuid, ${unitId}::uuid)`);
}

/** Refuses, kindly, a lease that would overlap one already holding the unit (the database also does). */
export async function assertNoOverlap(tx: Tx, row: LeaseRow): Promise<void> {
  const clash = await tx.execute<{ id: string }>(
    sql`select id from lease where company_id = ${row.companyId} and unit_id = ${row.unitId}
        and id <> ${row.id} and status in (${statusList(HOLDING_STATUSES)})
        and daterange(start_date, end_date, '[]') && daterange(${row.startDate}::date, ${row.endDate}::date, '[]')
        limit 1`,
  );
  if (clash.rows.length > 0)
    throw conflict('lease_overlap', 'Another lease holds this unit for some of these dates');
}

/** The last day a lease has been charged for: the latest end of its schedule rows. */
export async function lastChargedDay(tx: Tx, leaseId: string): Promise<string | null> {
  const result = await tx.execute<{ last: string | null }>(
    sql`select max(period_end)::text as last from charge_period where lease_id = ${leaseId}`,
  );
  return result.rows[0]?.last ?? null;
}

/**
 * The checks, with clear errors, that the database makes when a lease starts to hold its unit
 * (`starting`: sent for signing, or recorded as signed on paper) and when it is signed (review
 * findings 2 and 3; migration 0011):
 * - no lease holding the unit overlaps it;
 * - the unit is live and lettable;
 * - when starting: no earlier lease is held over (the tenant is still there with no move-out
 *   recorded), unless this lease renews it;
 * - no lease holding the unit has already been charged for a day of its term.
 */
export async function assertUnitFree(
  tx: Tx,
  row: LeaseRow,
  options: { readonly starting: boolean; readonly today: string },
): Promise<void> {
  await assertNoOverlap(tx, row);
  const unit = await tx.execute<{ live: boolean }>(
    sql`select archived_at is null and availability <> 'not_lettable' as live from unit
        where company_id = ${row.companyId} and id = ${row.unitId}`,
  );
  if (unit.rows[0]?.live !== true)
    throw conflict(
      'unit_not_lettable',
      'The unit is archived or not lettable, so the lease cannot hold it',
    );
  if (options.starting) {
    const held = await tx.execute<{ id: string }>(
      sql`select id from lease where company_id = ${row.companyId} and unit_id = ${row.unitId}
          and id <> ${row.id} and start_date < ${row.startDate}::date
          and (status = 'holding_over' or (status in ('active', 'ending') and end_date < ${options.today}::date))
          and id is distinct from ${row.renewsLeaseId}::uuid
          limit 1`,
    );
    if (held.rows.length > 0)
      throw conflict(
        'tenant_holding_over',
        'The current tenant of this unit is holding over; record their move-out first',
      );
  }
  const charged = await tx.execute<{ id: string; last: string }>(
    sql`select l.id, (select max(q.period_end)::text from charge_period q
                      where q.company_id = l.company_id and q.lease_id = l.id) as last
        from lease l
        where l.company_id = ${row.companyId} and l.unit_id = ${row.unitId} and l.id <> ${row.id}
          and l.status in ('signed', 'active', 'ending', 'holding_over')
          and exists (select 1 from charge_period p where p.company_id = l.company_id and p.lease_id = l.id
            and daterange(p.period_start, p.period_end, '[]') && daterange(${row.startDate}::date, ${row.endDate}::date, '[]'))
        limit 1`,
  );
  const clash = charged.rows[0];
  if (clash)
    throw clash.id === row.renewsLeaseId
      ? conflict(
          'renewal_start_too_early',
          `The renewal must start after ${formatBusinessDate(clash.last)}, the last day already charged to the current lease`,
        )
      : conflict('lease_overlap', 'Another lease has already been charged for some of these dates');
}

/** The signer roles staff may take: for the landlord, or as witness (review finding 7). */
const STAFF_SIGNER_ROLES: ReadonlySet<string> = new Set<SignerRole>(['landlord', 'witness']);

/**
 * A party linked to a staff person signs for the landlord or witnesses, and that person is an
 * active member of the lease's company. Checked when parties are saved and again at issue.
 */
export async function assertStaffParties(
  tx: Tx,
  parties: readonly {
    readonly role: string;
    readonly name: string;
    readonly staffPersonId?: string | null;
  }[],
): Promise<void> {
  const staff = parties.filter((p) => p.staffPersonId);
  for (const p of staff)
    if (!STAFF_SIGNER_ROLES.has(p.role))
      throw invalid(
        'party_staff',
        `${p.name} is one of your staff, who sign only for the landlord or as a witness`,
      );
  const members = await activeMemberIds(
    tx,
    staff.map((p) => p.staffPersonId!),
  );
  const outsider = staff.find((p) => !members.has(p.staffPersonId!));
  if (outsider)
    throw invalid(
      'party_staff',
      `${outsider.name} is not an active member of your company; choose someone who is, or add them without a staff link`,
    );
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
  if (state === 'RA030')
    return conflict(
      'tenant_holding_over',
      'The current tenant of this unit is holding over; record their move-out first',
    );
  if (state === 'RA031')
    return conflict(
      'renewal_start_too_early',
      'The lease starts on a day the current lease has already been charged for',
    );
  if (state === 'RA032')
    return conflict('unit_charged', 'Another lease already charges this unit for those days');
  return error;
}
