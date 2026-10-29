import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkUnitsPerRequest, MAX_UNITS_PER_REQUEST } from './codes';
import {
  checkPropertyRows,
  checkUnitRows,
  propertyFieldsAfterImport,
  unitFieldsAfterImport,
  type PropertyImportFields,
  type UnitImportFields,
} from './import-rows';

const REGIONS = ['Greater Accra', 'Ashanti'];
const SUPPLIERS = { electricity: 'ECG', water: 'Ghana Water' } as const;

const property = (values: Record<string, unknown>) =>
  checkPropertyRows(
    [
      {
        row: 2,
        values: {
          code: 'TEM-EST',
          name: 'Tema estate house',
          type: 'House',
          use: 'Residential',
          region: 'Greater Accra',
          ...values,
        },
      },
    ],
    { regions: REGIONS },
  ).rows[0]!;

const unit = (values: Record<string, unknown>) =>
  checkUnitRows(
    [{ row: 2, values: { property: 'TEM-EST', label: '01', type: 'Detached house', ...values } }],
    { defaultSuppliers: SUPPLIERS },
  ).rows[0]!;

const EXISTING_PROPERTY: PropertyImportFields = {
  name: 'Tema estate house',
  type: 'house',
  use: 'residential',
  gps: 'GT-000-0001',
  region: 'Greater Accra',
  district: 'Tema Metropolitan',
  mmda: 'TMA',
  town: 'Tema',
  street: 'Community 25',
  pin: { latitude: '5.6698', longitude: '-0.0166' },
};

const EXISTING_UNIT: UnitImportFields = {
  type: 'detached_house',
  bedrooms: 4,
  amenities: ['parking', 'borehole'],
  floor: 'Ground',
  description: 'Four-bedroom house',
  availability: 'under_repair',
};

describe('PR-08 re-import with blank cells', () => {
  it("leaves an existing property's optional fields as they are when their cells are blank", () => {
    expect(propertyFieldsAfterImport(EXISTING_PROPERTY, property({}))).toEqual(EXISTING_PROPERTY);
  });

  it('takes every cell that is filled in, required cells included', () => {
    const next = propertyFieldsAfterImport(
      EXISTING_PROPERTY,
      property({ name: 'Renamed', town: 'Sakumono', latitude: '5.61', longitude: '-0.05' }),
    );
    expect(next).toEqual({
      ...EXISTING_PROPERTY,
      name: 'Renamed',
      town: 'Sakumono',
      pin: { latitude: '5.61', longitude: '-0.05' },
    });
  });

  it("leaves an existing unit's availability, amenities, floor and description when blank", () => {
    const row = unit({});
    // A new unit still gets the defaults.
    expect(row).toMatchObject({ availability: 'available', amenities: [], floor: null });
    expect(row.blankCells).toEqual([
      'bedrooms',
      'amenities',
      'floor',
      'description',
      'availability',
    ]);
    expect(unitFieldsAfterImport(EXISTING_UNIT, row)).toEqual(EXISTING_UNIT);
  });

  it('takes the unit cells that are filled in', () => {
    const row = unit({ amenities: 'Solar', availability: 'Available', floor: 'First' });
    expect(row.blankCells).toEqual(['bedrooms', 'description']);
    expect(unitFieldsAfterImport(EXISTING_UNIT, row)).toEqual({
      ...EXISTING_UNIT,
      amenities: ['solar'],
      availability: 'available',
      floor: 'First',
    });
  });

  it('keeps blank bedrooms while they fit the unit type, and clears them when they do not', () => {
    expect(unitFieldsAfterImport(EXISTING_UNIT, unit({ type: 'Townhouse' })).bedrooms).toBe(4);
    expect(unitFieldsAfterImport(EXISTING_UNIT, unit({ type: 'Single room' })).bedrooms).toBe(null);
    expect(unitFieldsAfterImport(EXISTING_UNIT, unit({ bedrooms: 3 })).bedrooms).toBe(3);
  });
});

describe('PR-01 bulk creation limits', () => {
  it(`allows up to ${MAX_UNITS_PER_REQUEST} units in one request, across all its batches`, () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 200 }), { maxLength: 60 }), (counts) => {
        const total = counts.reduce((sum, n) => sum + n, 0);
        if (total <= MAX_UNITS_PER_REQUEST)
          expect(() => checkUnitsPerRequest(counts)).not.toThrow();
        else expect(() => checkUnitsPerRequest(counts)).toThrow(/at most 5,000 units/);
      }),
    );
    expect(() => checkUnitsPerRequest([MAX_UNITS_PER_REQUEST])).not.toThrow();
    expect(() => checkUnitsPerRequest([MAX_UNITS_PER_REQUEST, 1])).toThrow(
      expect.objectContaining({ code: 'unit.too_many' }),
    );
  });
});
