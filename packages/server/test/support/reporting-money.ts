import { CallbackAlert, type Alert } from '@rent/integrations';
import { EntitlementsService } from '../../src/companies/entitlements.service';
import { ManagementFeesService } from '../../src/reporting/fees.service';
import { OwnerMoneyService } from '../../src/reporting/owner-money.service';
import type { BillingServices } from './billing';
import { asSuperuser, type ServerTestContext } from './index';
import type { TenancyServices } from './tenancy';

/**
 * The M9 money services wired as `ReportingMoneyModule` wires them, on the test database
 * (CLAUDE.md section 12): the fee service registers its hooks with the billing engine of `b`, so
 * every settlement after this call in an agency with percentage terms is charged its fee. Files
 * that never call it keep billing as it was.
 */
export function reportingMoneyServices(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
) {
  const alerts: Alert[] = [];
  const alertPort = new CallbackAlert((alert) => {
    alerts.push(alert);
  });
  const fees = new ManagementFeesService(ctx.database, b.engine, b.posting, ctx.clock, alertPort);
  const entitlements = new EntitlementsService(ctx.database, s.policy);
  const money = new OwnerMoneyService(
    ctx.database,
    s.policy,
    entitlements,
    s.approvals,
    b.posting,
    s.documents,
    ctx.clock,
  );
  money.registerApprovals();
  return { fees, money, entitlements, alerts };
}

export type ReportingMoneyServices = ReturnType<typeof reportingMoneyServices>;

/**
 * Fee terms in force from a date, inserted below the application as an agreement signed before
 * go-live would be: the service only takes terms from today (no backfill, decision 2).
 */
export function feeTermsFrom(
  ctx: ServerTestContext,
  companyId: string,
  ownerId: string,
  terms:
    | { kind: 'percentage'; rateBps: number; graPaidBy?: 'agency' | 'owner' }
    | { kind: 'fixed_per_unit'; fixedMinor: number; graPaidBy?: 'agency' | 'owner' }
    | { kind: 'none'; graPaidBy?: 'agency' | 'owner' },
  effectiveFrom: string,
) {
  return asSuperuser(
    ctx,
    `insert into management_fee_terms (company_id, owner_id, kind, rate_bps, fixed_minor, gra_paid_by, effective_from)
     values ($1, $2, $3, $4, $5, $6, $7::date)`,
    [
      companyId,
      ownerId,
      terms.kind,
      terms.kind === 'percentage' ? terms.rateBps : null,
      terms.kind === 'fixed_per_unit' ? terms.fixedMinor : null,
      terms.graPaidBy ?? 'owner',
      effectiveFrom,
    ],
  );
}
