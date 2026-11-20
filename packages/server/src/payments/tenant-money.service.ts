import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import { creditPools, moneySummary } from '@rent/domain/billing';
import { invoiceRemainingMinor } from '@rent/domain/payments';
import type { Actor } from '@rent/domain/policy';
import { BillingEngine } from '../billing/engine';
import { formatReceiptNumber } from '../billing/records';
import { destinationForOwner } from '../companies/settlement-destinations';
import type { Clock } from '../core/clock';
import { forbidden, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import { PayLinksService } from './pay-links.service';
import { ReceiptsService } from './receipts.service';

type TenantActor = Extract<Actor, { kind: 'tenant' }>;

export interface TenantBillingView {
  readonly leaseId: string;
  readonly landlordName: string;
  readonly unitCode: string;
  readonly paymentReference: string | null;
  readonly dueNowMinor: number;
  readonly paidUntil: string | null;
  readonly partial: { readonly monthStart: string; readonly amountMinor: number } | null;
  readonly creditMinor: number;
  readonly nextDue: { readonly dueDate: string; readonly amountMinor: number } | null;
  readonly canPay: boolean;
  readonly cannotPayReason: string | null;
  readonly fetchedAt: Date;
}

export interface TenantPaymentView {
  readonly id: string;
  readonly leaseId: string;
  readonly companyId: string;
  readonly landlordName: string;
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly method: string;
  readonly status: 'confirmed' | 'reversed';
  readonly receiptId: string | null;
  readonly receiptNumber: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  cheque: 'Cheque',
  bank_transfer: 'Bank transfer',
  momo: 'Mobile money',
  card: 'Card',
  test: 'Payment',
};

/**
 * The tenant app's money (TL-01, BC-04; M4b plan 4.10): each tenancy's balance, paid-until and
 * next due date, the tenant's payments and receipts, and a fresh pay link. Every landlord's data
 * is checked under that landlord's company with the tenant scope, so a tenant sees only their own
 * tenancies (TL-12); the figures themselves come from the same engine staff see.
 */
@Injectable()
export class TenantMoneyService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PayLinksService) private readonly links: PayLinksService,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
  ) {}

  async billing(actor: Actor | null, leaseId: string): Promise<TenantBillingView> {
    const tenant = this.tenantActor(actor);
    const companyId = await this.companyOfLease(tenant, leaseId);
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const state = await this.engine.load(tx, companyId, leaseId);
      const today = this.engine.today(state);
      const walk = this.engine.walk(state);
      const summary = moneySummary({
        lines: state.lines,
        allocations: state.allocations,
        pools: creditPools(state.payments, state.allocations),
        walk,
        today,
      });
      const invoices = await tx
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.leaseId, leaseId))
        .orderBy(schema.invoice.dueDate);
      let nextDue: TenantBillingView['nextDue'] = null;
      for (const invoice of invoices) {
        if (invoice.dueDate <= today) continue;
        const left = invoiceRemainingMinor({
          invoiceLines: state.lines.filter((l) => l.invoiceId === invoice.id),
          allocations: state.allocations,
          walk,
        });
        if (left > 0) {
          nextDue = { dueDate: invoice.dueDate, amountMinor: left };
          break;
        }
      }
      const [reference] = await tx
        .select({ reference: schema.paymentReference.reference })
        .from(schema.paymentReference)
        .where(eq(schema.paymentReference.leaseId, leaseId));
      let cannotPayReason: string | null = null;
      if (state.book.kind !== 'book')
        cannotPayReason = 'Online payment is not set up for this tenancy';
      else {
        const destination = await destinationForOwner(tx, state.company, state.book.ownerId, today);
        if (destination.kind === 'problem')
          cannotPayReason =
            'Online payment is not set up for this tenancy yet; pay your landlord as usual';
        else if (summary.dueNowMinor <= 0 && !nextDue) cannotPayReason = 'Nothing is due now';
      }
      return {
        leaseId,
        landlordName: state.company.displayName,
        unitCode: state.lease.unitCode,
        paymentReference: reference?.reference ?? null,
        dueNowMinor: summary.dueNowMinor,
        paidUntil: summary.paidUntil,
        partial: summary.partial,
        creditMinor: summary.creditMinor,
        nextDue,
        canPay: cannotPayReason === null,
        cannotPayReason,
        fetchedAt: this.clock.now(),
      };
    });
  }

  async payments(actor: Actor | null): Promise<TenantPaymentView[]> {
    const tenant = this.tenantActor(actor);
    const out: TenantPaymentView[] = [];
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const rows = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const name = (
          await tx
            .select({ name: schema.company.displayName })
            .from(schema.company)
            .where(eq(schema.company.id, companyId))
        )[0]?.name;
        const result = await tx.execute<{
          id: string;
          lease_id: string | null;
          match_lease_id: string | null;
          amount_minor: string;
          received_on: string;
          method: string;
          reversed: boolean;
          receipt_id: string | null;
          receipt_number: string | null;
        }>(
          sql`select p.id, p.lease_id, (select m.lease_id from payment_match m where m.company_id = p.company_id and m.payment_id = p.id) as match_lease_id,
                p.amount_minor, p.received_on, p.method,
                exists (select 1 from receipt r where r.company_id = p.company_id and r.payment_id = p.id and r.kind = 'credit_receipt') as reversed,
                (select r.id from receipt r where r.company_id = p.company_id and r.payment_id = p.id and r.kind = 'receipt') as receipt_id,
                (select r.number from receipt r where r.company_id = p.company_id and r.payment_id = p.id and r.kind = 'receipt') as receipt_number
              from payment p where p.source_type <> 'opening_balance'
              order by p.received_on desc, p.id desc limit 200`,
        );
        return result.rows.flatMap((r) => {
          const leaseId = r.lease_id ?? r.match_lease_id;
          if (!leaseId) return [];
          return [
            {
              id: r.id,
              leaseId,
              companyId,
              landlordName: name ?? '',
              amountMinor: Number(r.amount_minor),
              receivedOn: r.received_on,
              method: METHOD_LABELS[r.method] ?? 'Payment',
              status: r.reversed ? ('reversed' as const) : ('confirmed' as const),
              receiptId: r.receipt_id,
              receiptNumber: r.receipt_number
                ? formatReceiptNumber(Number(r.receipt_number))
                : null,
            },
          ];
        });
      });
      out.push(...rows);
    }
    return out.sort((a, b) =>
      a.receivedOn < b.receivedOn ? 1 : a.receivedOn > b.receivedOn ? -1 : 0,
    );
  }

  /** A 5-minute link to one of the tenant's own receipts. */
  async receiptDownload(actor: Actor | null, receiptId: string): Promise<string> {
    const tenant = this.tenantActor(actor);
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const url = await this.inCompany(tenant, companyId, tenantIds, (tx) =>
        this.receipts.tenantDownload(companyId, tx, receiptId),
      );
      if (url) return url;
    }
    throw notFound('Receipt');
  }

  /** A fresh pay link for the oldest open invoice on one of the tenant's own leases. */
  async payLink(actor: Actor | null, leaseId: string): Promise<{ url: string; expiresAt: Date }> {
    const tenant = this.tenantActor(actor);
    const companyId = await this.companyOfLease(tenant, leaseId);
    return this.links.forTenant(tenant, companyId, leaseId);
  }

  private tenantActor(actor: Actor | null): TenantActor {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'tenancy.view_own');
    switch (actor.kind) {
      case 'tenant':
        return actor;
      default:
        throw forbidden();
    }
  }

  /** The company of one of the tenant's own issued leases, checked under the tenant scope. */
  private async companyOfLease(tenant: TenantActor, leaseId: string): Promise<string> {
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const own = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`select id from lease where id = ${leaseId} and status not in ('draft', 'cancelled')`,
        );
        return rows.rows.length > 0;
      });
      if (own) return companyId;
    }
    throw notFound('Tenancy');
  }

  private async companies(tenant: TenantActor): Promise<Map<string, string[]>> {
    const rows = await withSystem(
      this.database,
      { personId: tenant.personId, actorKind: 'tenant' },
      (tx) =>
        tx.execute<{ company_id: string; tenant_id: string }>(
          sql`select company_id, tenant_id from app.tenancies_for_person(${tenant.personId}::uuid)`,
        ),
    );
    const byCompany = new Map<string, string[]>();
    for (const r of rows.rows)
      byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r.tenant_id]);
    return byCompany;
  }

  private inCompany<T>(
    tenant: TenantActor,
    companyId: string,
    tenantIds: readonly string[],
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return withCompany(
      this.database,
      { companyId, personId: tenant.personId, actorKind: 'tenant', tenantScope: { tenantIds } },
      fn,
    );
  }
}
