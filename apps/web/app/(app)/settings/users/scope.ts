import type { MembershipRow } from '@rent/contracts';
import {
  scopeRuleFor,
  type CompanyKind,
  type ScopeListUse,
  type StaffRole,
} from '@rent/domain/policy';

type Scope = MembershipRow['scope'];

/** Display names for scope entries, when this session may list owners and properties. */
export interface ScopeNames {
  readonly owners: ReadonlyMap<string, string>;
  readonly properties: ReadonlyMap<string, string>;
}

const MAX_NAMED = 3;

function describe(
  ids: readonly string[],
  names: ReadonlyMap<string, string> | undefined,
  one: string,
  many: string,
) {
  if (ids.length === 0) return null;
  const known = ids.map((id) => names?.get(id));
  if (ids.length <= MAX_NAMED && known.every(Boolean)) return known.join(', ');
  return `${ids.length} ${ids.length === 1 ? one : many}`;
}

/** No owner or property list means access to everything in the company (AD-02). */
export function scopeSummary(scope: Scope, names?: ScopeNames): string {
  const owners = describe(scope.owners ?? [], names?.owners, 'owner', 'owners');
  const properties = describe(scope.properties ?? [], names?.properties, 'property', 'properties');
  if (!owners && !properties) return 'Whole company';
  return `Only ${[owners, properties].filter(Boolean).join(' and ')}`;
}

/** A scope in one canonical form (sorted, empty lists left out), so equal scopes compare equal. */
export function buildScope(owners: readonly string[], properties: readonly string[]): Scope {
  return {
    ...(owners.length ? { owners: [...new Set(owners)].sort() } : {}),
    ...(properties.length ? { properties: [...new Set(properties)].sort() } : {}),
  };
}

/** `required`: the role sees nothing until one is chosen; `hidden`: the list has no effect. */
export type PickerNeed = 'required' | 'optional' | 'hidden';

export interface ScopePickers {
  readonly owners: PickerNeed;
  readonly properties: PickerNeed;
}

const NEED: Record<ScopeListUse, PickerNeed> = {
  required: 'required',
  optional: 'optional',
  unused: 'hidden',
};

/**
 * Which pickers a role gets (AD-02; M2 plan 4.4), from the policy module's scopeRuleFor, the same
 * rule the API applies when it saves a scope, so this screen never compares roles. Caretakers get
 * properties; an agency's client owners and advisers get owners; everyone else may be limited
 * either way, or not at all. A list the role does not use is not offered.
 */
export function scopePickersFor(role: StaffRole, companyKind: CompanyKind): ScopePickers {
  const rule = scopeRuleFor(role, companyKind);
  return { owners: NEED[rule.owners], properties: NEED[rule.properties] };
}

/** What is missing before a scope can be saved, by list. */
export function scopeProblems(
  pickers: ScopePickers,
  owners: readonly string[],
  properties: readonly string[],
): { owners?: string; properties?: string } {
  return {
    ...(pickers.owners === 'required' && owners.length === 0
      ? { owners: 'Choose at least one owner.' }
      : {}),
    ...(pickers.properties === 'required' && properties.length === 0
      ? { properties: 'Choose at least one property.' }
      : {}),
  };
}

/** The scope to save: lists the role ignores are dropped rather than kept out of sight. */
export function scopeToSave(
  pickers: ScopePickers,
  owners: readonly string[],
  properties: readonly string[],
): Scope {
  return buildScope(
    pickers.owners === 'hidden' ? [] : owners,
    pickers.properties === 'hidden' ? [] : properties,
  );
}

/**
 * Where the API's refusal of a scope belongs on the form: a missing list next to that list, an
 * owner or property from outside the company (or no longer there) above the form.
 */
export function scopeRefusal(code: string | null): 'owners' | 'properties' | 'unknown' | null {
  switch (code?.toLowerCase()) {
    case 'scope.owners_required':
      return 'owners';
    case 'scope.properties_required':
      return 'properties';
    case 'scope_unknown':
      return 'unknown';
    default:
      return null;
  }
}
