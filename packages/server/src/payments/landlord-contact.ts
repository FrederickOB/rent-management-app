import { eq, schema, type Tx } from '@rent/db';
import { personContact } from '../identity/person-directory';
import type { PolicyService } from '../policy/policy.service';
import { membersWhoCan } from './members';

/**
 * Who a tenant contacts about a payment (the pay and receipt pages): the company's name, and the
 * phone and email of the first person who may change where its rent settles (its owner or agency
 * admin, as the policy says), as M3's signing page shows a landlord's contact.
 */
export async function landlordContact(
  tx: Tx,
  policy: PolicyService,
  companyId: string,
): Promise<{ name: string; phone: string | null; email: string | null }> {
  const [company] = await tx
    .select({ name: schema.company.displayName, kind: schema.company.kind })
    .from(schema.company)
    .where(eq(schema.company.id, companyId));
  const [first] = company
    ? await membersWhoCan(
        tx,
        policy,
        { id: companyId, kind: company.kind },
        'settlement_account.change',
      )
    : [];
  const contact = first ? await personContact(tx, first) : null;
  return {
    name: company?.name ?? '',
    phone: contact?.phone ?? null,
    email: contact?.email ?? null,
  };
}
