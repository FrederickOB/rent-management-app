import type { PropertyRowView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  filterOptions,
  filtersFromQuery,
  pageInfo,
  PAGE_SIZE,
  propertyListInput,
  queryFromFilters,
  unitListInput,
  withFilter,
  type UnitFilters,
} from './portfolio-filters';

const OWNER_A = '019a3000-0000-7000-8000-00000000000a';
const OWNER_B = '019a3000-0000-7000-8000-00000000000b';
const LEG = '019a3000-0000-7000-8000-000000000101';
const OSU = '019a3000-0000-7000-8000-000000000102';

const counts = { occupied: 0, reserved: 0, under_repair: 0, not_lettable: 0, vacant: 0 };
const property = (
  id: string,
  code: string,
  owner: { id: string; reference: string; displayName: string } | null,
  region: string,
  district: string | null,
): PropertyRowView => ({
  id,
  code,
  name: `${code} name`,
  propertyType: 'compound_house',
  use: 'residential',
  region,
  district,
  town: null,
  owner,
  unitCount: 0,
  counts,
  archived: false,
});

describe('PRD section 5 portfolio filters', () => {
  it('round-trips every filter through the address bar', () => {
    const filters: UnitFilters = {
      ownerId: OWNER_A,
      region: 'Greater Accra',
      district: 'Ga East',
      propertyId: LEG,
      unitType: 'chamber_and_hall',
      status: 'vacant',
      search: 'B1',
      page: 3,
    };
    const query = queryFromFilters('units', filters);
    expect(filtersFromQuery(new URLSearchParams(query))).toEqual({ tab: 'units', filters });
    expect(filtersFromQuery(new URLSearchParams(queryFromFilters('properties', filters)))).toEqual({
      tab: 'properties',
      filters: { ...filters, page: 1 },
    });
  });

  it('leaves defaults out of the address bar', () => {
    expect(queryFromFilters('units', EMPTY_FILTERS)).toBe('');
    expect(queryFromFilters('properties', EMPTY_FILTERS)).toBe('tab=properties');
  });

  it('drops values that are not valid instead of sending them to the API', () => {
    const { tab, filters } = filtersFromQuery({
      tab: 'nonsense',
      owner: 'not-an-id',
      property: "1' or '1'='1",
      type: 'castle',
      status: 'occupied-ish',
      page: '-2',
      q: ['  Legon  ', 'ignored'],
    });
    expect(tab).toBe('units');
    expect(filters).toEqual({ ...EMPTY_FILTERS, search: 'Legon' });
  });

  it('maps pages to limit and offset, and leaves out empty filters', () => {
    expect(unitListInput({ ...EMPTY_FILTERS, page: 3, status: 'under_repair' })).toEqual({
      status: 'under_repair',
      limit: PAGE_SIZE,
      offset: 2 * PAGE_SIZE,
    });
    expect(
      propertyListInput({ ...EMPTY_FILTERS, ownerId: OWNER_B, unitType: 'shop', search: ' ' }),
    ).toEqual({ ownerId: OWNER_B });
  });

  it('goes back to page 1 and clears the filters that depended on a change', () => {
    const start: UnitFilters = {
      ...EMPTY_FILTERS,
      region: 'Greater Accra',
      district: 'Ga East',
      propertyId: LEG,
      page: 4,
    };
    expect(withFilter(start, 'region', 'Ashanti')).toMatchObject({
      region: 'Ashanti',
      district: '',
      propertyId: '',
      page: 1,
    });
    expect(withFilter(start, 'ownerId', OWNER_A)).toMatchObject({
      district: 'Ga East',
      propertyId: '',
    });
    expect(withFilter(start, 'status', 'vacant')).toMatchObject({ propertyId: LEG, page: 1 });
  });

  it('offers only owners, places and properties that exist, narrowed by the wider choices', () => {
    const rows = [
      property(
        LEG,
        'ACC-LEG',
        { id: OWNER_A, reference: 'OWN-01', displayName: 'Ama' },
        'Greater Accra',
        'Ga East',
      ),
      property(
        OSU,
        'ACC-OSU',
        { id: OWNER_B, reference: 'OWN-02', displayName: 'Nana' },
        'Greater Accra',
        null,
      ),
      property(
        '019a3000-0000-7000-8000-000000000103',
        'KSI-AHO',
        { id: OWNER_A, reference: 'OWN-01', displayName: 'Ama' },
        'Ashanti',
        'Kumasi',
      ),
    ];
    const all = filterOptions(rows, EMPTY_FILTERS);
    expect(all.owners.map((o) => o.label)).toEqual(['Ama (OWN-01)', 'Nana (OWN-02)']);
    expect(all.regions.map((r) => r.value)).toEqual(['Ashanti', 'Greater Accra']);
    expect(all.districts.map((d) => d.value)).toEqual(['Ga East', 'Kumasi']);
    expect(all.properties).toHaveLength(3);

    const accra = filterOptions(rows, { ...EMPTY_FILTERS, region: 'Greater Accra' });
    expect(accra.districts.map((d) => d.value)).toEqual(['Ga East']);
    expect(accra.properties.map((p) => p.value)).toEqual([LEG, OSU]);

    const ownerB = filterOptions(rows, { ...EMPTY_FILTERS, ownerId: OWNER_B });
    expect(ownerB.properties.map((p) => p.value)).toEqual([OSU]);
    // The owner list itself never narrows, so another owner can still be chosen.
    expect(ownerB.owners).toHaveLength(2);
  });

  it('describes the page shown', () => {
    expect(pageInfo(0, 1)).toMatchObject({ pages: 1, label: 'No units' });
    expect(pageInfo(245, 1)).toMatchObject({ from: 1, to: 100, pages: 3, label: '1–100 of 245' });
    expect(pageInfo(245, 3)).toMatchObject({ from: 201, to: 245, label: '201–245 of 245' });
  });
});
