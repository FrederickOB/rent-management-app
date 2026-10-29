import type { ApiClient } from '@rent/contracts/client';
import {
  checkAreaCode,
  checkBlockCode,
  checkGhanaPostGps,
  checkMapPin,
  checkPropertyPart,
  DEFAULT_BLOCK_CODE,
  MAX_BULK_UNITS,
  nextUnitLabels,
  normaliseCodePart,
  normaliseGhanaPostGps,
  parsePropertyCode,
  propertyCode,
  suggestAreaCode,
  suggestPropertyPart,
  unitCode,
  type Amenity,
  type PropertyType,
  type PropertyUse,
  type UnitType,
} from '@rent/domain/portfolio';
import { isRecord } from './errors';
import { bedroomsRule, domainProblem } from './register-format';

/**
 * The new-property wizard (PR-01, PR-03; PRD section 5: a 12-room compound house in under ten
 * minutes). The draft is plain data; these functions check each step and build the one API
 * call that creates the property with its blocks and units.
 */
export const WIZARD_STEPS = ['details', 'address', 'units', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const STEP_LABELS: Record<WizardStep, string> = {
  details: 'Details',
  address: 'Address',
  units: 'Blocks and units',
  review: 'Review and create',
};

export const MAX_BATCHES = 20;
export const MAX_BLOCKS = 50;

export interface BatchDraft {
  readonly key: string;
  readonly count: string;
  readonly unitType: UnitType | '';
  readonly bedrooms: string;
  readonly amenities: readonly Amenity[];
}

export interface BlockDraft {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly batches: readonly BatchDraft[];
}

export interface WizardDraft {
  readonly name: string;
  readonly propertyType: PropertyType | '';
  readonly use: PropertyUse | '';
  readonly portfolioId: string;
  readonly ownerId: string;
  readonly town: string;
  readonly areaCode: string;
  readonly propertyPart: string;
  /** Once someone types a code part it no longer follows the town or the name. */
  readonly areaEdited: boolean;
  readonly partEdited: boolean;
  readonly useEdited: boolean;
  readonly ghanapostGps: string;
  readonly region: string;
  readonly district: string;
  readonly mmda: string;
  readonly street: string;
  readonly latitude: string;
  readonly longitude: string;
  readonly addressSource: 'lookup' | 'manual';
  /** `single`: every unit in the default block B1. `blocks`: blocks or floors, each with units. */
  readonly layout: 'single' | 'blocks';
  readonly batches: readonly BatchDraft[];
  readonly blocks: readonly BlockDraft[];
}

let lastKey = 0;
/** Keys for list items in the form; they never leave the browser. */
export const nextKey = (): string => {
  lastKey += 1;
  return `k${lastKey}`;
};

export const newBatch = (unitType: UnitType | '' = ''): BatchDraft => ({
  key: nextKey(),
  count: '1',
  unitType,
  bedrooms: '',
  amenities: [],
});

export const newBlock = (code: string, batches?: readonly BatchDraft[]): BlockDraft => ({
  key: nextKey(),
  code,
  name: '',
  batches: batches ?? [newBatch()],
});

export function newDraft(defaults: { portfolioId: string; ownerId: string }): WizardDraft {
  return {
    name: '',
    propertyType: '',
    use: '',
    portfolioId: defaults.portfolioId,
    ownerId: defaults.ownerId,
    town: '',
    areaCode: '',
    propertyPart: '',
    areaEdited: false,
    partEdited: false,
    useEdited: false,
    ghanapostGps: '',
    region: '',
    district: '',
    mmda: '',
    street: '',
    latitude: '',
    longitude: '',
    addressSource: 'manual',
    layout: 'single',
    batches: [newBatch()],
    blocks: [],
  };
}

// Conveniences for a quick start; the person can change every one of them.
const USE_FOR: Record<PropertyType, PropertyUse> = {
  apartment_block: 'residential',
  house: 'residential',
  compound_house: 'residential',
  shop: 'commercial',
  office: 'commercial',
  warehouse: 'commercial',
  mixed_use: 'mixed',
  gated_estate: 'residential',
};

const UNIT_FOR: Record<PropertyType, UnitType> = {
  apartment_block: 'apartment',
  house: 'detached_house',
  compound_house: 'single_room',
  shop: 'shop',
  office: 'office',
  warehouse: 'warehouse',
  mixed_use: 'shop',
  gated_estate: 'detached_house',
};

/** Letters and digits only, in capitals, as codes are stored (M2 plan 4.3). */
export function codeInput(value: string, max: number): string {
  return normaliseCodePart(value)
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, max);
}

