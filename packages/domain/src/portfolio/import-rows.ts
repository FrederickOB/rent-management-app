import { DomainError } from '../errors';
import { checkGhanaPostGps, checkMapPin, type MapPin } from './address';
import {
  checkAreaCode,
  checkBlockCode,
  checkPropertyPart,
  checkUnitLabel,
  DEFAULT_BLOCK_CODE,
  parsePropertyCode,
} from './codes';
import {
  checkAmenities,
  checkMeterNumber,
  checkSupplier,
  METER_TYPES,
  METER_TYPE_LABELS,
  type Amenity,
  type MeterType,
  type Utility,
} from './features';
import { checkOwnerReference } from './owners';
import { AVAILABILITY, AVAILABILITY_LABELS, type Availability } from './status';
import {
  checkBedrooms,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  PROPERTY_USES,
  UNIT_TYPES,
  UNIT_TYPE_LABELS,
  type PropertyType,
  type PropertyUse,
  type UnitType,
} from './unit-types';

/**
 * The register import (PR-08): the sheets and columns of the template, and the checks every row
 * must pass before anything is written. Database checks (owners, codes already taken) are added
 * by the server. Row numbers are spreadsheet rows: the header is row 1.
 */
export const PROPERTY_COLUMNS = [
  { key: 'code', header: 'Property code', required: true, example: 'ACC-LEG' },
  { key: 'name', header: 'Name', required: true, example: 'Legon compound house' },
  { key: 'type', header: 'Property type', required: true, example: 'Compound house' },
  { key: 'use', header: 'Use', required: true, example: 'Residential' },
  { key: 'owner', header: 'Owner reference', required: false, example: 'OWN-01' },
  { key: 'gps', header: 'GhanaPost GPS', required: false, example: 'GA-183-8164' },
  { key: 'region', header: 'Region', required: true, example: 'Greater Accra' },
  { key: 'district', header: 'District', required: false, example: '' },
  { key: 'mmda', header: 'MMDA', required: false, example: '' },
  { key: 'town', header: 'Town', required: false, example: 'Legon' },
  { key: 'street', header: 'Street or landmark', required: false, example: '' },
  { key: 'latitude', header: 'Latitude', required: false, example: '5.6505' },
  { key: 'longitude', header: 'Longitude', required: false, example: '-0.1862' },
] as const;

export const UNIT_COLUMNS = [
  { key: 'property', header: 'Property code', required: true, example: 'ACC-LEG' },
  { key: 'block', header: 'Block code', required: false, example: 'B1' },
  { key: 'blockName', header: 'Block name', required: false, example: '' },
  { key: 'label', header: 'Unit', required: true, example: '01' },
  { key: 'type', header: 'Unit type', required: true, example: 'Chamber and hall' },
  { key: 'bedrooms', header: 'Bedrooms', required: false, example: '' },
  { key: 'amenities', header: 'Amenities', required: false, example: 'Parking, Borehole' },
  { key: 'floor', header: 'Floor', required: false, example: 'Ground' },
  { key: 'description', header: 'Description', required: false, example: '' },
  { key: 'availability', header: 'Availability', required: false, example: 'Available' },
  { key: 'electricityNumber', header: 'Electricity meter', required: false, example: '' },
  { key: 'electricityType', header: 'Electricity meter type', required: false, example: 'Prepaid' },
  { key: 'electricitySupplier', header: 'Electricity supplier', required: false, example: 'ECG' },
  { key: 'waterNumber', header: 'Water meter', required: false, example: '' },
  { key: 'waterType', header: 'Water meter type', required: false, example: 'Postpaid' },
  { key: 'waterSupplier', header: 'Water supplier', required: false, example: 'Ghana Water' },
] as const;

export const IMPORT_SHEETS = { properties: 'Properties', units: 'Units', lists: 'Lists' } as const;
export const MAX_IMPORT_UNIT_ROWS = 5_000;
export const MAX_IMPORT_PROPERTY_ROWS = 1_000;

export type PropertyColumn = (typeof PROPERTY_COLUMNS)[number]['key'];
export type UnitColumn = (typeof UNIT_COLUMNS)[number]['key'];

export interface ImportIssue {
  readonly sheet: string;
  /** Spreadsheet row; null for a problem with the whole sheet. */
  readonly row: number | null;
  readonly column: string | null;
  readonly message: string;
}

