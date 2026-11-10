import { sql, withCompany, type Database } from '@rent/db';

/**
 * Whether a company's subscription has ended (M10 decision 12; review BE-4): its latest
 * subscription is cancelled. From then on no new rent invoices are issued and no automatic tenant
 * messages go (rent reminders, renewal reminders, paid-until prompts, broadcasts); pay links for
 * invoices already issued, receipts and notices already issued with their ladders keep working.
 * Read in the company's own context, through the select-only policy on its subscription rows.
 */
export async function subscriptionEnded(database: Database, companyId: string): Promise<boolean> {
  return withCompany(
    database,
    { companyId, actorKind: 'system' },
    async (tx) => {
      const rows = await tx.execute<{ status: string }>(
        sql`select status from subscription where subscriber_company_id = ${companyId}::uuid
            order by created_at desc, id desc limit 1`,
      );
      return rows.rows[0]?.status === 'cancelled';
    },
    { accessMode: 'read only' },
  );
}