export function setName(draft: WizardDraft, name: string): WizardDraft {
  if (draft.partEdited) return { ...draft, name };
  return { ...draft, name, propertyPart: name.trim() ? suggestPropertyPart(name) : '' };
}

export function setTown(draft: WizardDraft, town: string): WizardDraft {
  if (draft.areaEdited) return { ...draft, town };
  return { ...draft, town, areaCode: town.trim() ? suggestAreaCode(town) : '' };
}

export function setAreaCode(draft: WizardDraft, value: string): WizardDraft {
  const areaCode = codeInput(value, 4).replace(/[0-9]/g, '');
  return { ...draft, areaCode, areaEdited: areaCode !== '' };
}

export function setPropertyPart(draft: WizardDraft, value: string): WizardDraft {
  const propertyPart = codeInput(value, 4);
  return { ...draft, propertyPart, partEdited: propertyPart !== '' };
}

/** A new type suggests a use, and a unit type for any batch that has none yet. */
export function setPropertyType(draft: WizardDraft, type: PropertyType | ''): WizardDraft {
  if (!type) return { ...draft, propertyType: '' };
  const fill = (batches: readonly BatchDraft[]) =>
    batches.map((b) => (b.unitType ? b : { ...b, unitType: UNIT_FOR[type] }));
  return {
    ...draft,
    propertyType: type,
    use: draft.useEdited ? draft.use : USE_FOR[type],
    batches: fill(draft.batches),
    blocks: draft.blocks.map((block) => ({ ...block, batches: fill(block.batches) })),
  };
}

/** The unit type a new batch starts with. */
export const suggestedUnitType = (draft: WizardDraft): UnitType | '' =>
  draft.propertyType ? UNIT_FOR[draft.propertyType] : '';

/** Switching layout carries the units across, so nothing typed is lost. */
export function setLayout(draft: WizardDraft, layout: 'single' | 'blocks'): WizardDraft {
  if (layout === draft.layout) return draft;
  if (layout === 'blocks') {
    const blocks = draft.blocks.length
      ? draft.blocks
      : [newBlock(DEFAULT_BLOCK_CODE, draft.batches)];
    return { ...draft, layout, blocks };
  }
  const batches = draft.batches.length
    ? draft.batches
    : (draft.blocks[0]?.batches ?? [newBatch(suggestedUnitType(draft))]);
  return { ...draft, layout, batches };
}

/** The next free block code after B1, B2… (custom codes such as G or F1 are skipped over). */
export function nextBlockCode(blocks: readonly { readonly code: string }[]): string {
  const taken = new Set(blocks.map((b) => normaliseCodePart(b.code)));
  for (let n = 1; n < 100; n += 1) if (!taken.has(`B${n}`)) return `B${n}`;
  return '';
}

export type DetailsErrors = Partial<
  Record<'name' | 'propertyType' | 'use' | 'ownerId' | 'areaCode' | 'propertyPart', string>
>;

export function detailsErrors(
  draft: WizardDraft,
  options: { readonly ownerRequired: boolean },
): DetailsErrors {
  const errors: DetailsErrors = {};
  const name = draft.name.trim();
  if (name.length < 2 || name.length > 120) errors.name = 'Enter a name of 2 to 120 characters';
  if (!draft.propertyType) errors.propertyType = 'Choose the type of property';
  if (!draft.use) errors.use = 'Choose how the property is used';
  if (options.ownerRequired && !draft.ownerId) errors.ownerId = 'Choose the owner';
  const area = domainProblem(() => checkAreaCode(draft.areaCode));
  if (area) errors.areaCode = area;
  const part = domainProblem(() => checkPropertyPart(draft.propertyPart));
  if (part) errors.propertyPart = part;
  return errors;
}

export type AddressErrors = Partial<Record<'ghanapostGps' | 'region' | 'latitude', string>>;

/** Checks the address fields of the wizard, or of the edit form on the property page. */
export function addressErrors(
  draft: Pick<WizardDraft, 'ghanapostGps' | 'region' | 'latitude' | 'longitude'>,
  regions: readonly string[],
): AddressErrors {
  const errors: AddressErrors = {};
  if (draft.ghanapostGps.trim()) {
    const gps = domainProblem(() => checkGhanaPostGps(draft.ghanapostGps));
    if (gps) errors.ghanapostGps = gps;
  }
  if (!regions.includes(draft.region)) errors.region = 'Choose the region';
  const lat = draft.latitude.trim();
  const lng = draft.longitude.trim();
  if (lat || lng) {
    if (!lat || !lng) errors.latitude = 'Give both latitude and longitude, or neither';
    else {
      const pin = domainProblem(() => checkMapPin(lat, lng));
      if (pin) errors.latitude = pin;
    }
  }
  return errors;
}

