import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import {
  businessDateOf,
  compareDates,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import {
  checkAmenities,
  checkAvailabilityChange,
  checkBedrooms,
  checkBlockCode,
  checkGhanaPostGps,
  checkMapPin,
  checkStatusReason,
  DEFAULT_BLOCK_CODE,
  defaultBandFor,
  freePropertyPart,
  nextUnitLabels,
  propertyCode,
  resolveBand,
  unitCode,
  WHOLE_PROPERTY_BPS,
  type Availability,
  type BillingBand,
  type PropertyType,
  type PropertyUse,
  type UnitType,
} from '@rent/domain/portfolio';
import type { AddressLookupPort, GhanaPostAddress } from '@rent/integrations';
import type { Clock } from '../core/clock';
import { isUniqueViolation } from '../core/db-errors';
import { conflict, invalid, notFound } from '../core/errors';
import { ADDRESS_LOOKUP_PORT, CLOCK, DATABASE } from '../core/tokens';
import { staffActor } from '../companies/companies.service';
import { OwnersService } from '../companies/owners.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import type { AddressInput, NewBlock, NewProperty, UnitBatch } from './register.types';

type StaffActor = ReturnType<typeof staffActor>;

/** Address fields as stored, after the PR-03 checks. */
export interface CheckedAddress {
  readonly ghanapostGps: string | null;
  readonly region: string;
  readonly district: string | null;
  readonly mmda: string | null;
  readonly town: string | null;
  readonly street: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly addressSource: 'lookup' | 'manual';
}

const text = (value: string | null | undefined, max: number): string | null => {
  const v = value?.trim();
  if (!v) return null;
  if (v.length > max) throw invalid('text_too_long', `Use at most ${max} characters`);
  return v;
};

function checkName(name: string, what: string): string {
  const v = name.trim();
  if (v.length < 2 || v.length > 120) throw invalid(`${what}_name`, `Enter a ${what} name`);
  return v;
}

/**
 * The property register (PR-01 to PR-06, PR-09, PB-01; M2 plan section 4). Every write checks the
 * policy and runs under the actor's scope; codes are fixed and history comes from triggers.
 */
@Injectable()
export class RegisterService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(OwnersService) private readonly owners: OwnersService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ADDRESS_LOOKUP_PORT) private readonly addressLookup: AddressLookupPort | null,
  ) {}

  /** Today in the company's time zone (Accra by default). */
  today(timeZone = 'Africa/Accra'): string {
    return toIsoDate(businessDateOf(instantFrom(this.clock.now()), timeZone));
  }

  // Portfolios ------------------------------------------------------------------------------

  async listPortfolios(actor: Actor | null) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await this.defaultPortfolio(tx, staff.companyId);
      return tx
        .select({
          id: schema.portfolio.id,
          name: schema.portfolio.name,
          isDefault: schema.portfolio.isDefault,
        })
        .from(schema.portfolio)
        .where(isNull(schema.portfolio.archivedAt))
        .orderBy(sql`${schema.portfolio.isDefault} desc, ${schema.portfolio.name}`);
    });
  }

  async createPortfolio(actor: Actor | null, name: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    const value = checkName(name, 'portfolio');
    try {
      const [row] = await withCompany(this.database, staffContext(staff), (tx) =>
        tx
          .insert(schema.portfolio)
          .values({ companyId: staff.companyId, name: value })
          .returning({ id: schema.portfolio.id }),
      );
      return row!.id;
    } catch (error) {
      if (isUniqueViolation(error, 'portfolio_name_key'))
        throw conflict('portfolio_name_taken', 'There is already a portfolio with that name');
      throw error;
    }
  }

  async renamePortfolio(actor: Actor | null, portfolioId: string, name: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    const value = checkName(name, 'portfolio');
    try {
      const rows = await withCompany(this.database, staffContext(staff), (tx) =>
        tx
          .update(schema.portfolio)
          .set({ name: value, updatedAt: new Date() })
          .where(eq(schema.portfolio.id, portfolioId))
          .returning({ id: schema.portfolio.id }),
      );
      if (rows.length === 0) throw notFound('Portfolio');
    } catch (error) {
      if (isUniqueViolation(error, 'portfolio_name_key'))
        throw conflict('portfolio_name_taken', 'There is already a portfolio with that name');
      throw error;
    }
  }

  /** The company's "Main portfolio", created the first time it is needed. */
  async defaultPortfolio(tx: Tx, companyId: string): Promise<string> {
    const [found] = await tx
      .select({ id: schema.portfolio.id })
      .from(schema.portfolio)
      .where(eq(schema.portfolio.isDefault, true));
    if (found) return found.id;
    const [row] = await tx
      .insert(schema.portfolio)
      .values({ companyId, name: 'Main portfolio', isDefault: true })
      .onConflictDoNothing()
      .returning({ id: schema.portfolio.id });
    if (row) return row.id;
    const [again] = await tx
      .select({ id: schema.portfolio.id })
      .from(schema.portfolio)
      .where(eq(schema.portfolio.isDefault, true));
    return again!.id;
  }

  /** The lists the register forms need: regions, suppliers, portfolios, and whether lookups work. */
  async options(actor: Actor | null): Promise<{
    regions: string[];
    meterSuppliers: { electricity: string[]; water: string[] };
    portfolios: { id: string; name: string; isDefault: boolean }[];
    addressLookup: boolean;
  }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.view');
    const portfolios = await this.listPortfolios(staff);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select({ regions: schema.country.regions, suppliers: schema.country.meterSuppliers })
        .from(schema.company)
        .innerJoin(schema.country, eq(schema.country.code, schema.company.countryCode))
        .where(eq(schema.company.id, staff.companyId));
      const suppliers = (row?.suppliers ?? {}) as { electricity?: string[]; water?: string[] };
      return {
        regions: row?.regions ?? [],
        meterSuppliers: { electricity: suppliers.electricity ?? [], water: suppliers.water ?? [] },
        portfolios,
        addressLookup: this.addressLookup !== null,
      };
    });
  }

  // Addresses -------------------------------------------------------------------------------

  /** The country's regions (PR-03), from configuration. */
  async regions(tx: Tx, companyId: string): Promise<string[]> {
    const [row] = await tx
      .select({ regions: schema.country.regions })
      .from(schema.company)
      .innerJoin(schema.country, eq(schema.country.code, schema.company.countryCode))
      .where(eq(schema.company.id, companyId));
    return row?.regions ?? [];
  }

  async checkAddress(tx: Tx, companyId: string, input: AddressInput): Promise<CheckedAddress> {
    const regions = await this.regions(tx, companyId);
    const region = regions.find((r) => r.toLowerCase() === input.region.trim().toLowerCase());
    if (!region) throw invalid('address_region', 'Choose a region from the list');
    const hasLat = input.latitude != null && input.latitude !== '';
    const hasLng = input.longitude != null && input.longitude !== '';
    if (hasLat !== hasLng) throw invalid('address_pin', 'Give both latitude and longitude');
    const pin = hasLat ? checkMapPin(input.latitude!, input.longitude!) : null;
    return {
      ghanapostGps: input.ghanapostGps?.trim() ? checkGhanaPostGps(input.ghanapostGps) : null,
      region,
      district: text(input.district, 80),
      mmda: text(input.mmda, 80),
      town: text(input.town, 80),
      street: text(input.street, 160),
      latitude: pin?.latitude ?? null,
      longitude: pin?.longitude ?? null,
      addressSource: input.source ?? 'manual',
    };
  }

  /**
   * Looks up a GhanaPost GPS address (PR-03). When no licensed source is configured, or it fails,
   * the form keeps manual entry (M2 decision 3).
   */
  async lookupAddress(
    actor: Actor | null,
    code: string,
  ): Promise<{ available: boolean; address: GhanaPostAddress | null }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    const normalised = checkGhanaPostGps(code);
    if (!this.addressLookup) return { available: false, address: null };
    try {
      return { available: true, address: await this.addressLookup.lookup(normalised) };
    } catch {
      return { available: false, address: null };
    }
  }

  // Properties ------------------------------------------------------------------------------

  async createProperty(actor: Actor | null, input: NewProperty): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    const code = propertyCode(input.areaCode, input.propertyPart);
    const name = checkName(input.name, 'property');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const address = await this.checkAddress(tx, staff.companyId, input.address);
      const ownerId = await this.ownerFor(tx, staff, input.ownerId ?? null);
      const propertyId = await this.insertProperty(tx, staff.companyId, {
        portfolioId: input.portfolioId ?? (await this.defaultPortfolio(tx, staff.companyId)),
        code,
        name,
        propertyType: input.propertyType,
        use: input.use,
        address,
      });
      await this.insertOwnership(tx, staff, propertyId, ownerId, this.today());
      const blocks: NewBlock[] = input.blocks?.length
        ? [...input.blocks]
        : [{ code: DEFAULT_BLOCK_CODE, units: input.units ?? [] }];
      for (const [index, block] of blocks.entries()) {
        const created = await this.insertBlock(tx, staff.companyId, propertyId, {
          code: block.code,
          name: block.name ?? null,
          isDefault: !input.blocks?.length && index === 0,
        });
        if (block.units?.length)
          await this.insertUnits(
            tx,
            staff.companyId,
            { id: propertyId, code },
            created,
            block.units,
          );
      }
      return propertyId;
    });
  }

  /** Inserts a property, turning a taken code into a conflict with a free suggestion. */
  async insertProperty(
    tx: Tx,
    companyId: string,
    values: {
      portfolioId: string;
      code: string;
      name: string;
      propertyType: PropertyType;
      use: PropertyUse;
      address: CheckedAddress;
    },
  ): Promise<string> {
    const [area, part] = values.code.split('-') as [string, string];
    const taken = await tx
      .select({ code: schema.property.code })
      .from(schema.property)
      .where(eq(schema.property.code, values.code));
    if (taken.length) {
      const sameArea = await tx
        .select({ code: schema.property.code })
        .from(schema.property)
        .where(sql`${schema.property.areaCode} = ${area}`);
      const suggestion = freePropertyPart(
        part,
        new Set(sameArea.map((r) => r.code.split('-')[1]!)),
      );
      throw conflict(
        'property_code_taken',
        suggestion
          ? `${values.code} is already used. Try ${area}-${suggestion}.`
          : `${values.code} is already used. Choose another property code.`,
        suggestion ? { suggestedCode: `${area}-${suggestion}` } : undefined,
      );
    }
    const [row] = await tx
      .insert(schema.property)
      .values({
        companyId,
        portfolioId: values.portfolioId,
        code: values.code,
        areaCode: area,
        name: values.name,
        propertyType: values.propertyType,
        use: values.use,
        ...values.address,
      })
      .returning({ id: schema.property.id });
    return row!.id;
  }

  /** The owner of a new property: the one named, or a landlord's own owner record. */
  private async ownerFor(tx: Tx, staff: StaffActor, ownerId: string | null): Promise<string> {
    if (ownerId) {
      const [found] = await tx
        .select({ id: schema.owner.id })
        .from(schema.owner)
        .where(and(eq(schema.owner.id, ownerId), isNull(schema.owner.archivedAt)));
      if (!found) throw invalid('owner_unknown', 'Choose an owner from the list');
      return found.id;
    }
    if (staff.companyKind === 'agency')
      throw invalid('owner_required', 'Choose the owner of this property');
    const own = await this.owners.landlordOwner(tx, staff.companyId);
    if (!own) throw invalid('owner_required', 'Choose the owner of this property');
    return own;
  }

  async insertOwnership(
    tx: Tx,
    staff: { companyId: string; personId: string },
    propertyId: string,
    ownerId: string,
    effectiveFrom: string,
  ): Promise<void> {
    await tx.insert(schema.propertyOwnership).values({
      companyId: staff.companyId,
      propertyId,
      ownerId,
      shareBps: WHOLE_PROPERTY_BPS,
      effectiveFrom,
      recordedBy: staff.personId,
    });
  }

  async updateProperty(
    actor: Actor | null,
    propertyId: string,
    patch: {
      readonly name?: string;
      readonly propertyType?: PropertyType;
      readonly use?: PropertyUse;
      readonly portfolioId?: string;
      readonly address?: AddressInput;
    },
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const address = patch.address
        ? await this.checkAddress(tx, staff.companyId, patch.address)
        : {};
      const rows = await tx
        .update(schema.property)
        .set({
          ...(patch.name !== undefined ? { name: checkName(patch.name, 'property') } : {}),
          ...(patch.propertyType ? { propertyType: patch.propertyType } : {}),
          ...(patch.use ? { use: patch.use } : {}),
          ...(patch.portfolioId ? { portfolioId: patch.portfolioId } : {}),
          ...address,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.property.id, propertyId), isNull(schema.property.archivedAt)))
        .returning({ id: schema.property.id });
      if (rows.length === 0) throw notFound('Property');
    });
  }

  /** Archives a property with its blocks and units; codes stay taken. */
  async archiveProperty(actor: Actor | null, propertyId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const now = new Date();
      const rows = await tx
        .update(schema.property)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(eq(schema.property.id, propertyId), isNull(schema.property.archivedAt)))
        .returning({ id: schema.property.id });
      if (rows.length === 0) throw notFound('Property');
      await tx
        .update(schema.unit)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(eq(schema.unit.propertyId, propertyId), isNull(schema.unit.archivedAt)));
      await tx
        .update(schema.block)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(eq(schema.block.propertyId, propertyId), isNull(schema.block.archivedAt)));
    });
  }

  /**
   * Moves a property to another owner from a date (AD-02). The history stays; the date must be
   * later than the last change. From M4a this is refused once the property has ledger entries.
   */
  async changeOwner(
    actor: Actor | null,
    propertyId: string,
    input: { readonly ownerId: string; readonly effectiveFrom: string },
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    const from = parseBusinessDate(input.effectiveFrom);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const [property] = await tx
        .select({ id: schema.property.id })
        .from(schema.property)
        .where(and(eq(schema.property.id, propertyId), isNull(schema.property.archivedAt)));
      if (!property) throw notFound('Property');
      const ownerId = await this.ownerFor(tx, staff, input.ownerId);
      const [latest] = await tx
        .select({ effectiveFrom: sql<string>`max(${schema.propertyOwnership.effectiveFrom})` })
        .from(schema.propertyOwnership)
        .where(eq(schema.propertyOwnership.propertyId, propertyId));
      if (latest?.effectiveFrom && compareDates(from, parseBusinessDate(latest.effectiveFrom)) <= 0)
        throw invalid(
          'ownership_date',
          `Choose a date after ${latest.effectiveFrom}, the last change`,
        );
      await this.insertOwnership(tx, staff, propertyId, ownerId, toIsoDate(from));
    });
  }

  /** Archives an owner who no longer owns any property (AD-02). */
  async archiveOwner(actor: Actor | null, ownerId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const held = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from property_current_ownership c
            join property p on p.company_id = c.company_id and p.id = c.property_id
            where c.owner_id = ${ownerId} and p.archived_at is null`,
      );
      if ((held.rows[0]?.n ?? 0) > 0)
        throw invalid('owner_has_properties', 'Move or archive this owner’s properties first');
      await this.owners.archive(staff, ownerId, tx);
    });
  }

  // Blocks ----------------------------------------------------------------------------------

  async insertBlock(
    tx: Tx,
    companyId: string,
    propertyId: string,
    input: { code: string; name: string | null; isDefault: boolean },
  ): Promise<{ id: string; code: string }> {
    const code = checkBlockCode(input.code);
    try {
      const [row] = await tx
        .insert(schema.block)
        .values({
          companyId,
          propertyId,
          code,
          name: text(input.name, 60),
          isDefault: input.isDefault,
        })
        .returning({ id: schema.block.id, code: schema.block.code });
      return row!;
    } catch (error) {
      if (isUniqueViolation(error, 'block_code_key'))
        throw conflict('block_code_taken', `This property already has a block ${code}`);
      throw error;
    }
  }

  async addBlock(
    actor: Actor | null,
    propertyId: string,
    input: {
      readonly code: string;
      readonly name?: string | null;
      readonly units?: readonly UnitBatch[];
    },
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const property = await this.liveProperty(tx, propertyId);
      const block = await this.insertBlock(tx, staff.companyId, propertyId, {
        code: input.code,
        name: input.name ?? null,
        isDefault: false,
      });
      if (input.units?.length)
        await this.insertUnits(tx, staff.companyId, property, block, input.units);
      return block.id;
    });
  }

  async renameBlock(actor: Actor | null, blockId: string, name: string | null): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    const rows = await withCompany(this.database, staffContext(staff), (tx) =>
      tx
        .update(schema.block)
        .set({ name: text(name, 60), updatedAt: new Date() })
        .where(and(eq(schema.block.id, blockId), isNull(schema.block.archivedAt)))
        .returning({ id: schema.block.id }),
    );
    if (rows.length === 0) throw notFound('Block');
  }

  private async liveProperty(tx: Tx, propertyId: string): Promise<{ id: string; code: string }> {
    const [row] = await tx
      .select({ id: schema.property.id, code: schema.property.code })
      .from(schema.property)
      .where(and(eq(schema.property.id, propertyId), isNull(schema.property.archivedAt)));
    if (!row) throw notFound('Property');
    return row;
  }

  // Units -----------------------------------------------------------------------------------

  /**
   * Creates units in bulk by type and count (PR-01): numbers continue after the highest ever used
   * in the block, archived units included, so a code is never handed out twice.
   */
  async insertUnits(
    tx: Tx,
    companyId: string,
    property: { id: string; code: string },
    block: { id: string; code: string },
    batches: readonly UnitBatch[],
  ): Promise<string[]> {
    const used = await tx
      .select({ label: schema.unit.label })
      .from(schema.unit)
      .where(eq(schema.unit.blockId, block.id));
    const labels = used.map((u) => u.label);
    const values: (typeof schema.unit.$inferInsert)[] = [];
    for (const batch of batches) {
      const bedrooms = checkBedrooms(batch.unitType, batch.bedrooms ?? null);
      const amenities = checkAmenities(batch.amenities ?? []);
      for (const label of nextUnitLabels(labels, batch.count)) {
        labels.push(label);
        values.push({
          companyId,
          propertyId: property.id,
          blockId: block.id,
          code: unitCode(property.code, block.code, label),
          label,
          unitType: batch.unitType,
          bedrooms,
          billingBand: defaultBandFor(batch.unitType),
          amenities,
        });
      }
    }
    if (values.length === 0) return [];
    const rows = await tx.insert(schema.unit).values(values).returning({ id: schema.unit.id });
    return rows.map((r) => r.id);
  }

  async addUnits(
    actor: Actor | null,
    blockId: string,
    batches: readonly UnitBatch[],
  ): Promise<string[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [block] = await tx
        .select({
          id: schema.block.id,
          code: schema.block.code,
          propertyId: schema.block.propertyId,
        })
        .from(schema.block)
        .where(and(eq(schema.block.id, blockId), isNull(schema.block.archivedAt)));
      if (!block) throw notFound('Block');
      const property = await this.liveProperty(tx, block.propertyId);
      return this.insertUnits(tx, staff.companyId, property, block, batches);
    });
  }

  /**
   * Edits a unit. A new type resets the band to that type's default; an override must then be
   * confirmed again (PB-01).
   */
  async updateUnit(
    actor: Actor | null,
    unitId: string,
    patch: {
      readonly unitType?: UnitType;
      readonly bedrooms?: number | null;
      readonly floor?: string | null;
      readonly description?: string | null;
      readonly amenities?: readonly string[];
    },
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const unit = await this.liveUnit(tx, unitId);
      const type = patch.unitType ?? (unit.unitType as UnitType);
      const typeChanged = type !== unit.unitType;
      const bedrooms = checkBedrooms(
        type,
        patch.bedrooms !== undefined ? patch.bedrooms : typeChanged ? null : unit.bedrooms,
      );
      await tx
        .update(schema.unit)
        .set({
          unitType: type,
          bedrooms,
          ...(typeChanged ? { billingBand: defaultBandFor(type), bandOverrideReason: null } : {}),
          ...(patch.floor !== undefined ? { floor: text(patch.floor, 20) } : {}),
          ...(patch.description !== undefined ? { description: text(patch.description, 500) } : {}),
          ...(patch.amenities ? { amenities: checkAmenities(patch.amenities) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.unit.id, unitId));
    });
  }

  /** Changes availability by hand with a reason (PR-06); the history row comes from a trigger. */
  async setAvailability(
    actor: Actor | null,
    unitId: string,
    input: { readonly availability: Availability; readonly reason: string },
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    const reason = checkStatusReason(input.reason);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const unit = await this.liveUnit(tx, unitId, { lock: true });
      // Occupancy is derived from leases from M3; until then no unit is occupied.
      checkAvailabilityChange(unit.availability as Availability, input.availability, {
        occupied: false,
      });
      await this.withStatusReason(tx, reason, 'manual');
      await tx
        .update(schema.unit)
        .set({ availability: input.availability, updatedAt: new Date() })
        .where(eq(schema.unit.id, unitId));
    });
  }

  /** Names the reason and source the history trigger records for this transaction. */
  async withStatusReason(
    tx: Tx,
    reason: string | null,
    source: 'manual' | 'import',
  ): Promise<void> {
    await tx.execute(
      sql`select set_config('app.status_reason', ${reason ?? ''}, true), set_config('app.status_source', ${source}, true)`,
    );
  }

  /** Overrides, or restores, a unit's billing band (PB-01). The reason is audited. */
  async setBand(
    actor: Actor | null,
    unitId: string,
    input: { readonly band: BillingBand; readonly reason?: string | null },
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'unit.band_override');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const unit = await this.liveUnit(tx, unitId);
      const { band, overrideReason } = resolveBand(unit.unitType as UnitType, input);
      await tx
        .update(schema.unit)
        .set({ billingBand: band, bandOverrideReason: overrideReason, updatedAt: new Date() })
        .where(eq(schema.unit.id, unitId));
    });
  }

  /** Archives a unit; its code stays taken (M3 refuses this while a lease is active). */
  async archiveUnit(actor: Actor | null, unitId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      await this.liveUnit(tx, unitId);
      await tx
        .update(schema.unit)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.unit.id, unitId));
    });
  }

  private async liveUnit(tx: Tx, unitId: string, options: { lock?: boolean } = {}) {
    const query = tx
      .select()
      .from(schema.unit)
      .where(and(eq(schema.unit.id, unitId), isNull(schema.unit.archivedAt)));
    const [row] = options.lock ? await query.for('update') : await query;
    if (!row) throw notFound('Unit');
    return row;
  }
}
