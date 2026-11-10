/**
 * Pilot onboarding (M11 decisions 2 and 3; plan 4.1 and 4.2). The values the contracts, the server
 * and the screens share.
 */

/** The three steps of the onboarding screen, in order. Step 1 is the register import (PR-08). */
export const ONBOARDING_STEPS = ['register', 'tenancies', 'balances'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** What an onboarding batch imports: tenants and leases, opening balances, or their adjustment. */
export const ONBOARDING_BATCH_KINDS = ['tenancies', 'balances', 'adjustment'] as const;
export type OnboardingBatchKind = (typeof ONBOARDING_BATCH_KINDS)[number];

/**
 * A batch's life. Tenancies commit at once (no money). Balances and adjustments post money, so
 * their commit asks a second person (`opening_balances` approval) and posts once approved.
 */
export const ONBOARDING_BATCH_STATUSES = [
  'uploaded',
  'validating',
  'validated',
  'invalid',
  'committing',
  'committed',
  'awaiting_approval',
  'posting',
  'posted',
  'rejected',
  'failed',
] as const;
export type OnboardingBatchStatus = (typeof ONBOARDING_BATCH_STATUSES)[number];

/** The sheets of each workbook. */
export const TENANCY_SHEETS = ['Tenants', 'Leases'] as const;
export const BALANCE_SHEETS = [
  'Arrears',
  'Advances',
  'Deposits',
  'Withholding',
  'Owner items',
] as const;
export type BalanceSheet = (typeof BALANCE_SHEETS)[number];

/** The approval type an opening-balance commit or adjustment goes through (plan 4.12). */
export const OPENING_BALANCES_APPROVAL = 'opening_balances';

/** Imports share the register import's limit (PR-08). */
export const ONBOARDING_IMPORT_MAX_BYTES = 5_000_000;
