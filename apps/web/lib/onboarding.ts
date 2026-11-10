import type { OnboardingBatchView, OnboardingPreview, OnboardingState } from '@rent/contracts';
import type {
  OnboardingBatchKind,
  OnboardingBatchStatus,
  OnboardingStep,
} from '@rent/domain/onboarding';
import { formatBusinessDate } from './business-dates';
import { errorCode } from './errors';

// Pilot onboarding (M11 decisions 2 and 3; plan 4.1 and 4.2; P25): words and small rules for the
// /onboarding screen. Every figure is the API's; the screen never works a balance out.

export const STEP_LABELS: Record<OnboardingStep, string> = {
  register: 'The register',
  tenancies: 'Tenants and leases',
  balances: 'Opening balances',
};

export const STEP_DESCRIPTIONS: Record<OnboardingStep, string> = {
  register: 'Properties, units and, for an agency, owners.',
  tenancies:
    'Tenants and the leases they signed on paper. A lease’s scan can follow later. Nothing is sent to a tenant.',
  balances:
    'What each lease owes, has paid ahead and holds as a deposit, and each owner’s items, on the cut-over date. A second person approves before anything is posted.',
};

export const STEP_STATUS_LABELS: Record<OnboardingState['steps'][number]['status'], string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
};

export const BATCH_KIND_LABELS: Record<OnboardingBatchKind, string> = {
  tenancies: 'Tenants and leases',
  balances: 'Opening balances',
  adjustment: 'An adjustment to the opening balances',
};

export const BATCH_STATUS_LABELS: Record<OnboardingBatchStatus, string> = {
  uploaded: 'Uploaded',
  validating: 'Checking',
  validated: 'Checked: no problems',
  invalid: 'Problems found',
  committing: 'Writing',
  committed: 'Done',
  awaiting_approval: 'Waiting for a second person',
  posting: 'Posting',
  posted: 'Posted',
  rejected: 'Turned down',
  failed: 'Could not be used',
};

/** Statuses the screen waits through, asking again every few seconds. */
const BUSY: readonly OnboardingBatchStatus[] = ['uploaded', 'validating', 'committing', 'posting'];
export const isBusy = (status: OnboardingBatchStatus): boolean => BUSY.includes(status);

/** Whether a batch's report may be committed: checked, with no problem. */
export const canCommit = (batch: Pick<OnboardingBatchView, 'status' | 'report'>): boolean =>
  batch.status === 'validated' && (batch.report?.issueCount ?? 0) === 0;

/** Balances and adjustments post money, so a preview comes first (decision 3). */
export const hasPreview = (kind: OnboardingBatchKind): boolean => kind !== 'tenancies';

/** The kinds a step's workbooks may be: the balances step has its adjustment too. */
export const STEP_KINDS: Record<Exclude<OnboardingStep, 'register'>, OnboardingBatchKind[]> = {
  tenancies: ['tenancies'],
  balances: ['balances', 'adjustment'],
};

/** The sheet counts in the order the workbook has them. */
export function countRows(
  counts: Readonly<Record<string, { create: number; update: number; unchanged: number }>>,
): { sheet: string; create: number; update: number; unchanged: number }[] {
  return Object.entries(counts).map(([sheet, c]) => ({ sheet, ...c }));
}

/** The money a balances commit posts, in total, labelled (report.totals). */
export function totalsRows(
  totals: NonNullable<NonNullable<OnboardingBatchView['report']>['totals']>,
): { key: string; label: string; amountMinor: number }[] {
  return [
    { key: 'arrears', label: 'Arrears', amountMinor: totals.arrearsMinor },
    { key: 'advances', label: 'Paid ahead', amountMinor: totals.advancesMinor },
    { key: 'deposits', label: 'Deposits held', amountMinor: totals.depositsMinor },
    { key: 'withholding', label: 'Withholding to certify', amountMinor: totals.withholdingMinor },
    { key: 'agent-cash', label: 'Agent-held cash', amountMinor: totals.agentCashMinor },
    {
      key: 'rent-tax',
      label: 'Rent tax outstanding',
      amountMinor: totals.rentTaxOutstandingMinor,
    },
  ];
}

type Figures = OnboardingPreview['leases'][number]['after'];

/** For an adjustment: the figures that change, before and after. */
export function changedFigures(
  before: Figures | null,
  after: Figures,
): (keyof Omit<Figures, 'arrearsByAge'>)[] {
  if (!before) return [];
  const keys = [
    'arrearsMinor',
    'advanceMinor',
    'paidUntil',
    'depositHeldMinor',
    'withholdingOutstandingMinor',
    'balanceMinor',
  ] as const;
  return keys.filter((key) => before[key] !== after[key]);
}

/** A balance in words: owes, in credit, or settled. */
export function balanceWord(balanceMinor: number): 'owes' | 'in credit' | 'settled' {
  return balanceMinor > 0 ? 'owes' : balanceMinor < 0 ? 'in credit' : 'settled';
}

/** The cut-over: on or before today, and fixed once opening balances are posted (decision 3). */
export function cutOverProblem(value: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Choose the cut-over date.';
  if (value > today) return 'The cut-over is today or a day before it, never later.';
  return null;
}

/** OQ-29: a company with one user confirms its own request after the cooling-off. */
export function approvalText(
  approval: OnboardingBatchView['approval'],
  time: (iso: string) => string,
): string | null {
  if (!approval) return null;
  if (approval.selfConfirmFrom)
    return `A second person approves it in Approvals. With no one else in the company, you can confirm it yourself from ${time(approval.selfConfirmFrom)}, after the cooling-off.`;
  return 'A second person approves it in Approvals. Nothing is posted until then.';
}

export const ONBOARDING_MESSAGES: Record<string, string> = {
  CUT_OVER_FIXED: 'The cut-over is fixed: opening balances have been posted on it.',
  STEP_ORDER:
    'An earlier step is missing: leases need their units from the register, and balances need the leases they name.',
  NOT_VALIDATED: 'Check the file first; it is previewed and committed only once checked.',
  HAS_ISSUES: 'The file has problems. Fix them in the workbook and upload it again.',
  CUT_OVER_MISSING: 'Set the cut-over date before opening balances are committed.',
  SCAN_PRESENT: 'This lease already has its scan.',
};

/** The plain words for an onboarding refusal, or null to use the API's own. */
export const onboardingMessage = (error: unknown): string | null =>
  ONBOARDING_MESSAGES[errorCode(error)] ?? null;

/** "Cut-over 31 Oct 2026, fixed" for the screen's header. */
export function cutOverText(state: Pick<OnboardingState, 'cutOverDate' | 'cutOverFixed'>): string {
  if (!state.cutOverDate) return 'No cut-over date yet.';
  return `Cut-over ${formatBusinessDate(state.cutOverDate)}${state.cutOverFixed ? ', fixed: opening balances are posted on it' : ''}.`;
}
