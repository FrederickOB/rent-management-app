import type { PropertyRowView } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import {
  DISPLAY_STATUSES,
  UNIT_TYPES,
  type DisplayStatus,
  type UnitType,
} from '@rent/domain/portfolio';

/**
 * The portfolio screen's filters (PRD section 5 story; M2 plan 4.11). They live in the address
 * bar, so a filtered list can be bookmarked or shared, and map onto the API's list inputs.
 */
export type PortfolioTab = 'units' | 'properties';

export interface UnitFilters {
  readonly ownerId: string;
  readonly region: string;
  readonly district: string;
  readonly propertyId: string;
  readonly unitType: UnitType | '';
  readonly status: DisplayStatus | '';
  readonly search: string;
  /** 1-based page of PAGE_SIZE units. */
  readonly page: number;
}

export const PAGE_SIZE = 100;
const MAX_PAGE = 10_000;

export const EMPTY_FILTERS: UnitFilters = {
  ownerId: '',
  region: '',
  district: '',
  propertyId: '',
  unitType: '',
  status: '',
  search: '',
  page: 1,
};

export type UnitListInput = NonNullable<Parameters<ApiClient['register']['listUnits']>[0]>;
export type PropertyListInput = NonNullable<Parameters<ApiClient['register']['listProperties']>[0]>;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Query = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

function read(query: Query, key: string): string {
  if (query instanceof URLSearchParams) return query.get(key) ?? '';
  const value = query[key];
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
}

const text = (value: string, max: number) => value.trim().slice(0, max);
const oneOf = <T extends string>(value: string, values: readonly T[]): T | '' =>
  (values as readonly string[]).includes(value) ? (value as T) : '';

/** Reads the filters from the address bar, dropping anything that is not a valid value. */
export function filtersFromQuery(query: Query): { tab: PortfolioTab; filters: UnitFilters } {
  const page = Number.parseInt(read(query, 'page'), 10);
  const owner = read(query, 'owner');
  const property = read(query, 'property');
  return {
    tab: read(query, 'tab') === 'properties' ? 'properties' : 'units',
    filters: {
      ownerId: ID.test(owner) ? owner.toLowerCase() : '',
      region: text(read(query, 'region'), 60),
      district: text(read(query, 'district'), 80),
      propertyId: ID.test(property) ? property.toLowerCase() : '',
      unitType: oneOf(read(query, 'type'), UNIT_TYPES),
      status: oneOf(read(query, 'status'), DISPLAY_STATUSES),
      search: text(read(query, 'q'), 80),
      page: Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1,
    },
  };
}

/**
 * The query string for a tab and its filters. Empty values and defaults are left out; filters
 * that only apply to units are kept on the properties tab, so switching back loses nothing.
 */
export function queryFromFilters(tab: PortfolioTab, filters: UnitFilters): string {
  const params = new URLSearchParams();
  if (tab === 'properties') params.set('tab', 'properties');
  if (filters.ownerId) params.set('owner', filters.ownerId);
  if (filters.region) params.set('region', filters.region);
  if (filters.district) params.set('district', filters.district);
  if (filters.propertyId) params.set('property', filters.propertyId);
  if (filters.unitType) params.set('type', filters.unitType);
  if (filters.status) params.set('status', filters.status);
  if (filters.search.trim()) params.set('q', filters.search.trim());
  if (tab === 'units' && filters.page > 1) params.set('page', String(filters.page));
  return params.toString();
}

/** The API input for the units list: every filter, and the page as limit and offset. */
export function unitListInput(filters: UnitFilters): UnitListInput {
  return {
    ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
    ...(filters.region ? { region: filters.region } : {}),
    ...(filters.district ? { district: filters.district } : {}),
    ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
    ...(filters.unitType ? { unitType: filters.unitType } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    limit: PAGE_SIZE,
    offset: (filters.page - 1) * PAGE_SIZE,
  };
}

/** The API input for the properties list: the filters that apply to properties. */
export function propertyListInput(filters: UnitFilters): PropertyListInput {
  return {
    ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
    ...(filters.region ? { region: filters.region } : {}),
    ...(filters.district ? { district: filters.district } : {}),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
  };
}

/**
 * One filter changed: back to the first page, and the filters that depended on it are cleared
 * (a district belongs to a region; a property to an owner, region and district).
 */
export function withFilter<K extends keyof Omit<UnitFilters, 'page'>>(
  filters: UnitFilters,
  key: K,
  value: UnitFilters[K],
): UnitFilters {
  const next: UnitFilters = { ...filters, [key]: value, page: 1 };
  if (key === 'region') return { ...next, district: '', propertyId: '' };
  if (key === 'district' || key === 'ownerId') return { ...next, propertyId: '' };
  return next;
}

export interface Option {
  readonly value: string;
  readonly label: string;
}

export interface FilterOptions {
  readonly owners: readonly Option[];
  readonly regions: readonly Option[];
  readonly districts: readonly Option[];
  readonly properties: readonly Option[];
}

const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label);

/**
 * Choices for the filter selects, from the properties this person can see: only owners,
 * places and properties that exist appear, and narrower lists follow the wider choices.
 */
export function filterOptions(
  properties: readonly PropertyRowView[],
  filters: UnitFilters,
): FilterOptions {
  const owners = new Map<string, Option>();
  const regions = new Set<string>();
  const districts = new Set<string>();
  const matching: Option[] = [];
  for (const p of properties) {
    if (p.owner)
      owners.set(p.owner.id, {
        value: p.owner.id,
        label: `${p.owner.displayName} (${p.owner.reference})`,
      });
    regions.add(p.region);
    if (p.district && (!filters.region || p.region === filters.region)) districts.add(p.district);
    if (filters.ownerId && p.owner?.id !== filters.ownerId) continue;
    if (filters.region && p.region !== filters.region) continue;
    if (filters.district && p.district !== filters.district) continue;
    matching.push({ value: p.id, label: `${p.code} · ${p.name}` });
  }
  const sorted = (values: Set<string>) =>
    [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
  return {
    owners: [...owners.values()].sort(byLabel),
    regions: sorted(regions),
    districts: sorted(districts),
    properties: matching.sort(byLabel),
  };
}

/** `101–200 of 245` for the page shown, and how many pages there are. */
export function pageInfo(
  total: number,
  page: number,
): { from: number; to: number; pages: number; label: string } {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total === 0) return { from: 0, to: 0, pages, label: 'No units' };
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  return { from, to, pages, label: `${from}–${to} of ${total}` };
}
