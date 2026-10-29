import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  eq,
  inArray,
  isNull,
  notInArray,
  schema,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import {
  checkMeterNumber,
  checkMeterUnits,
  checkSupplier,
  type MeterType,
  type Utility,
} from '@rent/domain/portfolio';
import { isUniqueViolation } from '../core/db-errors';
import { conflict, invalid, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { staffActor } from '../companies/companies.service';
import { PolicyService, staffContext } from '../policy/policy.service';

export interface MeterInput {
  readonly utility: Utility;
  readonly supplier: string;
  readonly meterNumber: string;
  readonly meterType: MeterType;
  readonly notes?: string | null;
  readonly unitIds?: readonly string[];
}

const taken = () =>
  conflict('meter_number_taken', 'Another meter from this supplier already has that number');

/** Electricity and water meters (PR-05). A shared meter may serve several units. */
@Injectable()
export class MetersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  async add(actor: Actor | null, propertyId: string, input: MeterInput): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    const unitIds = [...new Set(input.unitIds ?? [])];
    checkMeterUnits(input.meterType, unitIds.length);
    try {
      return await withCompany(this.database, staffContext(staff), async (tx) => {
        const meterId = await this.insert(tx, staff.companyId, propertyId, input);
        await this.link(tx, staff.companyId, propertyId, meterId, unitIds);
        return meterId;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'meter_number_key')) throw taken();
      throw error;
    }
  }

  /** Inserts a meter; the import uses this inside its own transaction. */
  async insert(tx: Tx, companyId: string, propertyId: string, input: MeterInput): Promise<string> {
    const [row] = await tx
      .insert(schema.meter)
      .values({
        companyId,
        propertyId,
        utility: input.utility,
        supplier: checkSupplier(input.supplier),
        meterNumber: checkMeterNumber(input.meterNumber),
        meterType: input.meterType,
        notes: input.notes?.trim() || null,
      })
      .returning({ id: schema.meter.id });
    return row!.id;
  }

  async link(
    tx: Tx,
    companyId: string,
    propertyId: string,
    meterId: string,
    unitIds: readonly string[],
  ): Promise<void> {
    if (unitIds.length === 0) return;
    try {
      await tx
        .insert(schema.unitMeter)
        .values(unitIds.map((unitId) => ({ companyId, propertyId, meterId, unitId })))
        .onConflictDoNothing();
    } catch (error) {
      // The composite foreign key refuses a unit from another property.
      if ((error as { cause?: { code?: string } }).cause?.code === '23503')
        throw invalid('meter_unit', 'A meter can only serve units in its own property');
      throw error;
    }
  }

  async update(
    actor: Actor | null,
    meterId: string,
    patch: Partial<Omit<MeterInput, 'utility' | 'unitIds'>>,
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    try {
      await withCompany(this.database, staffContext(staff), async (tx) => {
        const meter = await this.live(tx, meterId);
        if (patch.meterType && patch.meterType !== meter.meterType) {
          const links = await tx
            .select({ id: schema.unitMeter.id })
            .from(schema.unitMeter)
            .where(eq(schema.unitMeter.meterId, meterId));
          checkMeterUnits(patch.meterType, links.length);
        }
        await tx
          .update(schema.meter)
          .set({
            ...(patch.supplier !== undefined ? { supplier: checkSupplier(patch.supplier) } : {}),
            ...(patch.meterNumber !== undefined
              ? { meterNumber: checkMeterNumber(patch.meterNumber) }
              : {}),
            ...(patch.meterType ? { meterType: patch.meterType } : {}),
            ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.meter.id, meterId));
      });
    } catch (error) {
      if (isUniqueViolation(error, 'meter_number_key')) throw taken();
      throw error;
    }
  }

  /** Sets exactly which units a meter serves. */
  async setUnits(actor: Actor | null, meterId: string, unitIds: readonly string[]): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    const wanted = [...new Set(unitIds)];
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const meter = await this.live(tx, meterId);
      checkMeterUnits(meter.meterType as MeterType, wanted.length);
      await tx
        .delete(schema.unitMeter)
        .where(
          and(
            eq(schema.unitMeter.meterId, meterId),
            wanted.length ? notInArray(schema.unitMeter.unitId, wanted) : undefined,
          ),
        );
      if (wanted.length) {
        const units = await tx
          .select({ id: schema.unit.id })
          .from(schema.unit)
          .where(and(inArray(schema.unit.id, wanted), isNull(schema.unit.archivedAt)));
        if (units.length !== wanted.length)
          throw invalid('meter_unit', 'Choose units from the list');
      }
      await this.link(tx, staff.companyId, meter.propertyId, meterId, wanted);
    });
  }

  async archive(actor: Actor | null, meterId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      await this.live(tx, meterId);
      await tx.delete(schema.unitMeter).where(eq(schema.unitMeter.meterId, meterId));
      await tx
        .update(schema.meter)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.meter.id, meterId));
    });
  }

  private async live(tx: Tx, meterId: string) {
    const [row] = await tx
      .select()
      .from(schema.meter)
      .where(and(eq(schema.meter.id, meterId), isNull(schema.meter.archivedAt)));
    if (!row) throw notFound('Meter');
    return row;
  }
}
