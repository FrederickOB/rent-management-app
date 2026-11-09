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
  // M7 decision 14: legal notices are part of Growth (PRD section 21).
  'notices',
  // M9 decision 13: owner statements, fees and remittances are Growth only.
  'owner_reporting',
] as const;

/**
 * The Portfolio tier's P2 modules (M10 decision 4): flags only, shown as "coming soon"
 * (prd-issues 31). Kept apart from `PLAN_FEATURES`, which Growth includes in full.
 */
export const PORTFOLIO_FEATURES = [
  'commercial_tenant_portal',
  'caretaker_app',
  'diaspora_owner_view',
  'compliance_dashboard',
  'accounting_export',
  'priority_support',
] as const;

/** Every feature a tier may include. */
export const TIER_FEATURES = [...PLAN_FEATURES, ...PORTFOLIO_FEATURES] as const;
export type PlanFeature = (typeof TIER_FEATURES)[number];

/**
 * The subscription tiers (M10 decision 4; PRD section 21). Starter and Growth are M6's interim
 * plans; Portfolio is Growth plus the flags of its P2 modules. The company's tier is
 * `company.plan`, set only by the subscription engine (M10 decision 1).
 */
export const SUBSCRIPTION_TIERS = ['starter', 'growth', 'portfolio'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

/** Portfolio's P2 modules: shown as "coming soon" on every tier (M10 decision 4). */
export const COMING_SOON_FEATURES: readonly PlanFeature[] = PORTFOLIO_FEATURES;

const INCLUDED: Record<SubscriptionTier, readonly PlanFeature[]> = {
  starter: [],
  growth: PLAN_FEATURES,
  portfolio: TIER_FEATURES,
};

export const planHas = (plan: SubscriptionTier, feature: PlanFeature): boolean =>
  INCLUDED[plan].includes(feature);

export const featuresOf = (plan: SubscriptionTier): readonly PlanFeature[] => INCLUDED[plan];

/** Tier names for people (PRD section 21). */
export const TIER_LABELS: Record<SubscriptionTier, string> = {
  starter: 'Starter',
  growth: 'Growth',
  portfolio: 'Portfolio',
};

/** The lowest tier that includes a feature: what a locked feature names (PB-04). */
export const tierUnlocking = (feature: PlanFeature): SubscriptionTier =>
  SUBSCRIPTION_TIERS.find((t) => INCLUDED[t].includes(feature))!;

/** A company's tier as stored (`company.plan`); anything unexpected reads as Growth, as before. */
export const DEFAULT_TIER: SubscriptionTier = 'growth';

export const isSubscriptionTier = (value: unknown): value is SubscriptionTier =>
  typeof value === 'string' && (SUBSCRIPTION_TIERS as readonly string[]).includes(value);

export const tierOf = (value: unknown): SubscriptionTier =>
  isSubscriptionTier(value) ? value : DEFAULT_TIER;

export const isInterimPlan = (value: unknown): value is InterimPlan =>
  typeof value === 'string' && (INTERIM_PLANS as readonly string[]).includes(value);

/** For people: why a screen or route is not available on the company's plan. */
export const PLAN_FEATURE_NAMES: Record<PlanFeature, string> = {
  inbox: 'The inbox',
  broadcasts: 'Broadcasts',
  tenant_groups: 'Tenant groups',
  maintenance: 'Maintenance',
  bot_full_menu: 'The full WhatsApp menu',
  notices: 'Legal notices',
  owner_reporting: 'Owner statements',
  commercial_tenant_portal: 'The commercial tenant portal',
  caretaker_app: 'The caretaker app',
  diaspora_owner_view: 'The diaspora owner view',
  compliance_dashboard: 'The compliance dashboard',
  accounting_export: 'Accounting exports',
  priority_support: 'Priority support',
};
