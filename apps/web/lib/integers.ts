/**
 * Parses a list of whole numbers typed as `-7, 0, 3` (commas or spaces; a typographic minus
 * sign counts as a minus). Returns null when anything in it is not a whole number.
 */
export function parseIntegerList(text: string): number[] | null {
  const parts = text
    .replace(/−/g, '-')
    .split(/[\s,]+/)
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (!/^-?\d{1,6}$/.test(part)) return null;
    values.push(Number.parseInt(part, 10));
  }
  return values;
}

/** Parses one whole number, or null. */
export function parseInteger(text: string): number | null {
  const trimmed = text.trim().replace(/−/g, '-');
  return /^-?\d{1,6}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

export const formatIntegerList = (values: readonly number[]): string => values.join(', ');