export interface PropertyImportRow {
  readonly row: number;
  readonly code: string;
  readonly area: string;
  readonly part: string;
  readonly name: string;
  readonly type: PropertyType;
  readonly use: PropertyUse;
  readonly ownerReference: string | null;
  readonly gps: string | null;
  readonly region: string;
  readonly district: string | null;
  readonly mmda: string | null;
  readonly town: string | null;
  readonly street: string | null;
  readonly pin: MapPin | null;
}

export interface MeterImportValue {
  readonly utility: Utility;
  readonly number: string;
  readonly type: MeterType;
  readonly supplier: string;
}

/** Optional unit cells whose blank means "leave it as it is" for a unit that already exists. */
export type UnitOptionalCell = 'bedrooms' | 'amenities' | 'floor' | 'description' | 'availability';

export interface UnitImportRow {
  readonly row: number;
  readonly propertyCode: string;
  readonly blockCode: string;
  readonly blockName: string | null;
  readonly label: string;
  /** The full unit code the row describes. */
  readonly code: string;
  readonly type: UnitType;
  /** The values below are what a new unit gets: blank cells take the defaults. */
  readonly bedrooms: number | null;
  readonly amenities: Amenity[];
  readonly floor: string | null;
  readonly description: string | null;
  readonly availability: Availability;
  readonly meters: MeterImportValue[];
  /** The optional cells left blank, which an existing unit keeps as they are (PR-08). */
  readonly blankCells: readonly UnitOptionalCell[];
}

/** A cell as trimmed text; numbers keep their digits, empty cells are null. */
export function cellText(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return text.length ? text : null;
}

/** Matches a list value by its id or its label, ignoring case and spacing. */
function fromList<T extends string>(
  text: string,
  values: readonly T[],
  labels: Record<T, string>,
): T | null {
  const wanted = text
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
  return (
    values.find(
      (v) =>
        v.replace(/_/g, ' ') === wanted ||
        labels[v].toLowerCase().replace(/[\s_-]+/g, ' ') === wanted,
    ) ?? null
  );
}

const USE_LABELS: Record<PropertyUse, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  mixed: 'Mixed',
};

class RowReader {
  readonly issues: ImportIssue[] = [];
  constructor(
    private readonly sheet: string,
    private readonly row: number,
    private readonly values: Readonly<Record<string, unknown>>,
    private readonly headers: Readonly<Record<string, string>>,
  ) {}

  problem(column: string | null, message: string): void {
    this.issues.push({
      sheet: this.sheet,
      row: this.row,
      column: column ? (this.headers[column] ?? column) : null,
      message,
    });
  }

  text(column: string, required: boolean, max = 120): string | null {
    const text = cellText(this.values[column]);
    if (!text) {
      if (required) this.problem(column, 'Required');
      return null;
    }
    if (text.length > max) {
      this.problem(column, `At most ${max} characters`);
      return null;
    }
    return text;
  }

  /** Runs a domain check; a DomainError becomes an issue on this cell. */
  check<T>(column: string, fn: () => T): T | null {
    try {
      return fn();
    } catch (error) {
      if (error instanceof DomainError) {
        this.problem(column, error.message);
        return null;
      }
      throw error;
    }
  }

  oneOf<T extends string>(
    column: string,
    required: boolean,
    values: readonly T[],
    labels: Record<T, string>,
  ): T | null {
    const text = this.text(column, required);
    if (!text) return null;
    const value = fromList(text, values, labels);
    if (!value) this.problem(column, `Use one of the values on the Lists sheet`);
    return value;
  }
}

const headersOf = (columns: readonly { key: string; header: string }[]) =>
  Object.fromEntries(columns.map((c) => [c.key, c.header]));