export interface BatchErrors {
  readonly count?: string;
  readonly unitType?: string;
  readonly bedrooms?: string;
}

export interface BlockErrors {
  readonly code?: string;
  readonly batches: readonly BatchErrors[];
}

/** The blocks the draft will create: B1 alone, or the blocks listed. */
export function blocksOf(draft: WizardDraft): readonly BlockDraft[] {
  if (draft.layout === 'single')
    return [{ key: 'single', code: DEFAULT_BLOCK_CODE, name: '', batches: draft.batches }];
  return draft.blocks;
}

const parseCount = (text: string): number | null =>
  /^\d{1,3}$/.test(text.trim()) ? Number.parseInt(text.trim(), 10) : null;
const parseBedrooms = (text: string): number | null =>
  /^\d{1,2}$/.test(text.trim()) ? Number.parseInt(text.trim(), 10) : null;

export function batchErrors(batch: BatchDraft): BatchErrors {
  const errors: { count?: string; unitType?: string; bedrooms?: string } = {};
  const count = parseCount(batch.count);
  if (count === null || count < 1 || count > MAX_BULK_UNITS)
    errors.count = `Enter a number from 1 to ${MAX_BULK_UNITS}`;
  if (!batch.unitType) errors.unitType = 'Choose the unit type';
  else {
    const rule = bedroomsRule(batch.unitType);
    const bedrooms = batch.bedrooms.trim();
    if (rule === 'required' && !bedrooms) errors.bedrooms = 'Enter the bedrooms';
    else if (rule !== 'none' && bedrooms) {
      const value = parseBedrooms(bedrooms);
      const max = rule === 'required' ? 5 : 20;
      if (value === null || value < 1 || value > max)
        errors.bedrooms = `Enter a number from 1 to ${max}`;
    }
  }
  return errors;
}

/** Problems with the blocks and units, or null when there are none. */
export function unitsErrors(draft: WizardDraft): readonly BlockErrors[] | null {
  const blocks = blocksOf(draft);
  const seen = new Set<string>();
  let failed = false;
  const errors = blocks.map((block): BlockErrors => {
    let code = domainProblem(() => checkBlockCode(block.code)) ?? undefined;
    const normalised = normaliseCodePart(block.code);
    if (!code && seen.has(normalised)) code = `Block ${normalised} is listed twice`;
    seen.add(normalised);
    const batches = block.batches.map(batchErrors);
    if (code || batches.some((b) => Object.keys(b).length > 0)) failed = true;
    return code ? { code, batches } : { batches };
  });
  return failed ? errors : null;
}

export interface PreviewUnit {
  readonly code: string;
  readonly unitType: UnitType;
  readonly bedrooms: number | null;
}

export interface PreviewBlock {
  readonly code: string;
  readonly name: string | null;
  readonly units: readonly PreviewUnit[];
}

export interface CodePreview {
  readonly propertyCode: string;
  readonly blocks: readonly PreviewBlock[];
  readonly total: number;
}

/**
 * The codes the API will issue (M2 plan 4.3): a new block numbers its units 01, 02… across its
 * batches in order, so 6 single rooms then 6 chamber and hall are B1-01 to -06, then -07 to -12.
 * Null while any part of the draft is not valid yet.
 */
export function previewCodes(draft: WizardDraft): CodePreview | null {
  if (unitsErrors(draft)) return null;
  try {
    const code = propertyCode(draft.areaCode, draft.propertyPart);
    let total = 0;
    const blocks = blocksOf(draft).map((block): PreviewBlock => {
      const used: string[] = [];
      const units: PreviewUnit[] = [];
      for (const batch of block.batches) {
        if (!batch.unitType) continue;
        const bedrooms =
          bedroomsRule(batch.unitType) === 'none' ? null : parseBedrooms(batch.bedrooms);
        for (const label of nextUnitLabels(used, parseCount(batch.count) ?? 0)) {
          used.push(label);
          units.push({
            code: unitCode(code, block.code, label),
            unitType: batch.unitType,
            bedrooms,
          });
        }
      }
      total += units.length;
      return { code: normaliseCodePart(block.code), name: block.name.trim() || null, units };
    });
    return { propertyCode: code, blocks, total };
  } catch {
    return null;
  }
}

/** `ACC-LEG-B1-01 to ACC-LEG-B1-12`, or the one code, for a run of codes. */
export function codeRange(codes: readonly string[]): string {
  if (codes.length === 0) return 'No units';
  if (codes.length === 1) return codes[0]!;
  return `${codes[0]} to ${codes[codes.length - 1]}`;
}

