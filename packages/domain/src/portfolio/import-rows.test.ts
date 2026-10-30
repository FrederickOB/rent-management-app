import { describe, expect, it } from 'vitest';
import { checkPropertyRows, checkUnitRows } from './import-rows';

const REGIONS = ['Greater Accra', 'Ashanti'];
const SUPPLIERS = { electricity: 'ECG', water: 'Ghana Water' } as const;

const property = (values: Record<string, unknown>, row = 2) => ({
  row,
  values: {
    code: 'ACC-LEG',
    name: 'Legon compound house',
    type: 'Compound house',
    use: 'residential',
    region: 'greater accra',
    ...values,
  },
});

const unit = (values: Record<string, unknown>, row = 2) => ({
  row,
  values: { property: 'acc-leg', label: '01', type: 'Chamber and hall', ...values },
});

describe('PR-08 import rows', () => {
  it('normalises a good property row', () => {
    const { rows, issues } = checkPropertyRows(
      [property({ gps: 'ga 000 0001', latitude: 5.6505, longitude: '-0.1862', owner: 'own-01' })],
      { regions: REGIONS },
    );
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      code: 'ACC-LEG',
      area: 'ACC',
      part: 'LEG',
      type: 'compound_house',
      use: 'residential',
      region: 'Greater Accra',
      gps: 'GA-000-0001',
      ownerReference: 'OWN-01',
      pin: { latitude: '5.6505', longitude: '-0.1862' },
    });
  });

  it('reports every problem in a malformed property sheet by row and column', () => {
    const { rows, issues } = checkPropertyRows(
      [
        property({ code: 'ACCLEG', gps: 'Legon', region: 'Lagos' }, 2),
        property({ code: 'ACC-ELG', name: '', type: 'Castle', latitude: '5.6' }, 3),
        property({}, 4),
        property({}, 5),
      ],
      { regions: REGIONS },
    );
    expect(rows.map((r) => r.row)).toEqual([4]);
    const at = (row: number) => issues.filter((i) => i.row === row).map((i) => i.column);
    expect(at(2)).toEqual(['Property code', 'GhanaPost GPS', 'Region']);
    expect(at(3)).toEqual(['Name', 'Property type', 'Longitude']);
    expect(issues.find((i) => i.row === 5)?.message).toMatch(/already on row 4/);
    expect(issues.every((i) => i.sheet === 'Properties')).toBe(true);
  });

  it('normalises a good unit row, with meters and amenities', () => {
    const { rows, issues } = checkUnitRows(
      [
        unit({
          block: 'b2',
          label: '4',
          amenities: 'Parking; borehole',
          electricityNumber: 'p-123456',
          electricityType: 'Prepaid',
          waterNumber: 'W 778',
          waterType: 'shared',
        }),
      ],
      { defaultSuppliers: SUPPLIERS },
    );
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      code: 'ACC-LEG-B2-04',
      label: '04',
      blockCode: 'B2',
      type: 'chamber_and_hall',
      bedrooms: null,
      amenities: ['parking', 'borehole'],
      availability: 'available',
      meters: [
        { utility: 'electricity', number: 'P-123456', type: 'prepaid', supplier: 'ECG' },
        { utility: 'water', number: 'W 778', type: 'shared', supplier: 'Ghana Water' },
      ],
    });
  });

  it('reports every problem in a malformed unit sheet by row and column', () => {
    const { rows, issues } = checkUnitRows(
      [
        unit({ type: 'Apartment' }, 2),
        unit({ label: '', type: 'Penthouse', property: 'ACC' }, 3),
        unit({ label: '02', amenities: 'Pool', electricityType: 'Prepaid' }, 4),
        unit({ label: '03', availability: 'Vacant' }, 5),
        unit({ label: '04' }, 6),
        unit({ label: '04' }, 7),
      ],
      { defaultSuppliers: SUPPLIERS },
    );
    expect(rows.map((r) => r.row)).toEqual([6]);
    const at = (row: number) => issues.filter((i) => i.row === row).map((i) => i.column);
    expect(at(2)).toEqual(['Bedrooms']);
    expect(at(3)).toEqual(['Property code', 'Unit', 'Unit type']);
    expect(at(4)).toEqual(['Amenities', 'Electricity meter']);
    // "Vacant" is derived from leases and can never be imported (PB-09).
    expect(at(5)).toEqual(['Availability']);
    expect(issues.find((i) => i.row === 7)?.message).toMatch(/already on row 6/);
  });
});
