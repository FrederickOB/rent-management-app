import type { MembershipRow } from '@rent/contracts';

type Scope = MembershipRow['scope'];

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No owner or property list means access to everything in the company (AD-02, from M2). */
export function scopeSummary(scope: Scope): string {
  const owners = scope.owners?.length ?? 0;
  const properties = scope.properties?.length ?? 0;
  if (owners === 0 && properties === 0) return 'Whole company';
  const parts = [
    owners ? `${owners} ${owners === 1 ? 'owner' : 'owners'}` : null,
    properties ? `${properties} ${properties === 1 ? 'property' : 'properties'}` : null,
  ];
  return `Only ${parts.filter(Boolean).join(' and ')}`;
}

/** One ID per line (or separated by commas). Returns null if any entry is not an ID. */
export function parseIds(text: string): string[] | null {
  const ids = text
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  return ids.every((id) => ID.test(id)) ? [...new Set(ids)] : null;
}

/** A scope in one canonical form (sorted, empty lists left out), so equal scopes compare equal. */
export function buildScope(owners: readonly string[], properties: readonly string[]): Scope {
  return {
    ...(owners.length ? { owners: [...owners].sort() } : {}),
    ...(properties.length ? { properties: [...properties].sort() } : {}),
  };
}