export function checkPropertyRows(
  rows: readonly { row: number; values: Readonly<Record<string, unknown>> }[],
  options: { readonly regions: readonly string[] },
): { rows: PropertyImportRow[]; issues: ImportIssue[] } {
  const headers = headersOf(PROPERTY_COLUMNS);
  const out: PropertyImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Map<string, number>();
  if (rows.length > MAX_IMPORT_PROPERTY_ROWS)
    issues.push({
      sheet: IMPORT_SHEETS.properties,
      row: null,
      column: null,
      message: `At most ${MAX_IMPORT_PROPERTY_ROWS} properties per file`,
    });
  for (const { row, values } of rows) {
    const r = new RowReader(IMPORT_SHEETS.properties, row, values, headers);
    const codeText = r.text('code', true, 9);
    let code: { area: string; part: string; code: string } | null = null;
    if (codeText) {
      const [area = '', part = '', ...rest] = codeText.toUpperCase().split('-');
      if (rest.length) r.problem('code', 'A property code has two parts, such as ACC-LEG');
      else {
        const a = r.check('code', () => checkAreaCode(area));
        const p = a ? r.check('code', () => checkPropertyPart(part)) : null;
        if (a && p) code = { area: a, part: p, code: `${a}-${p}` };
      }
    }
    if (code) {
      const first = seen.get(code.code);
      if (first) r.problem('code', `Property ${code.code} is already on row ${first}`);
      else seen.set(code.code, row);
    }
    const name = r.text('name', true, 120);
    const type = r.oneOf('type', true, PROPERTY_TYPES, PROPERTY_TYPE_LABELS);
    const use = r.oneOf('use', true, PROPERTY_USES, USE_LABELS);
    const ownerText = r.text('owner', false, 20);
    const ownerReference = ownerText
      ? r.check('owner', () => checkOwnerReference(ownerText))
      : null;
    const gpsText = r.text('gps', false, 20);
    const gps = gpsText ? r.check('gps', () => checkGhanaPostGps(gpsText)) : null;
    const regionText = r.text('region', true, 60);
    const region = regionText
      ? (options.regions.find((x) => x.toLowerCase() === regionText.toLowerCase()) ?? null)
      : null;
    if (regionText && !region) r.problem('region', 'Use a region from the Lists sheet');
    const latitude = cellText(values.latitude);
    const longitude = cellText(values.longitude);
    let pin: MapPin | null = null;
    if (latitude || longitude) {
      if (!latitude || !longitude)
        r.problem(latitude ? 'longitude' : 'latitude', 'Give both latitude and longitude');
      else pin = r.check('latitude', () => checkMapPin(latitude, longitude));
    }
    const district = r.text('district', false, 80);
    const mmda = r.text('mmda', false, 80);
    const town = r.text('town', false, 80);
    const street = r.text('street', false, 160);
    issues.push(...r.issues);
    if (r.issues.length || !code || !name || !type || !use || !region) continue;
    out.push({
      row,
      code: code.code,
      area: code.area,
      part: code.part,
      name,
      type,
      use,
      ownerReference,
      gps: gps ?? null,
      region,
      district,
      mmda,
      town,
      street,
      pin,
    });
  }
  return { rows: out, issues };
}

const METER_COLUMNS = [
  {
    utility: 'electricity',
    number: 'electricityNumber',
    type: 'electricityType',
    supplier: 'electricitySupplier',
  },
  { utility: 'water', number: 'waterNumber', type: 'waterType', supplier: 'waterSupplier' },
] as const;

