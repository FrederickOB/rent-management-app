import type { PropertyFileRow, RegisterImportRow } from '@rent/contracts';
import {
  AVAILABILITY_LABELS,
  checkBedrooms,
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUSES,
  UNIT_TYPE_LABELS,
  type DisplayStatus,
  type OwnerKind,
  type PropertyUse,
  type UnitType,
  type Utility,
} from '@rent/domain/portfolio';
import { isRecord } from './errors';
import { humanise } from './format';

/** Display names for the register (PR-01 to PR-09). What a value means is decided in packages/domain. */
export const PROPERTY_USE_LABELS: Record<PropertyUse, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  mixed: 'Mixed',
};

export const UTILITY_LABELS: Record<Utility, string> = {
  electricity: 'Electricity',
  water: 'Water',
};

export const OWNER_KIND_LABELS: Record<OwnerKind, string> = {
  individual: 'Individual',
  company: 'Company',
};

export type FileCategory = PropertyFileRow['category'];

export const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
  photo: 'Photo',
  title_or_indenture: 'Title or indenture',
  site_plan: 'Site plan',
  building_permit: 'Building permit',
  other: 'Other paper',
};

/** Papers are every category except photos (PR-04; M2 decision 4 says who may see them). */
export const PAPER_CATEGORIES = [
  'title_or_indenture',
  'site_plan',
  'building_permit',
  'other',
] as const satisfies readonly FileCategory[];

export const IMPORT_STATUS_LABELS: Record<RegisterImportRow['status'], string> = {
  uploaded: 'Uploaded',
  validating: 'Checking the file',
  validated: 'Checked: ready to import',
  invalid: 'Problems found',
  committing: 'Importing',
  committed: 'Imported',
  failed: 'Failed',
};

const SOURCE_LABELS: Record<string, string> = {
  created: 'When the unit was created',
  manual: 'Changed by hand',
  import: 'Spreadsheet import',
  lease: 'Lease',
};

export function statusSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? humanise(source);
}

/** A status history value (availability, or occupancy from M3) in words. */
export function statusValueLabel(value: string | null): string {
  if (value === null) return 'None';
  if (value in AVAILABILITY_LABELS)
    return AVAILABILITY_LABELS[value as keyof typeof AVAILABILITY_LABELS];
  if (value in DISPLAY_STATUS_LABELS) return DISPLAY_STATUS_LABELS[value as DisplayStatus];
  return humanise(value);
}

const percent = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/** An ownership share in basis points as a percentage: 10,000 is `100%`, 3,333 is `33.33%`. */
export function shareLabel(shareBps: number): string {
  return `${percent.format(shareBps / 100)}%`;
}

/** Town, district and region, leaving out the parts that are not known. */
export function locationLabel(place: {
  readonly town?: string | null;
  readonly district?: string | null;
  readonly region?: string | null;
}): string {
  return [place.town, place.district, place.region].filter(Boolean).join(', ') || 'No location';
}

/** Non-zero counts by status in their usual order, such as `3 vacant, 1 under repair`. */
export function countsSummary(counts: Readonly<Record<DisplayStatus, number>>): string {
  const parts = DISPLAY_STATUSES.filter((status) => counts[status] > 0).map(
    (status) => `${counts[status]} ${DISPLAY_STATUS_LABELS[status].toLowerCase()}`,
  );
  return parts.length ? parts.join(', ') : 'No units';
}

export function totalOf(counts: Readonly<Record<DisplayStatus, number>>): number {
  return DISPLAY_STATUSES.reduce((sum, status) => sum + counts[status], 0);
}

/** `Apartment, 2 bedrooms`, or just the type when bedrooms do not apply. */
export function unitTypeLabel(type: UnitType, bedrooms?: number | null): string {
  const label = UNIT_TYPE_LABELS[type];
  if (bedrooms == null) return label;
  return `${label}, ${bedrooms} ${bedrooms === 1 ? 'bedroom' : 'bedrooms'}`;
}

export type BedroomsRule = 'required' | 'optional' | 'none';

/**
 * Whether a unit type takes bedrooms (PR-02), asked of the domain's own check so the form and
 * the API agree: required for apartments, optional for houses, absent for everything else.
 */
export function bedroomsRule(type: UnitType): BedroomsRule {
  try {
    checkBedrooms(type, null);
  } catch {
    return 'required';
  }
  try {
    checkBedrooms(type, 1);
    return 'optional';
  } catch {
    return 'none';
  }
}

/** The message of a domain check, or null when the value passes. */
export function domainProblem(check: () => unknown): string | null {
  try {
    check();
    return null;
  } catch (error) {
    if (isRecord(error) && typeof error.message === 'string') return error.message;
    return 'This value is not valid';
  }
}

/** Codes from the API arrive upper-cased (`PROPERTY_CODE_TAKEN`); compare them without case. */
export function hasCode(code: string | null, wanted: string): boolean {
  return code !== null && code.toLowerCase() === wanted.toLowerCase();
}
