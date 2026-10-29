import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import type { LeaseStatus, RentCycle } from '@rent/domain/tenancy';
import { forbidden, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { EsignService } from '../esign/esign.service';
import type { IssuedLink, TenantSigningRequest } from '../esign/esign.types';
import { PolicyService } from '../policy/policy.service';

type TenantActor = Extract<Actor, { kind: 'tenant' }>;

export interface TenancyCard {
  readonly leaseId: string;
  readonly status: LeaseStatus;
  readonly unitCode: string;
  readonly propertyName: string;
  readonly address: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly monthlyRentMinor: number;
  readonly currency: 'GHS';
  readonly cycle: RentCycle;
  /** A lease recorded from paper claims no e-signature (decision 7). */
  readonly signedOnPaper: boolean;
  /** The signed copy to download, when there is one. */
  readonly documentId: string | null;
}

export interface TenancyGroup {
  /** The landlord or agency the tenant rents from. */
  readonly landlord: { readonly companyId: string; readonly name: string };
  readonly tenancies: readonly TenancyCard[];
}

export interface TenancyDetail extends TenancyCard {
  readonly landlord: { readonly companyId: string; readonly name: string };
  readonly depositMinor: number | null;
  readonly serviceChargeMonthlyMinor: number | null;
  readonly noticeDays: number;
  readonly steps: readonly { readonly effectiveFrom: string; readonly monthlyRentMinor: number }[];
}

/**
 * A lease waiting for the tenant's signature, or for others' after theirs (GET /me/signing). The
 * app opens the signing page in its browser with a fresh link from POST /me/signing/{signerId}/link.
 */
export interface TenantSigningCard extends TenantSigningRequest {
  readonly landlord: { readonly companyId: string; readonly name: string };
  readonly tenancy: TenancyCard | null;
}

type CardRow = {
  id: string;
  status: LeaseStatus;
  unit_code: string;
  property_name: string;
  street: string | null;
  town: string | null;
  region: string;
  start_date: string;
  end_date: string;
  monthly_rent_minor: number;
  rent_cycle: RentCycle;
  signing_method: string | null;
  signed_document_id: string | null;
  deposit_minor: number | null;
  notice_days: number;
  service_charge: number | null;
};

const CARD_SELECT = sql`select l.id, l.status, u.code as unit_code, p.name as property_name, p.street, p.town,
    p.region, l.start_date, l.end_date, l.monthly_rent_minor, l.rent_cycle, l.signing_method, l.signed_document_id,
    l.deposit_minor, l.notice_days,
    (select c.monthly_amount_minor from lease_charge c where c.company_id = l.company_id and c.lease_id = l.id
       and c.charge_type = 'service_charge') as service_charge
  from lease l
  join unit u on u.company_id = l.company_id and u.id = l.unit_id
  join property p on p.company_id = l.company_id and p.id = l.property_id`;

const card = (r: CardRow): TenancyCard => ({
  leaseId: r.id,
  status: r.status,
  unitCode: r.unit_code,
  propertyName: r.property_name,
  address: [r.street, r.town, r.region].filter(Boolean).join(', '),
  startDate: r.start_date,
  endDate: r.end_date,
  monthlyRentMinor: Number(r.monthly_rent_minor),
  currency: 'GHS',
  cycle: r.rent_cycle,
  signedOnPaper: r.signing_method === 'paper',
  documentId: r.signed_document_id,
});

/**
 * The tenant app (TL-01; M3 plan 4.3): a person signs in once and sees every tenancy, with each
 * landlord's data read under that landlord's own company context and the tenant scope set, so
 * the restrictive RLS policies show only that person's records there and never a draft.
 */
@Injectable()
export class TenantAppService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(EsignService) private readonly esign: EsignService,
  ) {}

  async tenancies(actor: Actor | null): Promise<TenancyGroup[]> {
    const tenant = this.tenantActor(actor);
    const groups: TenancyGroup[] = [];
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const group = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const name = await this.landlordName(tx, companyId);
        const rows = await tx.execute<CardRow>(
          sql`${CARD_SELECT} where l.status <> 'cancelled' order by l.start_date desc`,
        );
        return { landlord: { companyId, name }, tenancies: rows.rows.map(card) };
      });
      if (group.tenancies.length > 0) groups.push(group);
    }
    return groups;
  }

  async tenancy(actor: Actor | null, leaseId: string): Promise<TenancyDetail> {
    const tenant = this.tenantActor(actor);
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const found = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const rows = await tx.execute<CardRow>(sql`${CARD_SELECT} where l.id = ${leaseId}`);
        const row = rows.rows[0];
        if (!row) return null;
        const steps = await tx.execute<{ effective_from: string; monthly_rent_minor: number }>(
          sql`select effective_from, monthly_rent_minor from rent_step where lease_id = ${leaseId} order by effective_from`,
        );
        return {
          ...card(row),
          landlord: { companyId, name: await this.landlordName(tx, companyId) },
          depositMinor: row.deposit_minor === null ? null : Number(row.deposit_minor),
          serviceChargeMonthlyMinor:
            row.service_charge === null ? null : Number(row.service_charge),
          noticeDays: row.notice_days,
          steps: steps.rows.map((s) => ({
            effectiveFrom: s.effective_from,
            monthlyRentMinor: Number(s.monthly_rent_minor),
          })),
        };
      });
      if (found) return found;
    }
    throw notFound('Tenancy');
  }

  /**
   * A 5-minute link to a document of one of the person's own leases: the signed copy. The
   * document must belong to a lease the tenant session can see, in its own company.
   */
  async documentUrl(actor: Actor | null, documentId: string): Promise<string> {
    const tenant = this.tenantActor(actor);
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const owned = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`select id from lease where signed_document_id = ${documentId} limit 1`,
        );
        return rows.rows.length > 0;
      });
      if (!owned) continue;
      const url = await this.documents.downloadUrl(companyId, documentId);
      if (url) return url;
    }
    throw notFound('Document');
  }

  /**
   * The signing requests out for the signed-in tenant's own signature, with every landlord's read
   * under its own company context and the tenant scope (TL-07; plan 4.15).
   */
  async signing(actor: Actor | null): Promise<TenantSigningCard[]> {
    const tenant = this.tenantActor(actor);
    const cards: TenantSigningCard[] = [];
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const found = await this.inCompany(tenant, companyId, tenantIds, async (tx) => {
        const requests = await this.esign.tenantRequests(tx);
        if (requests.length === 0) return [];
        const name = await this.landlordName(tx, companyId);
        const out: TenantSigningCard[] = [];
        for (const request of requests) {
          const rows = await tx.execute<CardRow>(
            sql`${CARD_SELECT} where l.id = ${request.leaseId}`,
          );
          const row = rows.rows[0];
          out.push({ ...request, landlord: { companyId, name }, tenancy: row ? card(row) : null });
        }
        return out;
      });
      cards.push(...found);
    }
    return cards;
  }

  /**
   * A fresh signing link for the tenant's own signer, for the app to open in its browser. It
   * replaces the link sent by message, as every newer link does (plan 4.8).
   */
  async signingLink(actor: Actor | null, signerId: string): Promise<IssuedLink> {
    const tenant = this.tenantActor(actor);
    for (const [companyId, tenantIds] of await this.companies(tenant)) {
      const own = await this.inCompany(tenant, companyId, tenantIds, (tx) =>
        this.esign.tenantSigner(tx, signerId),
      );
      if (own) return this.esign.tenantAppLink(companyId, signerId);
    }
    throw notFound('Signer');
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

  /** The person's tenant records by company, from the narrow system function (ids only). */
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

  private async landlordName(tx: Tx, companyId: string): Promise<string> {
    const rows = await tx.execute<{ display_name: string }>(
      sql`select display_name from company where id = ${companyId}`,
    );
    return rows.rows[0]?.display_name ?? '';
  }
}