export type CreatePropertyInput = Parameters<ApiClient['register']['createProperty']>[0];
type UnitBatchInput = NonNullable<CreatePropertyInput['units']>[number];

function batchInput(batch: BatchDraft): UnitBatchInput {
  const unitType = batch.unitType as UnitType;
  const rule = bedroomsRule(unitType);
  const bedrooms = rule === 'none' ? null : parseBedrooms(batch.bedrooms);
  return {
    unitType,
    count: parseCount(batch.count) ?? 0,
    ...(rule === 'none' ? {} : { bedrooms }),
    ...(batch.amenities.length ? { amenities: [...batch.amenities] } : {}),
  };
}

/** Batches as the API takes them, for adding units to an existing block. */
export function toBatchInputs(batches: readonly BatchDraft[]): UnitBatchInput[] {
  return batches.map(batchInput);
}

/** True when any batch has a problem. */
export const batchesInvalid = (batches: readonly BatchDraft[]): boolean =>
  batches.some((batch) => Object.keys(batchErrors(batch)).length > 0);

/** How many units a list of batches creates (invalid counts count as none). */
export const unitTotal = (batches: readonly BatchDraft[]): number =>
  batches.reduce((sum, batch) => sum + (parseCount(batch.count) ?? 0), 0);

const orNull = (value: string): string | null => value.trim() || null;

/** The one call that creates the property, its blocks and its units (POST /properties). */
export function toCreateInput(draft: WizardDraft): CreatePropertyInput {
  const gps = draft.ghanapostGps.trim();
  const base: CreatePropertyInput = {
    portfolioId: orNull(draft.portfolioId),
    areaCode: draft.areaCode,
    propertyPart: draft.propertyPart,
    name: draft.name.trim(),
    propertyType: draft.propertyType as PropertyType,
    use: draft.use as PropertyUse,
    ownerId: orNull(draft.ownerId),
    address: {
      ghanapostGps: gps ? normaliseGhanaPostGps(gps) : null,
      region: draft.region,
      district: orNull(draft.district),
      mmda: orNull(draft.mmda),
      town: orNull(draft.town),
      street: orNull(draft.street),
      latitude: orNull(draft.latitude),
      longitude: orNull(draft.longitude),
      source: draft.addressSource,
    },
  };
  if (draft.layout === 'single') {
    const units = draft.batches.map(batchInput);
    return units.length ? { ...base, units } : base;
  }
  return {
    ...base,
    blocks: draft.blocks.map((block) => ({
      code: normaliseCodePart(block.code),
      name: orNull(block.name),
      ...(block.batches.length ? { units: block.batches.map(batchInput) } : {}),
    })),
  };
}

export interface ProblemPlace {
  readonly step: WizardStep;
  readonly field?: keyof DetailsErrors | keyof AddressErrors;
}

const PLACES: Record<string, ProblemPlace> = {
  property_code_taken: { step: 'details', field: 'propertyPart' },
  'code.invalid_area': { step: 'details', field: 'areaCode' },
  'code.invalid_property': { step: 'details', field: 'propertyPart' },
  owner_required: { step: 'details', field: 'ownerId' },
  owner_unknown: { step: 'details', field: 'ownerId' },
  property_name: { step: 'details', field: 'name' },
  address_region: { step: 'address', field: 'region' },
  address_pin: { step: 'address', field: 'latitude' },
  'address.pin_invalid': { step: 'address', field: 'latitude' },
  'address.gps_invalid': { step: 'address', field: 'ghanapostGps' },
  'code.invalid_block': { step: 'units' },
  block_code_taken: { step: 'units' },
  'unit.bedrooms_required': { step: 'units' },
  'unit.bedrooms_range': { step: 'units' },
  'unit.bedrooms_not_applicable': { step: 'units' },
  'unit.bulk_count': { step: 'units' },
  'unit.amenity_unknown': { step: 'units' },
};

/** Where an API refusal belongs in the wizard, so its message shows next to the field. */
export function placeOfProblem(code: string | null): ProblemPlace | null {
  return code ? (PLACES[code.toLowerCase()] ?? null) : null;
}

/**
 * The free code the API offers when a property code is taken (PROPERTY_CODE_TAKEN carries it as
 * `data.suggestedCode`, such as ACC-LEG2), or null when it found none.
 */
export function suggestedPropertyCode(error: unknown): { area: string; part: string } | null {
  const data = isRecord(error) && isRecord(error.data) ? error.data : null;
  const parsed =
    typeof data?.suggestedCode === 'string' ? parsePropertyCode(data.suggestedCode) : null;
  return parsed ? { area: parsed.area, part: parsed.property } : null;
}
