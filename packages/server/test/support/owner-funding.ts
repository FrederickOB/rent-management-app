import { sql, withCompany } from '@rent/db';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import { EntitlementsService } from '../../src/companies/entitlements.service';
import { OwnerMoneyService } from '../../src/reporting/owner-money.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import { uploadEvidence } from './tax';
import type { TenancyServices } from './tenancy';

/**
 * F3 (founder decision, 2026-11-06): the agency pays out of an owner's agent-held cash (1070) only
 * what it holds for the owner. Tests that pay from the agency's account record the owner's funding
 * first (P30, through the owner money service, as the agency would), approved by the founder for
 * the passed tests that paid with nothing held (2026-11-07). No fee hook is registered.
 */
export async function fundAgentCash(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
  actor: Parameters<OwnerMoneyService['fund']>[0],
  ownerId: string,
  amountMinor: number,
): Promise<void> {
  const money = new OwnerMoneyService(
    ctx.database,
    s.policy,
    new EntitlementsService(ctx.database, s.policy),
    s.approvals,
    b.posting,
    s.documents,
    ctx.clock,
  );
  await money.fund(actor, {
    ownerId,
    on: toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra')),
    method: 'bank',
    reference: 'OWNER FUNDING',
    proofUploadId: await uploadEvidence(ctx, (i) => money.createUpload(actor, i)),
    amountMinor,
  });
}

/** The owner whose book a lease's money is in. */
export async function ownerOfLease(
  ctx: ServerTestContext,
  b: BillingServices,
  companyId: string,
  leaseId: string,
): Promise<string> {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, async (tx) => {
    const state = await b.engine.load(tx, companyId, leaseId);
    if (state.book.kind !== 'book') throw new Error('The lease has no owner book');
    return state.book.ownerId;
  });
}

/** The owner of a property held by one owner. */
export async function ownerOfProperty(
  ctx: ServerTestContext,
  companyId: string,
  propertyId: string,
): Promise<string> {
  const rows = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx.execute<{ owner_id: string }>(
      sql`select owner_id from property_current_ownership where property_id = ${propertyId}::uuid`,
    ),
  );
  return rows.rows[0]!.owner_id;
}
