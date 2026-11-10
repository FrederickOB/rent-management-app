import type { CompanyProfile } from '@rent/contracts';
import {
  COMING_SOON_FEATURES,
  DEFAULT_INTERIM_PLAN,
  featuresOf,
  PLAN_FEATURE_NAMES,
  tierUnlocking,
  type PlanFeature,
  type SubscriptionTier,
} from '@rent/domain/settings';
import { errorCode, statusOf } from './errors';
import { tierLabel } from './subscription';

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

/** The plan's name for people (M10: Portfolio too; no plan is Growth, as before M6). */
export function planLabel(plan: SubscriptionTier | undefined): string {
  return tierLabel(plan);
}

/** Why a page is missing: "The inbox is not on the Starter plan." */
export function notOnPlanText(feature: PlanFeature, plan: SubscriptionTier | undefined): string {
  const plural =
    feature === 'broadcasts' ||
    feature === 'tenant_groups' ||
    feature === 'notices' ||
    feature === 'owner_reporting' ||
    feature === 'accounting_export';
  return `${PLAN_FEATURE_NAMES[feature]} ${plural ? 'are' : 'is'} not on the ${planLabel(plan)} plan.`;
}

/**
 * The plan that unlocks a feature (PB-04, M10 decision 4): "Growth includes it.", or for one of
 * Portfolio's P2 modules, "It is coming soon on Portfolio."
 */
export function unlockSentence(feature: PlanFeature): string {
  const tier = planLabel(tierUnlocking(feature));
  return COMING_SOON_FEATURES.includes(feature)
    ? `It is coming soon on ${tier}.`
    : `${tier} includes it.`;
}

/** The API's refusal for a feature the plan leaves out (403 `not_on_plan`). */
export function isNotOnPlan(error: unknown): boolean {
  return statusOf(error) === 403 && errorCode(error) === 'NOT_ON_PLAN';
}
