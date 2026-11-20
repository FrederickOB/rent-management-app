import { schema, sql, type Tx } from '@rent/db';
import {
  addDays,
  businessDateOf,
  compareDates,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import type { PolicyAction } from '@rent/domain/policy';
import {
  arrearsBaselineMonth,
  arrearsOver60,
  ratioOf,
  reportMonth,
  weeklyActiveManagers,
  weeksStartingIn,
  whatsappAdoption,
  type ArrearsOver60,
  type ArrearsSnapshotRow,
  type Ratio,
  type WeeklyActiveManagers,
  type WhatsappAdoption,
} from '@rent/domain/reporting';
import { companyRecord } from '../companies/companies.service';
import { membersWhoCan } from '../policy/members';
import type { PolicyService } from '../policy/policy.service';

/**
 * The facts behind the Gate 1 measures M11 adds (decision 4; PRD section 19): arrears over 60 days
 * against the rent roll, weekly active managers, tenant WhatsApp adoption and time to receipt
 * delivered. Each selects one company's month in the caller's transaction (the rollup's, in the
 * company's context); the counting is the domain's (`@rent/domain/reporting`).
 */

/**
 * Who counts as a manager for weekly active managers (decision 4): the people who work the
 * company's money and leases, as the policy judges them (CLAUDE.md section 5: no role checks
 * here). `payments.view` is held by a landlord's own owner users, agency admins, property managers
 * and accountants; never by caretakers, advisers, or an agency's owner clients. A founder decision
 * to confirm (M11 section 9).
 */
export const MANAGER_ACTION: PolicyAction = 'payments.view';

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const dayIn = (at: Date | string, timeZone: string): string =>
  toIsoDate(businessDateOf(instantFrom(asDate(at)), timeZone));

/** The company's cut-over date (decision 3), or null before onboarding set one. */
export async function cutOverDateIn(tx: Tx): Promise<string | null> {
  const rows = await tx.execute<{ cut_over_date: string }>(
    sql`select cut_over_date::text as cut_over_date from company_onboarding limit 1`,
  );
  return rows.rows[0]?.cut_over_date ?? null;
}

/**
 * Arrears over 60 days (decision 4) from one day's lease snapshot: `rows` when the caller has
 * them (the rollup's own snapshot of today, not stored yet), else the month's latest stored
 * snapshot up to `asOfDate`. The baseline month's stored share is read for later months.
 */
export async function arrearsOver60In(
  tx: Tx,
  input: {
    readonly month: string;
    readonly asOfDate: string;
    readonly cutOverDate: string | null;
    readonly rows?: readonly ArrearsSnapshotRow[];
  },
): Promise<ArrearsOver60> {
  const range = reportMonth(input.month);
  let rows: readonly ArrearsSnapshotRow[] = input.rows ?? [];
  if (!input.rows) {
    const until =
      compareDates(parseBusinessDate(input.asOfDate), parseBusinessDate(range.lastDay)) < 0
        ? input.asOfDate
        : range.lastDay;
    const s = schema.leaseSnapshot;
    const found = await tx
      .select({
        arrears61To90Minor: s.arrears61To90Minor,
        arrears90PlusMinor: s.arrears90PlusMinor,
        rentMinor: s.rentMinor,
        serviceChargeMinor: s.serviceChargeMinor,
      })
      .from(s)
      .where(
        sql`${s.snapshotDate} = (select max(${s.snapshotDate}) from ${s}
              where ${s.snapshotDate} between ${range.firstDay}::date and ${until}::date)`,
      );
    rows = found.map((r) => ({
      arrears61To90Minor: Number(r.arrears61To90Minor),
      arrears90PlusMinor: Number(r.arrears90PlusMinor),
      rentMinor: Number(r.rentMinor),
      serviceChargeMinor: Number(r.serviceChargeMinor),
    }));
  }
  const baselineMonth = arrearsBaselineMonth(input.cutOverDate);
  let baselineShare: Ratio | null = null;
  if (baselineMonth !== null && input.month > baselineMonth) {
    const stored = await tx.execute<{ share: Ratio | null }>(
      sql`select figures->'gate1'->'arrearsOver60'->'share' as share from metric_daily
          where month = ${baselineMonth} order by metric_date desc limit 1`,
    );
    const share = stored.rows[0]?.share ?? null;
    baselineShare = share ? ratioOf(Number(share.numerator), Number(share.denominator)) : null;
  }
  return arrearsOver60({
    month: input.month,
    rows,
    cutOverDate: input.cutOverDate,
    baselineShare,
  });
}

/**
 * Weekly active managers (decision 4): the company's managers (`MANAGER_ACTION`) and their active
 * days (`staff_active_day`) in the weeks starting in the month, which may end in the next.
 */
export async function weeklyActiveManagersIn(
  tx: Tx,
  policy: PolicyService,
  companyId: string,
  month: string,
  asOfDate: string,
): Promise<WeeklyActiveManagers> {
  const company = await companyRecord(tx, companyId);
  const staff = company
    ? [
        ...new Set(
          await membersWhoCan(tx, policy, { id: companyId, kind: company.kind }, MANAGER_ACTION),
        ),
      ].map((personId) => ({ companyId, personId }))
    : [];
  const weeks = weeksStartingIn(month);
  const from = weeks[0] ?? reportMonth(month).firstDay;
  const to = toIsoDate(addDays(parseBusinessDate(weeks.at(-1) ?? from), 6));
  const days = await tx.execute<{ person_id: string; day: string }>(
    sql`select person_id, day::text as day from staff_active_day
        where day between ${from}::date and ${to}::date`,
  );
  return weeklyActiveManagers({
    month,
    staff,
    activeDays: days.rows.map((d) => ({ companyId, personId: d.person_id, day: d.day })),
    asOf: asOfDate,
  });
}

/**
 * Tenant WhatsApp adoption (decision 4): tenants with a lease active on any day of the month,
 * with WhatsApp consent held at the month's end (or `asOf`, while it runs), who wrote to us on
 * WhatsApp or read one of our WhatsApp messages in it. `asOf` is on the database's clock, which
 * stamps consent and messages (as `Gate1Service.compute` shifts it).
 */
export async function whatsappAdoptionIn(
  tx: Tx,
  companyId: string,
  month: string,
  window: { readonly from: Date; readonly to: Date },
  asOf: Date,
  timeZone: string,
): Promise<WhatsappAdoption> {
  const range = reportMonth(month);
  const until = asOf.getTime() < window.to.getTime() ? asOf : window.to;
  const leased = await tx.execute<{ tenant_id: string }>(
    sql`select distinct l.tenant_id from lease l
        where l.status in ('signed', 'active', 'ending', 'holding_over', 'ended', 'terminated')
          and l.start_date <= ${range.lastDay}::date
          and (l.status in ('signed', 'active', 'ending', 'holding_over')
               or coalesce(l.ended_on, l.end_date) >= ${range.firstDay}::date)`,
  );
  const consent = await tx.execute<{ tenant_id: string; action: string }>(
    sql`select distinct on (tenant_id) tenant_id, action from consent_event
        where channel = 'whatsapp' and tenant_contact_id is null and recorded_at < ${until}
        order by tenant_id, recorded_at desc, id desc`,
  );
  const granted = new Set(consent.rows.filter((c) => c.action === 'grant').map((c) => c.tenant_id));
  const uses = await tx.execute<{ tenant_id: string; at: Date | string }>(
    sql`select m.tenant_id, m.created_at as at from message m
        where m.direction = 'inbound' and m.channel = 'whatsapp' and m.author_type = 'tenant'
          and m.tenant_id is not null and m.created_at >= ${window.from} and m.created_at < ${until}
        union all
        select m.tenant_id, e.occurred_at as at from message_event e
        join message m on m.company_id = e.company_id and m.id = e.message_id
        where e.status = 'read' and e.channel = 'whatsapp' and m.direction = 'outbound'
          and m.recipient_type = 'tenant' and m.tenant_id is not null
          and e.occurred_at >= ${window.from} and e.occurred_at < ${until}`,
  );
  return whatsappAdoption({
    month,
    tenants: leased.rows.map((t) => ({
      companyId,
      tenantId: t.tenant_id,
      activeLease: true,
      whatsappConsent: granted.has(t.tenant_id),
    })),
    uses: uses.rows.map((u) => ({ companyId, tenantId: u.tenant_id, day: dayIn(u.at, timeZone) })),
  });
}

/**
 * Time to receipt delivered (decision 4): for each receipt issued in the month, from the payment's
 * confirmation to the first delivery (or read) report on the receipt's message; null when none
 * came. Ordered as `timeToReceipt`'s receipts are.
 */
export async function receiptDeliveredLatenciesIn(
  tx: Tx,
  window: { readonly from: Date; readonly to: Date },
): Promise<(number | null)[]> {
  const rows = await tx.execute<{
    confirmed_at: Date | string | null;
    delivered_at: Date | string | null;
  }>(
    sql`select d.confirmed_at,
          (select min(e.occurred_at) from message_event e
           where e.company_id = d.company_id and e.message_id = d.message_id
             and e.status in ('delivered', 'read')) as delivered_at
        from receipt r
        left join receipt_delivery d on d.company_id = r.company_id and d.receipt_id = r.id
        where r.kind = 'receipt' and r.issued_at >= ${window.from} and r.issued_at < ${window.to}
        order by r.issued_at, r.id`,
  );
  return rows.rows.map((r) =>
    r.confirmed_at === null || r.delivered_at === null
      ? null
      : Math.max(0, asDate(r.delivered_at).getTime() - asDate(r.confirmed_at).getTime()),
  );
}
