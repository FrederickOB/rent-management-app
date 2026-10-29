import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import {
  DISPLAY_STATUSES,
  mapsLink,
  type Amenity,
  type Availability,
  type BillingBand,
  type DisplayStatus,
  type MeterType,
  type PropertyType,
  type PropertyUse,
  type UnitType,
  type Utility,
} from '@rent/domain/portfolio';
import { notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { staffActor } from '../companies/companies.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import type {
  BlockView,
  MeterView,
  OwnerRef,
  OwnershipRow,
  PropertyDetail,
  PropertyFilters,
  PropertyRow,
  StatusCounts,
  StatusEventView,
  UnitDetail,
  UnitFilters,
  UnitRow,
} from './register.types';

/**
 * A unit's occupancy from its leases (PB-09, M3): occupied while a lease is active, ending or
 * holding over, reserved between signature and start. The `unit_occupancy` view the tenancy
 * migration publishes has a row only for those units; nothing stores occupancy.
 */
const LEASE_OCCUPANCY = `(select o.occupancy from unit_occupancy o where o.company_id = u.company_id and o.unit_id = u.id)`;

export const OCCUPANCY_SQL = sql.raw(`coalesce(${LEASE_OCCUPANCY}, 'vacant')`);

/**
 * The status shown for a unit (PR-06; prd-issues 21): occupancy from leases wins, then the
 * availability set by hand. A repair on an occupied unit shows as a badge (underRepair).
 */
export const DISPLAY_STATUS_SQL = sql.raw(
  `coalesce(${LEASE_OCCUPANCY}, case u.availability when 'available' then 'vacant' else u.availability end)`,
);

const MAX_PAGE = 500;

const emptyCounts = (): StatusCounts =>
  Object.fromEntries(DISPLAY_STATUSES.map((s) => [s, 0])) as StatusCounts;

/**
 * Today's main owner of each property (the largest share, then the earliest reference), worked
 * out once per property rather than once per unit, so lists of thousands of units stay fast.
 */
const OWNER_JOIN = sql.raw(`left join (
    select distinct on (co.property_id) co.property_id, o.id, o.reference, o.display_name
    from property_current_ownership co
    join owner o on o.company_id = co.company_id and o.id = co.owner_id
    order by co.property_id, co.share_bps desc, o.reference
  ) own on own.property_id = p.id`);

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

type UnitSqlRow = {
  id: string;
  code: string;
  label: string;
  property_id: string;
  property_code: string;
  property_name: string;
  block_id: string;
  block_code: string;
  unit_type: string;
  bedrooms: number | null;
  billing_band: string;
  band_overridden: boolean;
  availability: string;
  status: string;
  occupancy: 'occupied' | 'reserved' | 'vacant';
  owner_id: string | null;
  owner_reference: string | null;
  owner_name: string | null;
  region: string;
  district: string | null;
  archived: boolean;
};

const ownerRef = (
  id: string | null,
  reference: string | null,
  name: string | null,
): OwnerRef | null => (id ? { id, reference: reference!, displayName: name! } : null);

const unitRow = (r: UnitSqlRow): UnitRow => ({
  id: r.id,
  code: r.code,
  label: r.label,
  propertyId: r.property_id,
  propertyCode: r.property_code,
  propertyName: r.property_name,
  blockId: r.block_id,
  blockCode: r.block_code,
  unitType: r.unit_type as UnitType,
  bedrooms: r.bedrooms,
  billingBand: r.billing_band as BillingBand,
  bandOverridden: r.band_overridden,
  availability: r.availability as Availability,
  status: r.status as DisplayStatus,
  occupancy: r.occupancy,
  underRepair: r.availability === 'under_repair',
  owner: ownerRef(r.owner_id, r.owner_reference, r.owner_name),
  region: r.region,
  district: r.district,
  archived: r.archived,
});

const UNIT_SELECT = sql`select u.id, u.code, u.label, u.property_id, p.code as property_code,
    p.name as property_name, u.block_id, b.code as block_code, u.unit_type, u.bedrooms,
    u.billing_band, u.band_override_reason is not null as band_overridden, u.availability,
    ${DISPLAY_STATUS_SQL} as status, ${OCCUPANCY_SQL} as occupancy, own.id as owner_id, own.reference as owner_reference,
    own.display_name as owner_name, p.region, p.district, u.archived_at is not null as archived
  from unit u
  join block b on b.company_id = u.company_id and b.id = u.block_id
  join property p on p.company_id = u.company_id and p.id = u.property_id
  ${OWNER_JOIN}`;

