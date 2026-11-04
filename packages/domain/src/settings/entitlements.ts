/**
 * What a company's plan includes (PRD section 21; M6 decision 9; prd-issues 28). Subscriptions
 * arrive in M10, so until then a platform admin sets an interim plan on the company, and every
 * check reads it through `EntitlementsService` (packages/server companies). M10 replaces where
 * the plan comes from, not these rules.
 */
export const INTERIM_PLANS = ['starter', 'growth'] as const;
export type InterimPlan = (typeof INTERIM_PLANS)[number];

/**
 * Companies created before M6, and any without a plan, keep everything they had: Growth. A
 * platform admin moves a company to Starter.
 */
export const DEFAULT_INTERIM_PLAN: InterimPlan = 'growth';

/**
 * Features a plan may leave out. Starter has WhatsApp reminders and the bot's short menu, but no
 * inbox, broadcasts, tenant groups or maintenance (PRD section 21, decision 9).
 */
export const PLAN_FEATURES = [
  'inbox',
  'broadcasts',
  'tenant_groups',
  'maintenance',
  'bot_full_menu',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

const INCLUDED: Record<InterimPlan, readonly PlanFeature[]> = {
  starter: [],
  growth: PLAN_FEATURES,
};

export const planHas = (plan: InterimPlan, feature: PlanFeature): boolean =>
  INCLUDED[plan].includes(feature);

export const featuresOf = (plan: InterimPlan): readonly PlanFeature[] => INCLUDED[plan];

export const isInterimPlan = (value: unknown): value is InterimPlan =>
  typeof value === 'string' && (INTERIM_PLANS as readonly string[]).includes(value);

/** For people: why a screen or route is not available on the company's plan. */
export const PLAN_FEATURE_NAMES: Record<PlanFeature, string> = {
  inbox: 'The inbox',
  broadcasts: 'Broadcasts',
  tenant_groups: 'Tenant groups',
  maintenance: 'Maintenance',
  bot_full_menu: 'The full WhatsApp menu',
};