export function checkUnitRows(
  rows: readonly { row: number; values: Readonly<Record<string, unknown>> }[],
  options: { readonly defaultSuppliers: Readonly<Record<Utility, string>> },
): { rows: UnitImportRow[]; issues: ImportIssue[] } {
  const headers = headersOf(UNIT_COLUMNS);
  const out: UnitImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Map<string, number>();
  if (rows.length > MAX_IMPORT_UNIT_ROWS)
    issues.push({
      sheet: IMPORT_SHEETS.units,
      row: null,
      column: null,
      message: `At most ${MAX_IMPORT_UNIT_ROWS} units per file`,
    });
  for (const { row, values } of rows) {
    const r = new RowReader(IMPORT_SHEETS.units, row, values, headers);
    const propertyText = r.text('property', true, 9);
    const propertyCode = propertyText ? propertyText.toUpperCase() : null;
    if (propertyCode && !parsePropertyCode(propertyCode))
      r.problem('property', 'Use a property code such as ACC-LEG');
    const blockText = r.text('block', false, 3);
    const blockCode = r.check('block', () => checkBlockCode(blockText ?? DEFAULT_BLOCK_CODE));
    const blockName = r.text('blockName', false, 60);
    const labelText = r.text('label', true, 4);
    const label = labelText ? r.check('label', () => checkUnitLabel(labelText)) : null;
    const type = r.oneOf('type', true, UNIT_TYPES, UNIT_TYPE_LABELS);
    const bedroomsText = cellText(values.bedrooms);
    let bedrooms: number | null = null;
    if (type) {
      const parsed = bedroomsText == null ? null : Number(bedroomsText);
      if (bedroomsText != null && !Number.isInteger(parsed))
        r.problem('bedrooms', 'Enter a whole number');
      else bedrooms = r.check('bedrooms', () => checkBedrooms(type, parsed)) ?? null;
    }
    const amenitiesText = cellText(values.amenities);
    const amenities = amenitiesText
      ? (r.check('amenities', () => checkAmenities(amenitiesText.split(/[,;]/))) ?? [])
      : [];
    const floor = r.text('floor', false, 20);
    const description = r.text('description', false, 500);
    const availability =
      r.oneOf('availability', false, AVAILABILITY, AVAILABILITY_LABELS) ?? 'available';
    const meters: MeterImportValue[] = [];
    for (const m of METER_COLUMNS) {
      const numberText = cellText(values[m.number]);
      const typeText = cellText(values[m.type]);
      if (!numberText && !typeText) continue;
      const number = numberText ? r.check(m.number, () => checkMeterNumber(numberText)) : null;
      if (!numberText) r.problem(m.number, 'Give the meter number, or leave the type empty');
      const meterType = r.oneOf(m.type, true, METER_TYPES, METER_TYPE_LABELS);
      const supplierText = cellText(values[m.supplier]) ?? options.defaultSuppliers[m.utility];
      const supplier = r.check(m.supplier, () => checkSupplier(supplierText));
      if (number && meterType && supplier)
        meters.push({ utility: m.utility, number, type: meterType, supplier });
    }
    const code =
      propertyCode && blockCode && label ? `${propertyCode}-${blockCode}-${label}` : null;
    if (code) {
      const first = seen.get(code);
      if (first) r.problem('label', `Unit ${code} is already on row ${first}`);
      else seen.set(code, row);
    }
    issues.push(...r.issues);
    if (r.issues.length || !code || !propertyCode || !blockCode || !label || !type) continue;
    const blankCells = UNIT_OPTIONAL_CELLS.filter((cell) => cellText(values[cell]) == null);
    out.push({
      row,
      propertyCode,
      blockCode,
      blockName,
      label,
      code,
      type,
      bedrooms,
      amenities,
      floor,
      description,
      availability,
      meters,
      blankCells,
    });
  }
  return { rows: out, issues };
}

const UNIT_OPTIONAL_CELLS: readonly UnitOptionalCell[] = [
  'bedrooms',
  'amenities',
  'floor',
  'description',
  'availability',
];

/** The property fields an import row can change (PR-08). */
export interface PropertyImportFields {
  readonly name: string;
  readonly type: PropertyType;
  readonly use: PropertyUse;
  readonly gps: string | null;
  readonly region: string;
  readonly district: string | null;
  readonly mmda: string | null;
  readonly town: string | null;
  readonly street: string | null;
  readonly pin: MapPin | null;
}

/**
 * What a row leaves on a property that already exists (PR-08). A blank optional cell keeps the
 * property's value, so re-importing a sheet with empty columns never wipes an address or a pin.
 * Required cells (name, type, use, region) always come from the row.
 */
export function propertyFieldsAfterImport(
  existing: PropertyImportFields,
  row: PropertyImportRow,
): PropertyImportFields {
  return {
    name: row.name,
    type: row.type,
    use: row.use,
    region: row.region,
    gps: row.gps ?? existing.gps,
    district: row.district ?? existing.district,
    mmda: row.mmda ?? existing.mmda,
    town: row.town ?? existing.town,
    street: row.street ?? existing.street,
    pin: row.pin ?? existing.pin,
  };
}

/** The unit fields an import row can change (PR-08). */
export interface UnitImportFields {
  readonly type: UnitType;
  readonly bedrooms: number | null;
  readonly amenities: readonly Amenity[];
  readonly floor: string | null;
  readonly description: string | null;
  readonly availability: Availability;
}

/**
 * What a row leaves on a unit that already exists (PR-08). A blank optional cell keeps the unit's
 * value: an empty Availability column never resets a unit under repair to available. Blank
 * bedrooms keep the count while it still fits the unit type, and clear it when it does not.
 */
export function unitFieldsAfterImport(
  existing: UnitImportFields,
  row: UnitImportRow,
): UnitImportFields {
  const blank = (cell: UnitOptionalCell) => row.blankCells.includes(cell);
  let bedrooms = row.bedrooms;
  if (blank('bedrooms')) {
    try {
      bedrooms = checkBedrooms(row.type, existing.bedrooms);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      bedrooms = null;
    }
  }
  return {
    type: row.type,
    bedrooms,
    amenities: blank('amenities') ? existing.amenities : row.amenities,
    floor: blank('floor') ? existing.floor : row.floor,
    description: blank('description') ? existing.description : row.description,
    availability: blank('availability') ? existing.availability : row.availability,
  };
}
