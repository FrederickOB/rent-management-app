import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import {
  DEFAULT_INTERIM_PLAN,
  featuresOf,
  isInterimPlan,
  PLAN_FEATURE_NAMES,
  planHas,
  type InterimPlan,
  type PlanFeature,
} from '@rent/domain/settings';
import { AppError, forbidden, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';

export interface CompanyPlanView {
  readonly companyId: string;
  readonly displayName: string;
  readonly kind: 'landlord' | 'agency';
  readonly status: string;
  readonly plan: InterimPlan;
}

/** Refused because the company's plan leaves the feature out (decision 9). */
export const notOnPlan = (feature: PlanFeature) =>
  new AppError(
    403,
    'not_on_plan',
    `${PLAN_FEATURE_NAMES[feature]} is not part of your plan. Ask us about Growth to use it.`,
    { feature },
  );

/**
 * What a company's plan includes (M6 decision 9; PRD section 21). The one place any module asks
 * whether a company has the inbox, broadcasts, tenant groups, maintenance or the bot's full menu.
 * Until subscriptions arrive (M10) the plan is the interim one a platform admin sets on the
 * company; M10 changes where `planIn` reads it from, nothing else. Roles are not checked here:
 * who may use a feature is the policy's question, whether the company has it is this one's.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  /** The company's plan, inside the caller's transaction for that company. */
  async planIn(tx: Tx, companyId: string): Promise<InterimPlan> {
    const [row] = await tx
      .select({ plan: schema.company.interimPlan })
      .from(schema.company)
      .where(eq(schema.company.id, companyId));
    if (!row) throw notFound('Company');
    return isInterimPlan(row.plan) ? row.plan : DEFAULT_INTERIM_PLAN;
  }

  async hasIn(tx: Tx, companyId: string, feature: PlanFeature): Promise<boolean> {
    return planHas(await this.planIn(tx, companyId), feature);
  }

  /** Throws `not_on_plan` (403) when the company's plan leaves the feature out. */
  async assertIn(tx: Tx, companyId: string, feature: PlanFeature): Promise<void> {
    if (!(await this.hasIn(tx, companyId, feature))) throw notOnPlan(feature);
  }

  /** The same, in a transaction of its own. */
  async has(companyId: string, feature: PlanFeature): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      this.hasIn(tx, companyId, feature),
    );
  }

  async assert(companyId: string, feature: PlanFeature): Promise<void> {
    if (!(await this.has(companyId, feature))) throw notOnPlan(feature);
  }

  async features(companyId: string): Promise<{ plan: InterimPlan; features: PlanFeature[] }> {
    const plan = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      this.planIn(tx, companyId),
    );
    return { plan, features: [...featuresOf(plan)] };
  }

  // Platform admins (decision 9): the plan per company, through the narrow functions --------------

  async companyPlans(actor: Actor | null): Promise<CompanyPlanView[]> {
    const admin = this.platformAdmin(actor);
    const rows = await withSystem(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      (tx) =>
        tx.execute<{
          company_id: string;
          display_name: string;
          kind: 'landlord' | 'agency';
          status: string;
          interim_plan: string;
        }>(sql`select * from app.company_plans()`),
    );
    return rows.rows.map((r) => ({
      companyId: r.company_id,
      displayName: r.display_name,
      kind: r.kind,
      status: r.status,
      plan: isInterimPlan(r.interim_plan) ? r.interim_plan : DEFAULT_INTERIM_PLAN,
    }));
  }

  async setCompanyPlan(
    actor: Actor | null,
    companyId: string,
    plan: InterimPlan,
  ): Promise<CompanyPlanView> {
    const admin = this.platformAdmin(actor);
    await withSystem(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      (tx) => tx.execute(sql`select app.set_company_plan(${companyId}::uuid, ${plan})`),
    );
    const found = (await this.companyPlans(admin)).find((c) => c.companyId === companyId);
    if (!found) throw notFound('Company');
    return found;
  }

  private platformAdmin(actor: Actor | null): Extract<Actor, { kind: 'platform_admin' }> {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'company.plan.manage');
    switch (actor.kind) {
      case 'platform_admin':
        return actor;
      default:
        throw forbidden();
    }
  }
}
