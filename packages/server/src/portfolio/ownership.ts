import { sql, type Tx } from '@rent/db';

/** A property's owner on a date, with its share (AD-02). */
export interface OwnerShare {
  readonly ownerId: string;
  readonly shareBps: number;
}

/**
 * Who owns a property on a date: the ownership rows with the latest date on or before it, leaving
 * out rows a same-day correction superseded (M2 S5). Read in the caller's transaction (RLS
 * applies). Billing posts a property only to a single owner's book (M4a decision 5).
 */
export async function ownersOn(tx: Tx, propertyId: string, date: string): Promise<OwnerShare[]> {
  const rows = await tx.execute<{ owner_id: string; share_bps: number }>(
    sql`select po.owner_id, po.share_bps from property_ownership po
        where po.property_id = ${propertyId}
          and not exists (select 1 from property_ownership_correction c
                          where c.company_id = po.company_id and c.ownership_id = po.id)
          and po.effective_from = (
            select max(p2.effective_from) from property_ownership p2
            where p2.company_id = po.company_id and p2.property_id = po.property_id
              and p2.effective_from <= ${date}::date
              and not exists (select 1 from property_ownership_correction c2
                              where c2.company_id = p2.company_id and c2.ownership_id = p2.id))
        order by po.share_bps desc, po.owner_id`,
  );
  return rows.rows.map((r) => ({ ownerId: r.owner_id, shareBps: Number(r.share_bps) }));
}

/** Whether a property has invoices, payments or journal lines, whatever the session's scope. */
export async function propertyHasLedger(
  tx: Tx,
  companyId: string,
  propertyId: string,
): Promise<boolean> {
  const result = await tx.execute<{ yes: boolean }>(
    sql`select app.property_has_ledger(${companyId}::uuid, ${propertyId}::uuid) as yes`,
  );
  return result.rows[0]?.yes === true;
}

/**
 * An owner's name for someone who sees the owner's properties but not owner records (a
 * caretaker): through the narrow M3 function, for a property of theirs in the session's scope.
 */
export async function ownerNameThroughProperty(
  tx: Tx,
  companyId: string,
  ownerId: string,
): Promise<string | null> {
  const rows = await tx.execute<{ name: string | null }>(
    sql`select app.property_owner_name(${companyId}::uuid, po.property_id) as name
        from property_ownership po where po.owner_id = ${ownerId}
        order by po.effective_from desc limit 1`,
  );
  return rows.rows[0]?.name ?? null;
}
