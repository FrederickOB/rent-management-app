import { Inject, Injectable } from '@nestjs/common';
import {
  addToPropertyScope,
  and,
  eq,
  isNull,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
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
  checkUnitsPerRequest,
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
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../core/clock';
import { isUniqueViolation, sqlStateOf, withRegisterChecks } from '../core/db-errors';
import { conflict, forbidden, invalid, notFound } from '../core/errors';
import { ADDRESS_LOOKUP_PORT, CLOCK, DATABASE } from '../core/tokens';
import { staffActor } from '../companies/companies.service';
import { OwnersService } from '../companies/owners.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { propertyHasLedger } from './ownership';
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

/** Said to a scoped person who names an owner outside their scope (AD-02). */
const OUTSIDE_SCOPE = 'You can add and move properties only for the owners you manage';

const unitsIn = (batches: readonly UnitBatch[] | undefined) => (batches ?? []).map((b) => b.count);

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
    checkUnitsPerRequest([
      ...unitsIn(input.blocks?.length ? undefined : input.units),
      ...(input.blocks ?? []).flatMap((b) => unitsIn(b.units)),
    ]);
    return withRegisterChecks(() => this.createPropertyIn(staff, input, code, name));
  }

  private createPropertyIn(staff: StaffActor, input: NewProperty, code: string, name: string) {
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

  /**
   * Inserts a property, turning a taken code into a conflict with a free suggestion. In a scoped
   * session the new id joins the transaction's scope first, so the restrictive scope policy lets
   * it, its ownership, blocks and units be written (AD-02); callers check the owner beforehand.
   */
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
    const id = uuidv7();
    await addToPropertyScope(tx, id);
    try {
      await tx.insert(schema.property).values({
        id,
        companyId,
        portfolioId: values.portfolioId,
        code: values.code,
        areaCode: area,
        name: values.name,
        propertyType: values.propertyType,
        use: values.use,
        ...values.address,
      });
    } catch (error) {
      // Taken at the same moment by someone else, or by a property this person cannot see.
      if (isUniqueViolation(error, 'property_code_key'))
        throw conflict(
          'property_code_taken',
          `${values.code} is already used. Choose another property code.`,
        );
      throw error;
    }
    return id;
  }

  /**
   * The owner of a new property: the one named, or a landlord's own owner record. A scoped person
   * may name only an owner in their scope (AD-02); otherwise the request is refused.
   */
  private async ownerFor(tx: Tx, staff: StaffActor, ownerId: string | null): Promise<string> {
    const scope = this.policy.scopeFor(staff);
    if (ownerId) {
      if (scope && !scope.ownerIds.includes(ownerId)) throw forbidden(OUTSIDE_SCOPE);
      const [found] = await tx
        .select({ id: schema.owner.id })
        .from(schema.owner)
        .where(and(eq(schema.owner.id, ownerId), isNull(schema.owner.archivedAt)));
      if (!found) throw invalid('owner_unknown', 'Choose an owner from the list');
      return found.id;
    }
    if (staff.companyKind === 'agency')
      throw invalid('owner_required', 'Choose the owner of this property');
    if (scope && scope.ownerIds.length === 0) throw forbidden(OUTSIDE_SCOPE);
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
    await withRegisterChecks(() =>
      withCompany(this.database, staffContext(staff), async (tx) => {
        // Locked, so two changes at once cannot both pass the date check and double the shares.
        const [property] = await tx
          .select({ id: schema.property.id })
          .from(schema.property)
          .where(and(eq(schema.property.id, propertyId), isNull(schema.property.archivedAt)))
          .for('update');
        if (!property) throw notFound('Property');
        const ownerId = await this.ownerFor(tx, staff, input.ownerId);
        await this.refuseOnceBilled(tx, staff.companyId, propertyId);
        const [latest] = await tx
          .select({ effectiveFrom: sql<string>`max(${schema.propertyOwnership.effectiveFrom})` })
          .from(schema.propertyOwnership)
          .where(
            and(
              eq(schema.propertyOwnership.propertyId, propertyId),
              sql`not exists (select 1 from property_ownership_correction c
                  where c.company_id = ${schema.propertyOwnership.companyId}
                    and c.ownership_id = ${schema.propertyOwnership.id})`,
            ),
          );
        if (
          latest?.effectiveFrom &&
          compareDates(from, parseBusinessDate(latest.effectiveFrom)) <= 0
        )
          throw invalid(
            'ownership_date',
            `Choose a date after ${latest.effectiveFrom}, the last change`,
          );
        await this.insertOwnership(tx, staff, propertyId, ownerId, toIsoDate(from));
      }),
    ).catch(ownerFixedError);
  }

  /**
   * Corrects a property's owner on the same date (M2 deferred S5; M4a decision 6): the latest
   * ownership rows are superseded by the right owner from the same day, so a property filed under
   * the wrong owner stops showing to that owner's people at once. Only before the property has
   * any invoice, payment or ledger entry; after that, owner changes wait for a transfer flow.
   */
  async correctOwner(
    actor: Actor | null,
    propertyId: string,
    input: { readonly ownerId: string; readonly reason: string },
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    const reason = input.reason.trim();
    if (reason.length < 5) throw invalid('reason_required', 'Say why the owner is being corrected');
    await withRegisterChecks(() =>
      withCompany(this.database, staffContext(staff), async (tx) => {
        const [property] = await tx
          .select({ id: schema.property.id })
          .from(schema.property)
          .where(and(eq(schema.property.id, propertyId), isNull(schema.property.archivedAt)))
          .for('update');
        if (!property) throw notFound('Property');
        const ownerId = await this.ownerFor(tx, staff, input.ownerId);
        await this.refuseOnceBilled(tx, staff.companyId, propertyId);
        const latest = await tx.execute<{ id: string; owner_id: string; effective_from: string }>(
          sql`select po.id, po.owner_id, po.effective_from::text from property_ownership po
              where po.property_id = ${propertyId}
                and not exists (select 1 from property_ownership_correction c
                                where c.company_id = po.company_id and c.ownership_id = po.id)
                and po.effective_from = (
                  select max(p2.effective_from) from property_ownership p2
                  where p2.company_id = po.company_id and p2.property_id = po.property_id
                    and not exists (select 1 from property_ownership_correction c2
                                    where c2.company_id = p2.company_id and c2.ownership_id = p2.id))`,
        );
        const rows = latest.rows;
        if (rows.length === 0) throw notFound('Ownership');
        if (rows.length === 1 && rows[0]!.owner_id === ownerId)
          throw invalid('owner_unchanged', 'That owner is already the owner on record');
        await tx.insert(schema.propertyOwnershipCorrection).values(
          rows.map((r) => ({
            companyId: staff.companyId,
            propertyId,
            ownershipId: r.id,
            reason: reason.slice(0, 300),
            correctedBy: staff.personId,
          })),
        );
        await this.insertOwnership(tx, staff, propertyId, ownerId, rows[0]!.effective_from);
      }),
    ).catch(ownerFixedError);
  }

  /** Decision 6: once a property has ledger entries, its owner stays until a transfer flow exists. */
  private async refuseOnceBilled(tx: Tx, companyId: string, propertyId: string): Promise<void> {
    if (await propertyHasLedger(tx, companyId, propertyId)) throw ownerFixed();
  }

  /**
   * Archives an owner who owns no property today and takes none over later (AD-02): a change of
   * owner dated in the future still needs them.
   */
  async archiveOwner(actor: Actor | null, ownerId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const held = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from property p
            where p.archived_at is null and (
              exists (select 1 from property_current_ownership c
                      where c.company_id = p.company_id and c.property_id = p.id
                        and c.owner_id = ${ownerId})
              or exists (select 1 from property_ownership o
                         where o.company_id = p.company_id and o.property_id = p.id
                           and o.owner_id = ${ownerId} and o.effective_from > current_date
                           and not exists (select 1 from property_ownership_correction c
                                           where c.company_id = o.company_id and c.ownership_id = o.id)))`,
      );
      if ((held.rows[0]?.n ?? 0) > 0)
        throw invalid(
          'owner_has_properties',
          'Move or archive this owner’s properties first, including any they take over on a later date',
        );
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
    checkUnitsPerRequest(unitsIn(input.units));
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
   * in the block, archived units included, so a code is never handed out twice. The block row is
   * locked first, so two requests numbering the same block take turns.
   */
  async insertUnits(
    tx: Tx,
    companyId: string,
    property: { id: string; code: string },
    block: { id: string; code: string },
    batches: readonly UnitBatch[],
  ): Promise<string[]> {
    await tx
      .select({ id: schema.block.id })
      .from(schema.block)
      .where(eq(schema.block.id, block.id))
      .for('update');
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
    try {
      const rows = await tx.insert(schema.unit).values(values).returning({ id: schema.unit.id });
      return rows.map((r) => r.id);
    } catch (error) {
      if (isUniqueViolation(error, 'unit_code_key') || isUniqueViolation(error, 'unit_label_key'))
        throw conflict(
          'unit_numbers_taken',
          'Someone added units to this block at the same time. Reload the page and try again.',
        );
      throw error;
    }
  }

  async addUnits(
    actor: Actor | null,
    blockId: string,
    batches: readonly UnitBatch[],
  ): Promise<string[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    checkUnitsPerRequest(unitsIn(batches));
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
      // Occupancy comes from leases (PB-09): a unit a lease holds, reserved or occupied, stays
      // available or under repair. The database refuses anything else as well.
      checkAvailabilityChange(unit.availability as Availability, input.availability, {
        occupied: await this.heldByLease(tx, unitId),
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

  /** Archives a unit; its code stays taken. Refused while a lease holds it (PB-09). */
  async archiveUnit(actor: Actor | null, unitId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      await this.liveUnit(tx, unitId);
      if (await this.heldByLease(tx, unitId))
        throw conflict('unit_has_lease', 'This unit has a lease, so it cannot be archived');
      await tx
        .update(schema.unit)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.unit.id, unitId));
    });
  }

  /**
   * Whether a lease holds the unit (out for signature, signed, active, ending or holding over),
   * from the view the tenancy migration publishes. A lease waiting for signatures holds it too,
   * so its signing never finds the unit archived or not lettable (M3 review finding 2).
   */
  private async heldByLease(tx: Tx, unitId: string): Promise<boolean> {
    const result = await tx.execute<{ held: boolean }>(
      sql`select exists (select 1 from unit_lease_hold where unit_id = ${unitId}) as held`,
    );
    return result.rows[0]?.held === true;
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

const ownerFixed = () =>
  conflict(
    'owner_fixed',
    'This property already has invoices or payments, so its owner cannot change until ownership transfers are supported',
  );

/** The database's refusal of an owner change on a billed property (RA045), as a clear conflict. */
function ownerFixedError(error: unknown): never {
  if (sqlStateOf(error) === 'RA045') throw ownerFixed();
  throw error;
}
