import type { Actor, PolicyAction, PolicyResource } from '../policy/policy';

/**
 * Read-only access (M10 decision 11; PB-11; OQ-34). While a company's subscription is past due
 * beyond the grace period (with the switch on), or after it is cancelled, its staff may still do
 * what is listed here; every other staff change is refused by `can()` with code
 * 'subscription_read_only'. Tenants, system jobs and platform admins are never affected: rent
 * collection, receipts, pay links, the tenant app, the WhatsApp bot, signing, and notices already
 * issued with their ladders all run as tenants or jobs, outside this list.
 *
 * Type-only import of the policy: `policy.ts` imports this file at run time, never the reverse.
 */
export const READ_ONLY_ALLOWED: readonly PolicyAction[] = [
  // Every read.
  'company.view',
  'membership.view',
  'audit.search',
  'approval.view',
  'document.view',
  'rules.view',
  'owner.view',
  'register.view',
  'property_photo.view',
  'property_paper.view',
  'tenant.view',
  'tenant.view_details',
  // An audited read (CLAUDE.md section 10).
  'tenant.id.reveal',
  'lease.view',
  'lease.view_terms',
  'tenancy.view_own',
  'billing.view',
  'payments.view',
  'cash.view_own',
  // An audited read (CLAUDE.md section 10).
  'settlement_account.reveal',
  'messaging.inbox.read',
  'messaging.templates.read',
  'maintenance.view',
  'maintenance.read',
  'notices.read',
  'tasks.read',
  'inspection.read',
  'expense.read',
  'statements.read',
  'dashboard.read',
  'compliance.read',
  'metrics.platform.read',
  'subscription.read',
  'usage.read',
  'health.read',
  // Signing in and out, and the device list.
  'session.manage_own',
  // Recording money received and its receipt.
  'payment.record',
  'payment.record_transfer',
  'cash.bank',
  'cash.bank_others',
  'payments.match',
  // Evidence of service for a notice already issued: its ladder never stops.
  'notices.service.record',
  // Who an emergency a tenant reports reaches: routing, not a change by staff.
  'maintenance.alert',
  // A tenant's own conversations (tenant actors are outside read-only anyway).
  'messaging.own',
  // Paying the subscription, the export, and granting support access always work.
  'subscription.manage',
  'support.grant',
  // M11 decision 5: a tenant's rights under Act 843 (access, correction, erasure, objection) do
  // not wait on the landlord's subscription, so the request register and the export stay open.
  'data_protection.manage',
  'data_protection.export',
];

/**
 * Approval steps that stay open under read-only, and only for a request that records money in (a
 * cash receipt): the approvals engine sets `recordsMoneyIn` on the resource.
 */
export const READ_ONLY_MONEY_IN_APPROVALS: readonly PolicyAction[] = [
  'approval.decide',
  'approval.self_confirm',
  'approval.cancel',
];

/** The code a read-only refusal carries; the API answers 403 `SUBSCRIPTION_READ_ONLY`. */
export const SUBSCRIPTION_READ_ONLY_CODE = 'subscription_read_only';

export const SUBSCRIPTION_READ_ONLY_REASON = 'the subscription is read-only (PB-11)';

/** For people: what a refused change means. */
export const SUBSCRIPTION_READ_ONLY_MESSAGE =
  'Your subscription is past due, so changes are paused. Nothing was changed. Tenants can still pay and get receipts. Paying the subscription restores access at once.';

/** Why, for logs and tests, once the subscription has ended (decision 12). */
export const SUBSCRIPTION_ENDED_REASON =
  'the subscription has ended; staff read only (decision 12)';

/**
 * For people: what a refused change means once the subscription has ended (decision 12; review
 * BE-27). Same code as past due, so the API still answers 403 SUBSCRIPTION_READ_ONLY; only the
 * words differ, because paying does not restore an ended subscription.
 */
export const SUBSCRIPTION_ENDED_MESSAGE =
  'Your subscription has ended, so changes are paused. Nothing was changed. You can still read and export your records until read access ends.';

/**
 * Staff steps that stay open while the company is read-only although their policy action is,
 * in general, a change (review BE-18 and BE-24). Each step names the action that decides WHO may
 * take it; read-only does not decide whether they may:
 * - `membership.revoke`: removing someone from the company, which ends what their sessions can do
 *   there. An admin must be able to remove a person who left, or they keep recording cash and
 *   revealing ID numbers. Inviting and changing roles (`membership.manage` otherwise) stay paused.
 * - `dashboard.refresh`: refreshing the dashboard's figures is reading (decision 11); M9 lets
 *   those who manage leases start it.
 */
export const READ_ONLY_KEPT_STEPS = {
  'membership.revoke': 'membership.manage',
  'dashboard.refresh': 'lease.manage',
} as const satisfies Record<string, PolicyAction>;

export type ReadOnlyKeptStep = keyof typeof READ_ONLY_KEPT_STEPS;

/**
 * What to ask `can()` for a kept step: its deciding action, for the same person as if the company
 * had full access. Anyone else (full access, tenants, platform admins, jobs) is passed through as
 * they are, so the step is never wider than the role's own permission.
 */
export function keptStep<A extends Actor>(
  actor: A,
  step: ReadOnlyKeptStep,
): { readonly actor: A; readonly action: PolicyAction } {
  const action = READ_ONLY_KEPT_STEPS[step];
  if (actor.kind !== 'staff' || actor.subscriptionAccess !== 'read_only') return { actor, action };
  const { subscriptionAccess: _access, subscriptionEnded: _ended, ...asFull } = actor;
  return { actor: asFull as A, action };
}

/** Whether staff of a read-only company may still do this (the rest of `can()` still applies). */
export function allowedWhileReadOnly(action: PolicyAction, resource?: PolicyResource): boolean {
  if (READ_ONLY_ALLOWED.includes(action)) return true;
  return (
    READ_ONLY_MONEY_IN_APPROVALS.includes(action) &&
    resource !== undefined &&
    resource.kind !== 'certificate' &&
    resource.kind !== 'task' &&
    resource.recordsMoneyIn === true
  );
}
