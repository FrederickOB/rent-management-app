import type { MembershipRow } from '@rent/contracts';
import { scopeRuleFor, type CompanyKind } from '@rent/domain/policy';
import { roleLabel } from './format';

/** Someone whose access runs through an owner (AD-02), as the Owners screen lists them. */
export interface LinkedUser {
  readonly membershipId: string;
  readonly name: string;
  readonly role: string;
  readonly invited: boolean;
}

/**
 * The people linked to each owner (M2 plan 4.11): those whose membership scope names the owner,
 * such as an agency's client owners and advisers. Revoked memberships do not count, nor does an
 * owner list the role does not use (scopeRuleFor; caretakers are limited by property only).
 */
export function usersByOwner(
  memberships: readonly MembershipRow[],
  companyKind: CompanyKind,
): Record<string, LinkedUser[]> {
  const linked: Record<string, LinkedUser[]> = {};
  for (const m of memberships) {
    if (m.status === 'revoked') continue;
    if (scopeRuleFor(m.role, companyKind).owners === 'unused') continue;
    for (const ownerId of new Set(m.scope.owners ?? [])) {
      (linked[ownerId] ??= []).push({
        membershipId: m.membershipId,
        name: m.name,
        role: roleLabel(m.role),
        invited: m.status === 'invited',
      });
    }
  }
  for (const users of Object.values(linked)) users.sort((a, b) => a.name.localeCompare(b.name));
  return linked;
}
