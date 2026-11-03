import { eq, schema, type Tx } from '@rent/db';
import type { Actor, CompanyKind, PolicyAction, StaffRole } from '@rent/domain/policy';
import { PolicyService } from '../policy/policy.service';

/**
 * The company's active people who may take an action, as the policy judges them (CLAUDE.md
 * section 5): who is told about a settlement account or a chargeback, and who a tenant contacts.
 * Read in a transaction that sees the company's memberships.
 */
export async function membersWhoCan(
  tx: Tx,
  policy: PolicyService,
  company: { readonly id: string; readonly kind: string },
  action: PolicyAction,
): Promise<string[]> {
  const rows = await tx
    .select({
      id: schema.membership.id,
      personId: schema.membership.personId,
      role: schema.membership.role,
      nominatedApprover: schema.membership.nominatedApprover,
      scope: schema.membership.scope,
      status: schema.membership.status,
      createdAt: schema.membership.createdAt,
    })
    .from(schema.membership)
    .where(eq(schema.membership.companyId, company.id))
    .orderBy(schema.membership.createdAt);
  return rows
    .filter((m) => m.status === 'active')
    .filter((m) => {
      const actor = {
        kind: 'staff',
        personId: m.personId,
        companyId: company.id,
        companyKind: company.kind as CompanyKind,
        membershipId: m.id,
        role: m.role as StaffRole,
        nominatedApprover: m.nominatedApprover,
        scope: (m.scope ?? {}) as { owners?: string[]; properties?: string[] },
        authMethod: 'password_totp',
      } as Actor;
      try {
        return policy.can(actor, action).allowed;
      } catch {
        return false;
      }
    })
    .map((m) => m.personId);
}
