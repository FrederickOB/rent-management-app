import { sql, withCompany } from '@rent/db';
import { EntitlementsService } from '../../src/companies/entitlements.service';
import { OwnerStatementsService } from '../../src/reporting/statements.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import type { TenancyServices } from './tenancy';

/**
 * The M9 owner statements service wired as `ReportingStatementsModule` wires it, on the test
 * database (CLAUDE.md section 12).
 */
export function reportingStatementsServices(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
) {
  const entitlements = new EntitlementsService(ctx.database, s.policy);
  const statements = new OwnerStatementsService(
    ctx.database,
    s.policy,
    entitlements,
    s.documents,
    b.posting,
    ctx.clock,
  );
  return { entitlements, statements };
}

export type ReportingStatementsServices = ReturnType<typeof reportingStatementsServices>;

/** A statement's stored row, figures and the lock on its month, in the system context. */
export function statementRecords(ctx: ServerTestContext, companyId: string, statementId: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, async (tx) => {
    const [row] = (
      await tx.execute<{
        status: string;
        book_id: string;
        month: string;
        render_request_id: string | null;
        document_id: string | null;
        sha256: string | null;
        delivered_at: Date | null;
        sent_at: Date | null;
        email_message_id: string | null;
        email_not_sent_reason: string | null;
      }>(
        sql`select status, book_id, month, render_request_id, document_id, sha256, delivered_at,
              sent_at, email_message_id, email_not_sent_reason
            from owner_statement where id = ${statementId}::uuid`,
      )
    ).rows;
    const figures = (
      await tx.execute<{ key: string; value_minor: string }>(
        sql`select key, value_minor from owner_statement_figure
            where statement_id = ${statementId}::uuid order by position`,
      )
    ).rows.map((r) => ({ key: r.key, value: Number(r.value_minor) }));
    const locks = row
      ? (
          await tx.execute<{ month: string; source: string }>(
            sql`select month::text as month, source from period_lock where book_id = ${row.book_id}::uuid`,
          )
        ).rows
      : [];
    return { row: row ?? null, figures, locks };
  });
}
