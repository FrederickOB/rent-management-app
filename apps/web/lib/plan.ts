import type { CompanyProfile } from '@rent/contracts';
import {
  DEFAULT_INTERIM_PLAN,
  featuresOf,
  PLAN_FEATURE_NAMES,
  type InterimPlan,
  type PlanFeature,
} from '@rent/domain/settings';
import { errorCode, statusOf } from './errors';

// What the company's plan includes (M6 decision 9; prd-issues 28). The API decides and enforces
// it (EntitlementsService); the screens only read `plan` and `features` from the company profile,
// so a Starter company sees no inbox, broadcast or tenant-group navigation or pages.

type PlanFacts = Pick<CompanyProfile, 'plan' | 'features'>;

/**
 * The features the company's plan includes, as the API sent them. A profile from an API older
 * than M6 sends neither field; such a company keeps everything it had (the domain's default plan).
 * No company (a platform admin) has none.
 */
export function companyFeatures(company: PlanFacts | null): readonly PlanFeature[] {
  if (!company) return [];
  if (company.features) return company.features;
  return featuresOf(company.plan ?? DEFAULT_INTERIM_PLAN);
}

export function hasFeature(company: PlanFacts | null, feature: PlanFeature): boolean {
  return companyFeatures(company).includes(feature);
}

/** The plan's name for people. */
export function planLabel(plan: InterimPlan | undefined): string {
  return plan === 'starter' ? 'Starter' : 'Growth';
}

/** Why a page is missing: "The inbox is not on the Starter plan." */
export function notOnPlanText(feature: PlanFeature, plan: InterimPlan | undefined): string {
  const plural = feature === 'broadcasts' || feature === 'tenant_groups' || feature === 'notices';
  return `${PLAN_FEATURE_NAMES[feature]} ${plural ? 'are' : 'is'} not on the ${planLabel(plan)} plan.`;
}

/** The API's refusal for a feature the plan leaves out (403 `not_on_plan`). */
export function isNotOnPlan(error: unknown): boolean {
  return statusOf(error) === 403 && errorCode(error) === 'NOT_ON_PLAN';
}
