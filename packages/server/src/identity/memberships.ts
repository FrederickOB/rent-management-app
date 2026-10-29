import { sql, withSystem, type Database } from '@rent/db';
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
      return result.rows.map((r) => ({
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
