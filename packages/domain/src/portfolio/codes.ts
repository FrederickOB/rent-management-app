import { DomainError } from '../errors';

/**
 * Unit codes (M2 plan section 4.3, decision 1): AREA-PROP-BLOCK-UNIT, for example ACC-LEG-B2-04.
 * Codes are unique within a company, never changed once issued and never reused.
 */
const PARTS = {
  area: { pattern: /^[A-Z]{2,4}$/, rule: '2 to 4 letters' },
  property: { pattern: /^[A-Z0-9]{2,4}$/, rule: '2 to 4 letters or digits' },
  block: { pattern: /^[A-Z0-9]{1,3}$/, rule: '1 to 3 letters or digits' },
  unit: { pattern: /^[A-Z0-9]{1,4}$/, rule: '1 to 4 letters or digits' },
} as const;
type Part = keyof typeof PARTS;

export const DEFAULT_BLOCK_CODE = 'B1';

/** Codes are typed in any case and stored in capitals, without spaces. */
export function normaliseCodePart(input: string): string {
  return input.trim().toUpperCase();
}

function checkPart(part: Part, input: string): string {
  const value = normaliseCodePart(input);
  if (!PARTS[part].pattern.test(value))
    throw new DomainError(`code.invalid_${part}`, `The ${part} code must be ${PARTS[part].rule}`);
  return value;
}

export const checkAreaCode = (input: string) => checkPart('area', input);
export const checkPropertyPart = (input: string) => checkPart('property', input);
export const checkBlockCode = (input: string) => checkPart('block', input);

/** Unit numbers have two digits at least, so 4, 04 and 004 are the same unit (04). */
export function checkUnitLabel(input: string): string {
  const value = checkPart('unit', input);
  return /^\d+$/.test(value) ? String(Number(value)).padStart(2, '0') : value;
}

export function propertyCode(area: string, part: string): string {
  return `${checkAreaCode(area)}-${checkPropertyPart(part)}`;
}

export function unitCode(propertyCodeValue: string, block: string, label: string): string {
  const parsed = parsePropertyCode(propertyCodeValue);
  if (!parsed) throw new DomainError('code.invalid_property', 'That is not a property code');
  return `${parsed.area}-${parsed.property}-${checkBlockCode(block)}-${checkUnitLabel(label)}`;
}

export function parsePropertyCode(code: string): { area: string; property: string } | null {
  const [area, property, ...rest] = code.split('-');
  if (rest.length || !area || !property) return null;
  return PARTS.area.pattern.test(area) && PARTS.property.pattern.test(property)
    ? { area, property }
    : null;
}

export function parseUnitCode(
  code: string,
): { area: string; property: string; block: string; unit: string } | null {
  const [area, property, block, unit, ...rest] = code.split('-');
  if (rest.length || !area || !property || !block || !unit) return null;
  const ok =
    PARTS.area.pattern.test(area) &&
    PARTS.property.pattern.test(property) &&
    PARTS.block.pattern.test(block) &&
    PARTS.unit.pattern.test(unit);
  return ok ? { area, property, block, unit } : null;
}

export const MAX_BULK_UNITS = 200;

/**
 * The most units one request may create, across all its blocks and batches. Each unit is audited,
 * and audited writes take the company's audit chain head one after another, so an unbounded
 * request would hold up every audited write in the company. Bigger registers go in over several
 * requests, or through the Excel import, which has its own row limit (PR-08).
 */
export const MAX_UNITS_PER_REQUEST = 5_000;

/** Refuses a request that would create more than MAX_UNITS_PER_REQUEST units. */
export function checkUnitsPerRequest(counts: readonly number[]): void {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total > MAX_UNITS_PER_REQUEST)
    throw new DomainError(
      'unit.too_many',
      `Add at most ${MAX_UNITS_PER_REQUEST.toLocaleString('en-GB')} units at a time. Add the rest afterwards, or import them from a spreadsheet.`,
    );
}

/**
 * Labels for `count` new units in a block: numbers after the highest number ever used there,
 * archived units included, so a number is never handed out twice. Two digits at least.
 */
export function nextUnitLabels(usedLabels: readonly string[], count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BULK_UNITS)
    throw new DomainError('unit.bulk_count', `Create 1 to ${MAX_BULK_UNITS} units at a time`);
  let highest = 0;
  for (const label of usedLabels) {
    if (/^\d+$/.test(label)) highest = Math.max(highest, Number(label));
  }
  if (highest + count > 9999)
    throw new DomainError('unit.labels_exhausted', 'This block has no unit numbers left');
  return Array.from({ length: count }, (_, i) => String(highest + i + 1).padStart(2, '0'));
}

function firstWord(text: string, separator: RegExp): string | undefined {
  return text
    .toUpperCase()
    .split(separator)
    .find((w) => w.length > 0);
}

/** An area code suggested from a town: the first three letters of its first word (Accra: ACC). */
export function suggestAreaCode(town: string): string {
  return (firstWord(town, /[^A-Z]+/) ?? 'ARE').slice(0, 3).padEnd(2, 'X');
}

/** A property part suggested from a name: the first three characters of its first word. */
export function suggestPropertyPart(name: string): string {
  return (firstWord(name, /[^A-Z0-9]+/) ?? 'PRP').slice(0, 3).padEnd(2, 'X');
}

/**
 * A free alternative for a taken property part: the part with a digit in place of, or after,
 * its last character, still within the 4-character limit. Null if none is free.
 */
export function freePropertyPart(part: string, taken: ReadonlySet<string>): string | null {
  const value = checkPropertyPart(part);
  if (!taken.has(value)) return value;
  const stem = value.length < 4 ? value : value.slice(0, 3);
  for (let digit = 2; digit <= 9; digit += 1) {
    const candidate = `${stem}${digit}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}
