import { eq, schema, type Tx } from '@rent/db';
import { isPlaceholderEmail } from './person-accounts';

/** A person's name and contact details, for staff notices (M3 plan 4.9). Never logged. */
export interface PersonContact {
  readonly name: string;
  /** Null for phone-only people, whose address is a placeholder that is never sent to. */
  readonly email: string | null;
  readonly phone: string | null;
  readonly isTestContact: boolean;
}

/** Reads a person in the caller's transaction (the person table is global, ADR-011). */
export async function personContact(tx: Tx, personId: string): Promise<PersonContact | null> {
  const [row] = await tx
    .select({
      name: schema.person.name,
      email: schema.person.email,
      phone: schema.person.phoneNumber,
      isTestContact: schema.person.isTestContact,
    })
    .from(schema.person)
    .where(eq(schema.person.id, personId));
  if (!row) return null;
  return {
    name: row.name,
    email: isPlaceholderEmail(row.email) ? null : row.email,
    phone: row.phone,
    isTestContact: row.isTestContact,
  };
}
