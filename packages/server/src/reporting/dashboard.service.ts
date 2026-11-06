import { Inject, Injectable } from '@nestjs/common';
import { schema, sql, withCompany, type Database, type SQL, type Tx } from '@rent/db';
import { templates, type DashboardDocumentData } from '@rent/documents';
import {
  AGE_BUCKETS,
  AGE_BUCKET_LABELS,
  type AgeBucket,
  type AllocationSource,
  type LineKind,
} from '@rent/domain/billing';
import { addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import { XLSX_CONTENT_TYPE, type DisplayStatus } from '@rent/domain/portfolio';
import { money, toDecimal } from '@rent/domain/money';
import {
  collectionRate,
  COLLECTION_METHODS,
  occupancyOf,
  paidUntilCoverage,
  type CollectionLine,
  type CoverageUnit,
  type OccupancySummary,
  type PaidUntilCoverage,
  type Ratio,
} from '@rent/domain/reporting';
import { v7 as uuidv7 } from 'uuid';
import writeXlsxFile from 'write-excel-file/node';
import { isoNow } from '../billing/records';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { invalid, notFound } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { DISPLAY_STATUS_SQL } from '../portfolio/register-read.service';
import { Gate1Service, type Gate1View } from './gate1.service';
import { METRICS_REFRESH_EVENT } from './rollup.service';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

/** DA-06: the dashboard's filters. Owner and property by id, region and unit type by value. */
export interface DashboardFilters {
  readonly ownerId?: string;
  readonly propertyId?: string;
  readonly region?: string;
  readonly unitType?: string;
}

export interface DashboardView {
  /** When the snapshot was worked out; null before the first rollup. */
  readonly asOf: Date | null;
  /** The snapshot's day (the company's calendar), or today before the first rollup. */
  readonly date: string;
  readonly occupancy: OccupancySummary;
  readonly collectionRate: {
    readonly month: string;
    readonly dueMinor: number;
    readonly collectedMinor: number;
    readonly rate: Ratio;
  };
  readonly arrears: {
    readonly totalMinor: number;
    readonly byBucket: Readonly<Record<AgeBucket, number>>;
    readonly leases: number;
  };
  readonly rentRoll: {
    readonly rentMinor: number;
    readonly serviceChargeMinor: number;
    readonly totalMinor: number;
  };
  readonly unearnedRentMinor: number;
  readonly depositsHeldMinor: number;
  readonly paidUntilCoverage: PaidUntilCoverage;
  readonly expiries: readonly {
    readonly withinMonths: 3 | 6 | 12;
    readonly leases: number;
    readonly renewalOffered: number;
    readonly renewed: number;
  }[];
  readonly gate1: Gate1View | null;
  readonly filterOptions: {
    readonly owners: readonly { readonly id: string; readonly name: string }[];
    readonly properties: readonly { readonly id: string; readonly name: string }[];
    readonly regions: readonly string[];
    readonly unitTypes: readonly string[];
  };
}

export interface DashboardExportView {
  readonly id: string;
  readonly format: 'pdf' | 'xlsx';
  readonly status: 'rendering' | 'ready' | 'failed';
  readonly url: string | null;
  readonly expiresAt: Date | null;
}

/** One figure of an export: the same rows go to Excel and to the PDF, from the screen's view. */
export interface DashboardRow {
  readonly section: string;
  readonly figure: string;
  readonly count: number | null;
  readonly amountMinor: number | null;
  /** A share in basis points; null when there was nothing to measure. */
  readonly bps: number | null;
}

export const DASHBOARD_TEMPLATE = { key: 'reporting.dashboard', version: 1 } as const;
const DOWNLOAD_MS = 300_000;
const EXPIRY_MONTHS = [3, 6, 12] as const;
/** The renewal lease is being prepared or signed (DA-02). */
const OFFERED = ['draft', 'pending_signatures'];
/** The renewal lease is signed: the tenancy carries on. */
const RENEWED = ['signed', 'active', 'ending', 'holding_over', 'ended', 'terminated'];
const BUCKET_COLUMN: Record<AgeBucket, string> = {
  '0_30': 'arrears_0_to_30_minor',
  '31_60': 'arrears_31_to_60_minor',
  '61_90': 'arrears_61_to_90_minor',
  '90_plus': 'arrears_90_plus_minor',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SnapshotSqlRow = {
  lease_id: string;
  unit_id: string;
  occupying: boolean;
  end_date: string;
  renewal_status: string | null;
  paid_until: string | null;
  months_paid_ahead: number;
  arrears_0_to_30_minor: number;
  arrears_31_to_60_minor: number;
  arrears_61_to_90_minor: number;
  arrears_90_plus_minor: number;
  unearned_rent_minor: number;
  deposit_held_minor: number;
  rent_minor: number;
  service_charge_minor: number;
};

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** A share as a percentage with two decimals, from basis points; a dash when undefined. */
export function percentText(bps: number | null): string {
  if (bps === null) return '—';
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;
}

/**
 * The figures of a dashboard as rows, for both exports (DA-06): every figure the screen shows,
 * from the same view, so an export always matches the screen.
 */
export function dashboardRows(view: DashboardView): DashboardRow[] {
  const rows: DashboardRow[] = [];
  const count = (section: string, figure: string, n: number | null) =>
    rows.push({ section, figure, count: n, amountMinor: null, bps: null });
  const amount = (section: string, figure: string, minor: number) =>
    rows.push({ section, figure, count: null, amountMinor: minor, bps: null });
  const share = (section: string, figure: string, ratio: Ratio) =>
    rows.push({ section, figure, count: null, amountMinor: null, bps: ratio.bps });
  const o = view.occupancy;
  const occ = 'Occupancy';
  count(occ, 'Units', o.units);
  count(occ, 'Lettable', o.lettable);
  count(occ, 'Occupied', o.occupied);
  count(occ, 'Vacant', o.vacant);
  count(occ, 'Available', o.available);
  count(occ, 'Reserved', o.reserved);
  count(occ, 'Under repair', o.underRepair);
  count(occ, 'Not lettable', o.notLettable);
  share(occ, 'Occupancy rate', o.rate);
  const col = `Collection rate, ${view.collectionRate.month}`;
  amount(col, 'Rent due', view.collectionRate.dueMinor);
  amount(col, 'Rent collected', view.collectionRate.collectedMinor);
  share(col, 'Collection rate', view.collectionRate.rate);
  for (const bucket of AGE_BUCKETS)
    amount('Arrears', AGE_BUCKET_LABELS[bucket], view.arrears.byBucket[bucket]);
  amount('Arrears', 'Total arrears', view.arrears.totalMinor);
  count('Arrears', 'Leases in arrears', view.arrears.leases);
  amount('Rent roll', 'Rent', view.rentRoll.rentMinor);
  amount('Rent roll', 'Service charge', view.rentRoll.serviceChargeMinor);
  amount('Rent roll', 'Total', view.rentRoll.totalMinor);
  amount('Held for tenants', 'Unearned rent', view.unearnedRentMinor);
  amount('Held for tenants', 'Deposits held', view.depositsHeldMinor);
  const pc = 'Paid-until coverage';
  count(pc, 'Occupied units', view.paidUntilCoverage.occupied);
  count(pc, 'Paid until today or later', view.paidUntilCoverage.covered);
  share(pc, 'Coverage', view.paidUntilCoverage.rate);
  count(pc, 'Median months paid ahead', view.paidUntilCoverage.medianMonthsPaidAhead);
  for (const e of view.expiries) {
    const section = `Leases ending within ${e.withinMonths} months`;
    count(section, 'Leases', e.leases);
    count(section, 'Renewal offered', e.renewalOffered);
    count(section, 'Renewed', e.renewed);
  }
  const g = view.gate1;
  if (g) {
    const s = `Gate 1, ${g.month}`;
    amount(s, 'Rent due', g.collectionRate.dueMinor);
    amount(s, 'Rent collected', g.collectionRate.collectedMinor);
    share(s, 'Collection rate', g.collectionRate.rate);
    for (const method of COLLECTION_METHODS)
      amount(s, `Received by ${method.replace('_', ' ')}`, g.digitalShare.byMethod[method]);
    share(s, 'Digital payment share', g.digitalShare.share);
    count(s, 'Provider payments matched automatically', g.autoMatch.provider.automatic);
    count(s, 'Provider payments matched by a person', g.autoMatch.provider.byPerson);
    count(s, 'Provider payments unmatched', g.autoMatch.provider.unmatched);
    share(s, 'Auto-match rate', g.autoMatch.provider.rate);
    count(s, 'Direct transfers against a lease', g.autoMatch.directTransfers.againstLease);
    count(s, 'Direct transfers unmatched', g.autoMatch.directTransfers.unmatched);
    count(s, 'Receipts', g.timeToReceipt.receipts);
    count(s, 'Receipts within a minute', g.timeToReceipt.withinTarget);
    share(s, 'Receipts within a minute (share)', g.timeToReceipt.share);
    count(s, 'Median time to receipt (ms)', g.timeToReceipt.medianMs);
    count(s, '95th percentile time to receipt (ms)', g.timeToReceipt.p95Ms);
    count(s, 'Notices acknowledged within 7 days', g.noticeAcknowledgement.met);
    count(s, 'Notices not acknowledged within 7 days', g.noticeAcknowledgement.missed);
    count(s, 'Notices still inside 7 days', g.noticeAcknowledgement.pending);
    share(s, 'Notice acknowledgement', g.noticeAcknowledgement.rate);
    count(s, 'Emergency repairs attended within target', g.repairResponse.met);
    count(s, 'Emergency repairs attended late or not', g.repairResponse.missed);
    count(s, 'Emergency repairs still inside target', g.repairResponse.pending);
    share(s, 'Repair response', g.repairResponse.rate);
  }
  return rows;
}

/** The workbook's columns: text, the count, the amount in cedis and exactly in pesewas, the share. */
export const DASHBOARD_XLSX_COLUMNS = [
  'Section',
  'Figure',
  'Count',
  'Amount (GH₵)',
  'Amount in pesewas',
  'Share',
  'Share in basis points',
] as const;

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(Gate1Service) private readonly gate1: Gate1Service,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private reader(actor: Actor | null): StaffActor {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'dashboard.read');
    return staff;
  }

  /**
   * DA-01, DA-02 and DA-06: the portfolio dashboard. Money figures, paid-until and expiries come
   * from the latest rollup's snapshot; occupancy and this month's collection rate are counted live
   * (cheap). Everything is read in the reader's scope, so the database applies owner and property
   * scope as well (decision 15). Reads only.
   */
  async get(actor: Actor | null, filters: DashboardFilters = {}): Promise<DashboardView> {
    const staff = this.reader(actor);
    checkFilters(filters);
    return withCompany(
      this.database,
      staffContext(staff),
      (tx) => this.viewIn(tx, staff, filters),
      { accessMode: 'read only' },
    );
  }

  private async viewIn(tx: Tx, staff: StaffActor, filters: DashboardFilters) {
    const company = await companyRecord(tx, staff.companyId);
    if (!company) throw notFound('Company');
    const today = isoNow(this.clock, company.timeZone);
    const month = today.slice(0, 7);
    // The latest rollup is the company's (metric_daily), whatever part of it the reader sees.
    const [latest] = (
      await tx.execute<{ metric_date: string; computed_at: Date | string }>(
        sql`select metric_date::text as metric_date, computed_at from metric_daily
            order by metric_date desc limit 1`,
      )
    ).rows;
    const date = latest?.metric_date ?? today;
    const snapshot = latest ? await this.snapshotRows(tx, date, filters) : [];

    const byBucket = Object.fromEntries(
      AGE_BUCKETS.map((b) => [
        b,
        snapshot.reduce((s, r) => s + Number(r[BUCKET_COLUMN[b] as keyof SnapshotSqlRow]), 0),
      ]),
    ) as Record<AgeBucket, number>;
    const arrearsOf = (r: SnapshotSqlRow) =>
      AGE_BUCKETS.reduce((s, b) => s + Number(r[BUCKET_COLUMN[b] as keyof SnapshotSqlRow]), 0);
    const rent = snapshot.reduce((s, r) => s + Number(r.rent_minor), 0);
    const service = snapshot.reduce((s, r) => s + Number(r.service_charge_minor), 0);

    // One lease per occupied unit: should two ever hold one unit, the later-ending one counts.
    const occupied = new Map<string, SnapshotSqlRow>();
    for (const r of snapshot.filter((x) => x.occupying)) {
      const before = occupied.get(r.unit_id);
      if (!before || r.end_date > before.end_date) occupied.set(r.unit_id, r);
    }
    const units: CoverageUnit[] = [...occupied.values()].map((r) => ({
      unitId: r.unit_id,
      paidUntil: r.paid_until,
      monthsPaidAhead: Number(r.months_paid_ahead),
    }));
    const day = parseBusinessDate(date);
    const expiries = EXPIRY_MONTHS.map((withinMonths) => {
      const until = toIsoDate(addMonths(day, withinMonths));
      const ending = snapshot.filter(
        (r) => r.occupying && r.end_date >= date && r.end_date <= until,
      );
      return {
        withinMonths,
        leases: ending.length,
        renewalOffered: ending.filter((r) => OFFERED.includes(r.renewal_status ?? '')).length,
        renewed: ending.filter((r) => RENEWED.includes(r.renewal_status ?? '')).length,
      };
    });

    const collection = await this.collectionIn(tx, month, filters);
    return {
      asOf: latest ? asDate(latest.computed_at) : null,
      date,
      occupancy: await this.occupancyIn(tx, filters),
      collectionRate: {
        month,
        dueMinor: collection.dueMinor,
        collectedMinor: collection.collectedMinor,
        rate: collection.rate,
      },
      arrears: {
        totalMinor: AGE_BUCKETS.reduce((s, b) => s + byBucket[b], 0),
        byBucket,
        leases: snapshot.filter((r) => arrearsOf(r) > 0).length,
      },
      rentRoll: { rentMinor: rent, serviceChargeMinor: service, totalMinor: rent + service },
      unearnedRentMinor: snapshot.reduce((s, r) => s + Number(r.unearned_rent_minor), 0),
      depositsHeldMinor: snapshot.reduce((s, r) => s + Number(r.deposit_held_minor), 0),
      paidUntilCoverage: paidUntilCoverage({ units, today: date }),
      expiries,
      // Company-wide figures: only for people who see the whole company (decision 15).
      gate1: this.policy.scopeFor(staff) === null ? await this.gate1.latestIn(tx, month) : null,
      filterOptions: await this.filterOptionsIn(tx),
    } satisfies DashboardView;
  }

  private async snapshotRows(
    tx: Tx,
    date: string,
    filters: DashboardFilters,
  ): Promise<SnapshotSqlRow[]> {
    const where: SQL[] = [sql`s.snapshot_date = ${date}::date`];
    if (filters.ownerId) where.push(sql`s.owner_id = ${filters.ownerId}::uuid`);
    if (filters.propertyId) where.push(sql`s.property_id = ${filters.propertyId}::uuid`);
    if (filters.region) where.push(sql`p.region = ${filters.region}`);
    if (filters.unitType) where.push(sql`u.unit_type = ${filters.unitType}`);
    const rows = await tx.execute<SnapshotSqlRow>(
      sql`select s.lease_id, s.unit_id, s.occupying, s.end_date::text as end_date, s.renewal_status,
            s.paid_until::text as paid_until, s.months_paid_ahead,
            s.arrears0_to30_minor as arrears_0_to_30_minor, s.arrears31_to60_minor as arrears_31_to_60_minor,
            s.arrears61_to90_minor as arrears_61_to_90_minor, s.arrears90_plus_minor as arrears_90_plus_minor,
            s.unearned_rent_minor, s.deposit_held_minor, s.rent_minor, s.service_charge_minor
          from lease_snapshot s
          join property p on p.company_id = s.company_id and p.id = s.property_id
          join unit u on u.company_id = s.company_id and u.id = s.unit_id
          where ${sql.join(where, sql` and `)}`,
    );
    return rows.rows;
  }

  /** Units by their shown status (PR-06), live: occupancy from leases wins (decision 12, choice 14). */
  private async occupancyIn(tx: Tx, filters: DashboardFilters): Promise<OccupancySummary> {
    const where: SQL[] = [sql`u.archived_at is null`, sql`p.archived_at is null`];
    if (filters.ownerId)
      where.push(
        sql`exists (select 1 from property_current_ownership co
                    where co.company_id = u.company_id and co.property_id = u.property_id
                      and co.owner_id = ${filters.ownerId}::uuid)`,
      );
    if (filters.propertyId) where.push(sql`u.property_id = ${filters.propertyId}::uuid`);
    if (filters.region) where.push(sql`p.region = ${filters.region}`);
    if (filters.unitType) where.push(sql`u.unit_type = ${filters.unitType}`);
    const rows = await tx.execute<{ status: DisplayStatus; n: number }>(
      sql`select ${DISPLAY_STATUS_SQL} as status, count(*)::int as n from unit u
          join property p on p.company_id = u.company_id and p.id = u.property_id
          where ${sql.join(where, sql` and `)} group by 1`,
    );
    const counts: Partial<Record<DisplayStatus, number>> = {};
    for (const r of rows.rows) counts[r.status] = (counts[r.status] ?? 0) + Number(r.n);
    return occupancyOf(counts);
  }

  /**
   * Decision 9's collection rate for this month, live and filtered: the rent and service-charge
   * lines due in the month that the reader sees, by their invoice's owner, as the snapshot's owner
   * scope reads them.
   */
  private async collectionIn(tx: Tx, month: string, filters: DashboardFilters) {
    const first = `${month}-01`;
    const until = toIsoDate(addMonths(parseBusinessDate(first), 1));
    const where: SQL[] = [
      sql`l.kind in ('rent', 'service_charge')`,
      sql`l.due_date >= ${first}::date and l.due_date < ${until}::date`,
      sql`(app.owner_scope() is null or cardinality(app.owner_scope()) = 0 or i.owner_id = any(app.owner_scope()))`,
    ];
    if (filters.ownerId) where.push(sql`i.owner_id = ${filters.ownerId}::uuid`);
    if (filters.propertyId) where.push(sql`l.property_id = ${filters.propertyId}::uuid`);
    if (filters.region) where.push(sql`p.region = ${filters.region}`);
    if (filters.unitType) where.push(sql`u.unit_type = ${filters.unitType}`);
    const lines = await tx.execute<{
      id: string;
      kind: LineKind;
      due_date: string;
      amount_minor: number;
    }>(
      sql`select l.id, l.kind, l.due_date::text as due_date, l.amount_minor from invoice_line l
          join invoice i on i.company_id = l.company_id and i.id = l.invoice_id
          join property p on p.company_id = l.company_id and p.id = l.property_id
          join unit u on u.company_id = i.company_id and u.id = i.unit_id
          where ${sql.join(where, sql` and `)}`,
    );
    const allocations =
      lines.rows.length === 0
        ? { rows: [] }
        : await tx.execute<{
            invoice_line_id: string;
            source: AllocationSource;
            amount_minor: number;
            value_date: string;
          }>(
            sql`select a.invoice_line_id, a.source, a.amount_minor, a.value_date::text as value_date
                from allocation a
                where a.invoice_line_id = any(${`{${lines.rows.map((l) => l.id).join(',')}}`}::uuid[])`,
          );
    const byLine = new Map<string, CollectionLine['allocations'][number][]>();
    for (const a of allocations.rows) {
      const list = byLine.get(a.invoice_line_id) ?? [];
      list.push({ source: a.source, amountMinor: Number(a.amount_minor), valueDate: a.value_date });
      byLine.set(a.invoice_line_id, list);
    }
    return collectionRate({
      month,
      lines: lines.rows.map((l) => ({
        lineId: l.id,
        kind: l.kind,
        dueDate: l.due_date,
        amountMinor: Number(l.amount_minor),
        allocations: byLine.get(l.id) ?? [],
      })),
    });
  }

  private async filterOptionsIn(tx: Tx): Promise<DashboardView['filterOptions']> {
    const owners = await tx.execute<{ id: string; name: string }>(
      sql`select id, display_name as name from owner where archived_at is null order by display_name, id`,
    );
    const properties = await tx.execute<{ id: string; name: string }>(
      sql`select id, name from property where archived_at is null order by name, id`,
    );
    const regions = await tx.execute<{ region: string }>(
      sql`select distinct region from property where archived_at is null order by region`,
    );
    const types = await tx.execute<{ unit_type: string }>(
      sql`select distinct unit_type from unit where archived_at is null order by unit_type`,
    );
    return {
      owners: owners.rows,
      properties: properties.rows,
      regions: regions.rows.map((r) => r.region),
      unitTypes: types.rows.map((r) => r.unit_type),
    };
  }

  // Refresh (decision 11) ---------------------------------------------------------------------

  /**
   * Queues a fresh rollup for the company through the outbox; it never runs inline. Clicks in
   * the same minute queue one.
   */
  async refresh(actor: Actor | null): Promise<{ queued: boolean }> {
    const staff = this.reader(actor);
    const minute = this.clock.now().toISOString().slice(0, 16);
    await withCompany(this.database, staffContext(staff), (tx) =>
      enqueueOutbox(tx, {
        companyId: staff.companyId,
        type: METRICS_REFRESH_EVENT,
        payload: { requestedBy: staff.personId },
        idempotencyKey: `${METRICS_REFRESH_EVENT}:${minute}`,
      }),
    );
    return { queued: true };
  }

  // Exports (DA-06) ---------------------------------------------------------------------------

  /**
   * The dashboard as the reader sees it with these filters: Excel stored write-once at once and
   * returned as a 5-minute link, or a PDF queued with the renderer. Both carry the rows of
   * `dashboardRows`, from the same view as the screen.
   */
  async exportCreate(
    actor: Actor | null,
    input: DashboardFilters & { readonly format: 'pdf' | 'xlsx' },
  ): Promise<DashboardExportView> {
    const staff = this.reader(actor);
    const { format, ...filters } = input;
    checkFilters(filters);
    const { view, company } = await withCompany(
      this.database,
      staffContext(staff),
      async (tx) => ({
        view: await this.viewIn(tx, staff, filters),
        company: (await companyRecord(tx, staff.companyId))!,
      }),
      { accessMode: 'read only' },
    );
    const exportId = uuidv7();
    const data = this.documentData(view, filters, company);
    if (format === 'pdf') {
      await withCompany(this.database, staffContext(staff), async (tx) => {
        const renderRequestId = await this.documents.requestRender(tx, {
          companyId: staff.companyId,
          templateKey: DASHBOARD_TEMPLATE.key,
          templateVersion: DASHBOARD_TEMPLATE.version,
          data: data as unknown as Record<string, unknown>,
          requestedBy: staff.personId,
        });
        await tx.insert(schema.dashboardExport).values({
          id: exportId,
          companyId: staff.companyId,
          format,
          filters: { ...filters },
          status: 'rendering',
          renderRequestId,
          requestedBy: staff.personId,
        });
      });
      return { id: exportId, format, status: 'rendering', url: null, expiresAt: null };
    }
    const bytes = await dashboardWorkbook(data);
    // Stored write-once before the transaction that records it; nothing is held open meanwhile.
    const file = await this.documents.storeWriteOnce({
      companyId: staff.companyId,
      countryCode: company.countryCode,
      key: `documents/${staff.companyId}/dashboard-exports/${exportId}.xlsx`,
      bytes,
      contentType: XLSX_CONTENT_TYPE,
    });
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const id = await this.documents.recordWriteOnce(tx, file, {
        kind: 'dashboard_export',
        dataSnapshot: data as unknown as Record<string, unknown>,
        createdBy: staff.personId,
      });
      await tx.insert(schema.dashboardExport).values({
        id: exportId,
        companyId: staff.companyId,
        format,
        filters: { ...filters },
        status: 'ready',
        documentId: id,
        requestedBy: staff.personId,
      });
      return id;
    });
    return this.ready(staff.companyId, exportId, format, documentId);
  }

  private async ready(
    companyId: string,
    exportId: string,
    format: 'pdf' | 'xlsx',
    documentId: string,
  ): Promise<DashboardExportView> {
    const url = await this.documents.downloadUrl(
      companyId,
      documentId,
      `dashboard.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    );
    if (!url) throw notFound('Export');
    return {
      id: exportId,
      format,
      status: 'ready',
      url,
      expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_MS),
    };
  }

  /** An export, for the person who asked for it only: it carries the figures of their scope. */
  async exportGet(actor: Actor | null, exportId: string): Promise<DashboardExportView> {
    const staff = this.reader(actor);
    if (!UUID.test(exportId)) throw notFound('Export');
    const found = await withCompany(
      this.database,
      staffContext(staff),
      async (tx) => {
        const [row] = await tx
          .execute<{
            id: string;
            format: 'pdf' | 'xlsx';
            status: 'rendering' | 'ready' | 'failed';
            document_id: string | null;
            render_request_id: string | null;
            requested_by: string | null;
          }>(
            sql`select id, format, status, document_id, render_request_id, requested_by
              from dashboard_export where id = ${exportId}::uuid`,
          )
          .then((r) => r.rows);
        if (!row || row.requested_by !== staff.personId) return null;
        const rendered =
          row.status === 'rendering' && row.render_request_id
            ? await this.documents.renderedDocument(tx, row.render_request_id)
            : null;
        return { row, rendered };
      },
      { accessMode: 'read only' },
    );
    if (!found) throw notFound('Export');
    const { row, rendered } = found;
    const documentId = row.document_id ?? rendered?.documentId ?? null;
    if (row.status === 'failed' || rendered?.status === 'failed')
      return { id: row.id, format: row.format, status: 'failed', url: null, expiresAt: null };
    if (documentId) return this.ready(staff.companyId, row.id, row.format, documentId);
    return { id: row.id, format: row.format, status: 'rendering', url: null, expiresAt: null };
  }

  /**
   * `documents.rendered` for a dashboard PDF (as M8's `MoveOutService.onDocumentRendered`): the
   * export is ready once its PDF is stored and fingerprinted. Idempotent.
   */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      if (
        !rendered ||
        rendered.templateKey !== DASHBOARD_TEMPLATE.key ||
        rendered.status !== 'rendered' ||
        !rendered.documentId
      )
        return false;
      const updated = await tx.execute(
        sql`update dashboard_export set status = 'ready', document_id = ${rendered.documentId}::uuid
            where render_request_id = ${renderRequestId}::uuid and status = 'rendering'`,
      );
      return (updated.rowCount ?? 0) > 0;
    });
  }

  /** The export's frozen data: the screen's rows, the filters by name, and when it was made. */
  private documentData(
    view: DashboardView,
    filters: DashboardFilters,
    company: { readonly displayName: string; readonly timeZone: string },
  ): DashboardDocumentData {
    const named = (list: readonly { id: string; name: string }[], id?: string) =>
      id ? (list.find((x) => x.id === id)?.name ?? 'Not in your view') : null;
    const labels: { label: string; value: string | null }[] = [
      { label: 'Owner', value: named(view.filterOptions.owners, filters.ownerId) },
      { label: 'Property', value: named(view.filterOptions.properties, filters.propertyId) },
      { label: 'Region', value: filters.region ?? null },
      { label: 'Unit type', value: filters.unitType ?? null },
    ];
    return {
      title: `${company.displayName}: portfolio dashboard`,
      generatedAt: this.clock.now().toISOString(),
      timeZone: company.timeZone,
      asOf: view.asOf ? view.asOf.toISOString() : null,
      date: view.date,
      filters: labels.flatMap((l) => (l.value ? [{ label: l.label, value: l.value }] : [])),
      rows: dashboardRows(view),
    };
  }
}

function checkFilters(filters: DashboardFilters): void {
  for (const id of [filters.ownerId, filters.propertyId])
    if (id !== undefined && !UUID.test(id)) throw invalid('bad_filter', 'Choose from the list');
  if (filters.region !== undefined && filters.region.length > 60)
    throw invalid('bad_filter', 'Choose a region from the list');
  if (filters.unitType !== undefined && filters.unitType.length > 40)
    throw invalid('bad_filter', 'Choose a unit type from the list');
}

/** The Excel export (DA-06): one sheet, every figure in its own row, amounts exact in pesewas. */
export async function dashboardWorkbook(data: DashboardDocumentData): Promise<Buffer> {
  // Checked as the PDF's data is, so both exports carry the same, valid rows.
  templates.get(DASHBOARD_TEMPLATE.key, DASHBOARD_TEMPLATE.version).schema.parse(data);
  const bold = (value: string) => ({ value, fontWeight: 'bold' as const });
  const text = (value: string | null) => (value === null ? null : { value });
  const head = [
    [bold(data.title)],
    [text('Figures as of'), text(data.asOf ? `${data.asOf} (UTC)` : 'No rollup yet')],
    [text('Snapshot date'), text(data.date)],
    [text('Time zone'), text(data.timeZone)],
    ...data.filters.map((f) => [text(f.label), text(f.value)]),
    [],
    DASHBOARD_XLSX_COLUMNS.map((c) => bold(c)),
  ];
  const body = data.rows.map((r) => [
    text(r.section),
    text(r.figure),
    r.count === null ? null : { value: r.count, type: Number },
    r.amountMinor === null ? null : { value: toDecimal(money(r.amountMinor)) },
    r.amountMinor === null ? null : { value: r.amountMinor, type: Number },
    r.bps === null && r.count === null && r.amountMinor === null
      ? { value: percentText(null) }
      : r.bps === null
        ? null
        : { value: percentText(r.bps) },
    r.bps === null ? null : { value: r.bps, type: Number },
  ]);
  return writeXlsxFile([{ sheet: 'Dashboard', data: [...head, ...body] }]).toBuffer();
}
