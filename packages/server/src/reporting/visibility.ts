import { sql, withCompany, type Database } from '@rent/db';
import type { StaffActor } from '../companies/companies.service';
import type { PolicyService } from '../policy/policy.service';

/**
 * AD-02 and decision 15, for what covers an owner's whole book (statements, fee terms and the
 * owner's money with the agent), the same rule as the database's `app.owner_book_visible`
 * (0054; M9 review must-fix 2):
 * - unscoped: every owner;
 * - limited to owners: those owners;
 * - limited to properties only: an owner whose every property, as recorded, is theirs;
 * - a scope with neither (an adviser or client owner whose scope is not saved yet): none.
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
  const wanted = [...new Set(ownerIds)];
  if (scope.ownerIds.length > 0) return new Set(wanted.filter((id) => scope.ownerIds.includes(id)));
  if (scope.propertyIds.length === 0 || wanted.length === 0) return new Set();
  const held = await withCompany(
    database,
    { companyId: staff.companyId, actorKind: 'system' },
    (tx) =>
      tx.execute<{ owner_id: string; property_id: string }>(
        sql`select distinct po.owner_id, po.property_id from property_ownership po
            where po.owner_id = any(${`{${wanted.join(',')}}`}::uuid[])
              and not exists (select 1 from property_ownership_correction c
                              where c.company_id = po.company_id and c.ownership_id = po.id)`,
      ),
    { accessMode: 'read only' },
  );
  const byOwner = new Map<string, string[]>();
  for (const r of held.rows)
    byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) ?? []), r.property_id]);
  return new Set(
    wanted.filter((id) => {
      const properties = byOwner.get(id) ?? [];
      return properties.length > 0 && properties.every((p) => scope.propertyIds.includes(p));
    }),
  );
}