/** Lists and details for the register screens (PR-01 to PR-06; AD-02 scope applies). */
@Injectable()
export class RegisterReadService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  private unitConditions(filters: UnitFilters, withStatus: boolean) {
    const where = [sql`true`];
    if (!filters.includeArchived) where.push(sql`u.archived_at is null`);
    if (filters.ownerId) where.push(sql`own.id = ${filters.ownerId}`);
    if (filters.region) where.push(sql`p.region = ${filters.region}`);
    if (filters.district) where.push(sql`p.district = ${filters.district}`);
    if (filters.propertyId) where.push(sql`u.property_id = ${filters.propertyId}`);
    if (filters.unitType) where.push(sql`u.unit_type = ${filters.unitType}`);
    if (filters.search?.trim()) {
      const q = like(filters.search.trim());
      where.push(sql`(u.code ilike ${q} or p.name ilike ${q} or p.code ilike ${q})`);
    }
    if (withStatus && filters.status) where.push(sql`${DISPLAY_STATUS_SQL} = ${filters.status}`);
    return sql.join(where, sql` and `);
  }

  /**
   * Units across every owner the actor may see (PRD section 5 story), with counts by status.
   * The counts follow every filter except status, so each chip shows what choosing it gives.
   */
  async listUnits(
    actor: Actor | null,
    filters: UnitFilters = {},
  ): Promise<{ rows: UnitRow[]; total: number; counts: StatusCounts }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.view');
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), MAX_PAGE);
    const offset = Math.max(filters.offset ?? 0, 0);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx.execute<UnitSqlRow>(
        sql`${UNIT_SELECT} where ${this.unitConditions(filters, true)}
            order by p.code, b.code, u.label limit ${limit} offset ${offset}`,
      );
      const total = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from unit u
            join block b on b.company_id = u.company_id and b.id = u.block_id
            join property p on p.company_id = u.company_id and p.id = u.property_id
            ${OWNER_JOIN} where ${this.unitConditions(filters, true)}`,
      );
      return {
        rows: rows.rows.map(unitRow),
        total: total.rows[0]?.n ?? 0,
        counts: await this.statusCounts(tx, this.unitConditions(filters, false)),
      };
    });
  }

  private async statusCounts(tx: Tx, where: ReturnType<typeof sql.join>): Promise<StatusCounts> {
    const result = await tx.execute<{ status: string; n: number }>(
      sql`select ${DISPLAY_STATUS_SQL} as status, count(*)::int as n from unit u
          join block b on b.company_id = u.company_id and b.id = u.block_id
          join property p on p.company_id = u.company_id and p.id = u.property_id
          ${OWNER_JOIN} where ${where} group by 1`,
    );
    const counts = emptyCounts();
    for (const r of result.rows) counts[r.status as DisplayStatus] = r.n;
    return counts;
  }

  async listProperties(
    actor: Actor | null,
    filters: PropertyFilters = {},
  ): Promise<{ rows: PropertyRow[]; counts: StatusCounts }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const where = [sql`true`];
      if (!filters.includeArchived) where.push(sql`p.archived_at is null`);
      if (filters.ownerId) where.push(sql`own.id = ${filters.ownerId}`);
      if (filters.region) where.push(sql`p.region = ${filters.region}`);
      if (filters.district) where.push(sql`p.district = ${filters.district}`);
      if (filters.propertyType) where.push(sql`p.property_type = ${filters.propertyType}`);
      if (filters.search?.trim()) {
        const q = like(filters.search.trim());
        where.push(sql`(p.name ilike ${q} or p.code ilike ${q} or p.town ilike ${q})`);
      }
      const condition = sql.join(where, sql` and `);
      const rows = await tx.execute<PropertySqlRow>(
        sql`select ${PROPERTY_COLUMNS}, ${STATUS_COLUMNS}
            from property p ${OWNER_JOIN}
            left join unit u on u.company_id = p.company_id and u.property_id = p.id and u.archived_at is null
            where ${condition}
            group by p.id, own.id, own.reference, own.display_name
            order by p.code`,
      );
      const properties = rows.rows.map(propertyRow);
      const counts = emptyCounts();
      for (const p of properties) for (const s of DISPLAY_STATUSES) counts[s] += p.counts[s];
      return { rows: properties, counts };
    });
  }

  async getProperty(actor: Actor | null, propertyId: string): Promise<PropertyDetail> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const found = await tx.execute<
        PropertySqlRow & {
          portfolio_id: string;
          portfolio_name: string;
          ghanapost_gps: string | null;
          mmda: string | null;
          street: string | null;
          latitude: string | null;
          longitude: string | null;
          address_source: 'lookup' | 'manual';
          /** Raw SQL returns timestamps as text (the Drizzle driver keeps them unparsed). */
          created_at: string;
        }
      >(
        sql`select ${PROPERTY_COLUMNS}, ${STATUS_COLUMNS}, pf.id as portfolio_id, pf.name as portfolio_name,
              p.ghanapost_gps, p.mmda, p.street, p.latitude::text, p.longitude::text, p.address_source,
              p.created_at
            from property p ${OWNER_JOIN}
            join portfolio pf on pf.company_id = p.company_id and pf.id = p.portfolio_id
            left join unit u on u.company_id = p.company_id and u.property_id = p.id and u.archived_at is null
            where p.id = ${propertyId}
            group by p.id, own.id, own.reference, own.display_name, pf.id, pf.name`,
      );
      const row = found.rows[0];
      if (!row) throw notFound('Property');
      const pin =
        row.latitude && row.longitude
          ? { latitude: trimZeros(row.latitude), longitude: trimZeros(row.longitude) }
          : null;
      const ownership = await tx.execute<{
        owner_id: string;
        reference: string;
        display_name: string;
        share_bps: number;
        effective_from: string;
        current: boolean;
      }>(
        sql`select po.owner_id, o.reference, o.display_name, po.share_bps, po.effective_from::text,
              exists (select 1 from property_current_ownership c
                      where c.company_id = po.company_id and c.property_id = po.property_id
                        and c.owner_id = po.owner_id and c.effective_from = po.effective_from) as current
            from property_ownership po
            join owner o on o.company_id = po.company_id and o.id = po.owner_id
            where po.property_id = ${propertyId}
            order by po.effective_from desc, po.share_bps desc`,
      );
      const units = await tx.execute<UnitSqlRow>(
        sql`${UNIT_SELECT} where u.property_id = ${propertyId} and u.archived_at is null
            order by b.code, u.label`,
      );
      const blocks = await tx.execute<{
        id: string;
        code: string;
        name: string | null;
        is_default: boolean;
        archived: boolean;
      }>(
        sql`select id, code, name, is_default, archived_at is not null as archived from block
            where property_id = ${propertyId} and archived_at is null order by code`,
      );
      const unitRows = units.rows.map(unitRow);
      return {
        ...propertyRow(row),
        portfolio: { id: row.portfolio_id, name: row.portfolio_name },
        address: {
          ghanapostGps: row.ghanapost_gps,
          region: row.region,
          district: row.district,
          mmda: row.mmda,
          town: row.town,
          street: row.street,
          pin,
          mapsLink: pin ? mapsLink(pin) : null,
          source: row.address_source,
        },
        ownership: ownership.rows.map((o): OwnershipRow => ({
          ownerId: o.owner_id,
          reference: o.reference,
          displayName: o.display_name,
          shareBps: o.share_bps,
          effectiveFrom: o.effective_from,
          current: o.current,
        })),
        blocks: blocks.rows.map((b): BlockView => ({
          id: b.id,
          code: b.code,
          name: b.name,
          isDefault: b.is_default,
          archived: b.archived,
          units: unitRows.filter((u) => u.blockId === b.id),
        })),
        meters: await this.meters(tx, sql`m.property_id = ${propertyId}`),
        createdAt: new Date(row.created_at),
      };
    });
  }

  async getUnit(actor: Actor | null, unitId: string): Promise<UnitDetail> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const found = await tx.execute<
        UnitSqlRow & {
          floor: string | null;
          description: string | null;
          amenities: string[];
          band_override_reason: string | null;
        }
      >(
        sql`select q.*, u2.floor, u2.description, u2.amenities, u2.band_override_reason
            from (${UNIT_SELECT} where u.id = ${unitId}) q
            join unit u2 on u2.id = q.id`,
      );
      const row = found.rows[0];
      if (!row) throw notFound('Unit');
      return {
        ...unitRow(row),
        floor: row.floor,
        description: row.description,
        amenities: row.amenities as Amenity[],
        bandOverrideReason: row.band_override_reason,
        meters: await this.meters(
          tx,
          sql`exists (select 1 from unit_meter um where um.company_id = m.company_id and um.meter_id = m.id and um.unit_id = ${unitId})`,
        ),
        history: await this.history(tx, unitId),
      };
    });
  }

  async unitHistory(actor: Actor | null, unitId: string): Promise<StatusEventView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.view');
    return withCompany(this.database, staffContext(staff), (tx) => this.history(tx, unitId));
  }

  private async history(tx: Tx, unitId: string): Promise<StatusEventView[]> {
    const rows = await tx.execute<{
      id: string;
      kind: 'availability' | 'occupancy';
      from_value: string | null;
      to_value: string;
      reason: string | null;
      source: StatusEventView['source'];
      actor_name: string | null;
      occurred_at: string;
    }>(
      sql`select e.id, e.kind, e.from_value, e.to_value, e.reason, e.source, pe.name as actor_name,
            e.occurred_at
          from unit_status_event e left join person pe on pe.id = e.actor_person_id
          where e.unit_id = ${unitId} order by e.occurred_at desc, e.id desc`,
    );
    return rows.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      fromValue: r.from_value,
      toValue: r.to_value,
      reason: r.reason,
      source: r.source,
      actorName: r.actor_name,
      occurredAt: new Date(r.occurred_at),
    }));
  }

  private async meters(tx: Tx, where: ReturnType<typeof sql>): Promise<MeterView[]> {
    const rows = await tx.execute<{
      id: string;
      utility: string;
      supplier: string;
      meter_number: string;
      meter_type: string;
      notes: string | null;
      unit_ids: string[] | null;
      archived: boolean;
    }>(
      sql`select m.id, m.utility, m.supplier, m.meter_number, m.meter_type, m.notes,
            array(select um.unit_id from unit_meter um where um.company_id = m.company_id and um.meter_id = m.id
                  order by um.unit_id) as unit_ids,
            m.archived_at is not null as archived
          from meter m where m.archived_at is null and ${where} order by m.utility, m.meter_number`,
    );
    return rows.rows.map((r) => ({
      id: r.id,
      utility: r.utility as Utility,
      supplier: r.supplier,
      meterNumber: r.meter_number,
      meterType: r.meter_type as MeterType,
      notes: r.notes,
      unitIds: r.unit_ids ?? [],
      archived: r.archived,
    }));
  }
}

/** Numeric pins come back padded to 6 places; show them as they were typed. */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

type PropertySqlRow = {
  id: string;
  code: string;
  name: string;
  property_type: string;
  use: string;
  region: string;
  district: string | null;
  town: string | null;
  owner_id: string | null;
  owner_reference: string | null;
  owner_name: string | null;
  archived: boolean;
  unit_count: number;
  occupied: number;
  reserved: number;
  under_repair: number;
  not_lettable: number;
  vacant: number;
};

const PROPERTY_COLUMNS =
  sql.raw(`p.id, p.code, p.name, p.property_type, p.use, p.region, p.district,
  p.town, own.id as owner_id, own.reference as owner_reference, own.display_name as owner_name,
  p.archived_at is not null as archived`);

const STATUS_COLUMNS = sql`count(u.id)::int as unit_count,
  ${sql.join(
    DISPLAY_STATUSES.map(
      (s) => sql`(count(u.id) filter (where ${DISPLAY_STATUS_SQL} = ${s}))::int as ${sql.raw(s)}`,
    ),
    sql`, `,
  )}`;

function propertyRow(r: PropertySqlRow): PropertyRow {
  const counts = emptyCounts();
  for (const s of DISPLAY_STATUSES) counts[s] = r[s];
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    propertyType: r.property_type as PropertyType,
    use: r.use as PropertyUse,
    region: r.region,
    district: r.district,
    town: r.town,
    owner: ownerRef(r.owner_id, r.owner_reference, r.owner_name),
    unitCount: r.unit_count,
    counts,
    archived: r.archived,
  };
}
