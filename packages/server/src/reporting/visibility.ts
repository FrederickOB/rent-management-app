import { sql, withCompany, type Database } from '@rent/db';
import type { StaffActor } from '../companies/companies.service';
import type { PolicyService } from '../policy/policy.service';

/**
 * AD-02 and decision 15, for what covers an owner's whole book (statements, fee terms and the
 * owner's money with the agent): a person limited to some owners sees those owners; a person
 * limited to some properties sees an owner only when every property the owner has held is theirs.
 * Ownership is read in a system transaction, because people limited to properties see no owner
 * records.
 */
export async function ownersVisibleTo(
  database: Database,
  policy: PolicyService,
  staff: StaffActor,
  ownerIds: readonly string[],
): Promise<Set<string>> {
  const scope = policy.scopeFor(staff);
  if (scope === null) return new Set(ownerIds);
  let visible = [...new Set(ownerIds)];
  if (scope.ownerIds.length > 0) visible = visible.filter((id) => scope.ownerIds.includes(id));
  if (scope.propertyIds.length > 0 && visible.length > 0) {
    const held = await withCompany(
      database,
      { companyId: staff.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ owner_id: string; property_id: string }>(
          sql`select distinct po.owner_id, po.property_id from property_ownership po
              where po.owner_id = any(${`{${visible.join(',')}}`}::uuid[])
                and not exists (select 1 from property_ownership_correction c
                                where c.company_id = po.company_id and c.ownership_id = po.id)`,
        ),
      { accessMode: 'read only' },
    );
    const byOwner = new Map<string, string[]>();
    for (const r of held.rows)
      byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) ?? []), r.property_id]);
    visible = visible.filter((id) => {
      const properties = byOwner.get(id) ?? [];
      return properties.length > 0 && properties.every((p) => scope.propertyIds.includes(p));
    });
  }
  return new Set(visible);
}
