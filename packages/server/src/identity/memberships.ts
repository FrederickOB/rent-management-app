import { and, eq, inArray, schema, sql, withSystem, type Database, type Tx } from '@rent/db';
import type { CompanyKind, MembershipRole, MembershipScope } from '@rent/domain/policy';

export interface MembershipView {
  readonly membershipId: string;
  readonly companyId: string;
  readonly companyKind: CompanyKind;
  readonly companyName: string;
  readonly companyStatus: string;
  readonly role: MembershipRole;
  readonly status: 'invited' | 'active';
  readonly nominatedApprover: boolean;
  readonly scope: MembershipScope;
  /** M10 decision 11: the company's access; 'read_only' refuses staff changes. */
  readonly companyAccess?: 'full' | 'read_only';
}

interface Row extends Record<string, unknown> {
  membership_id: string;
  company_id: string;
  company_kind: CompanyKind;
  company_name: string;
  company_status: string;
  role: MembershipRole;
  status: 'invited' | 'active';
  nominated_approver: boolean;
  scope: MembershipScope;
}

/**
 * A person's memberships across companies, read through the narrow system function
 * `app.memberships_for_person` (ADR-002). Used at sign-in and on every request.
 */
export class MembershipDirectory {
  constructor(private readonly database: Database) {}

  async forPerson(personId: string): Promise<MembershipView[]> {
    return withSystem(this.database, { personId }, async (tx) => {
      const result = await tx.execute<Row>(
        sql`select * from app.memberships_for_person(${personId}::uuid)`,
      );
      const access = await tx.execute<{ company_id: string; access: string }>(
        sql`select company_id, access from app.company_access_for_person(${personId}::uuid)`,
      );
      const readOnly = new Set(
        access.rows.filter((a) => a.access === 'read_only').map((a) => a.company_id),
      );
      return result.rows.map((r) => ({
        ...(readOnly.has(r.company_id) ? { companyAccess: 'read_only' as const } : {}),
        membershipId: r.membership_id,
        companyId: r.company_id,
        companyKind: r.company_kind,
        companyName: r.company_name,
        companyStatus: r.company_status,
        role: r.role,
        status: r.status,
        nominatedApprover: r.nominated_approver,
        scope: r.scope ?? {},
      }));
    });
  }
}

/** An active membership of the transaction's company, for system jobs that notify staff. */
export interface ActiveMember {
  readonly membershipId: string;
  readonly personId: string;
  readonly role: MembershipRole;
  readonly nominatedApprover: boolean;
  readonly scope: MembershipScope;
}

/**
 * The company's active memberships, read in the caller's company transaction (RLS applies). The
 * tenancy reminders use it to find who manages a property; the policy decides, never the role.
 */
export async function activeMembers(tx: Tx): Promise<ActiveMember[]> {
  const rows = await tx
    .select({
      membershipId: schema.membership.id,
      personId: schema.membership.personId,
      role: schema.membership.role,
      nominatedApprover: schema.membership.nominatedApprover,
      scope: schema.membership.scope,
    })
    .from(schema.membership)
    .where(eq(schema.membership.status, 'active'));
  return rows.map((r) => ({
    ...r,
    role: r.role as MembershipRole,
    scope: (r.scope ?? {}) as MembershipScope,
  }));
}

/**
 * Which of these people are active members of the transaction's company (RLS applies): a lease's
 * staff signers must be (M3 review finding 7).
 */
export async function activeMemberIds(tx: Tx, personIds: readonly string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const rows = await tx
    .select({ personId: schema.membership.personId })
    .from(schema.membership)
    .where(
      and(
        eq(schema.membership.status, 'active'),
        inArray(schema.membership.personId, [...personIds]),
      ),
    );
  return new Set(rows.map((r) => r.personId));
}
