import { ONBOARDING_BATCH_STATUSES, type OnboardingBatchStatus } from '@rent/domain/onboarding';
import { describe, expect, it } from 'vitest';
import { RECOVERY_REASON_HINT } from './account-recovery';
import {
  approvalActionLabel,
  approvalDetailsMissing,
  approvalFacts,
  approverChangeOf,
  openingBalancesOf,
  OPENING_TOTAL_COLUMNS,
  subjectHref,
} from './approvals';
import { dataProtectionMessage, EXPORT_KEPT_TEXT, leftOutText } from './data-protection';
import { APPROVAL_POLL_MS, BUSY_POLL_MS, isBusy, pollEvery, showsPreview } from './onboarding';
import { mayRunAgain } from './ops';

// M11 review round (reviewer C, screens and tests): the web fixes, by requirement.

const BATCH = '0193c3a0-0000-7000-8000-000000000001';
const OWNER_A = '0193c3a0-0000-7000-8000-0000000000a1';
const OWNER_B = '0193c3a0-0000-7000-8000-0000000000b2';
const MEMBERSHIP = '0193c3a0-0000-7000-8000-0000000000c3';
const PROPERTY = '0193c3a0-0000-7000-8000-0000000000d4';

const money = (n: number) => ({
  arrearsMinor: n,
  advancesMinor: 0,
  depositsMinor: 2 * n,
  withholdingMinor: 0,
  agentCashMinor: 20_000,
  rentTaxOutstandingMinor: 4_000,
});

const opening = {
  batchId: BATCH,
  kind: 'balances',
  cutOverDate: '2026-11-10',
  fileName: 'balances.xlsx',
  link: '/onboarding',
  leases: 3,
  owners: [
    { owner: { id: OWNER_A, name: 'Yaw Owner' }, ...money(50_000) },
    { owner: { id: OWNER_B, name: 'Ama Owner' }, ...money(25_000) },
  ],
  totals: { ...money(75_000), agentCashMinor: 40_000, rentTaxOutstandingMinor: 8_000 },
};

describe('P25 an opening balances request shows what the second person approves (review C2)', () => {
  it('is named, and links to the onboarding page where each lease is shown', () => {
    expect(approvalActionLabel('opening_balances')).toBe('Post opening balances');
    expect(
      subjectHref({ subjectType: 'onboarding_batch', subjectId: BATCH, payload: opening }),
    ).toBe('/onboarding');
  });

  it('states the batch: what it is, the cut-over, the workbook and how many leases', () => {
    expect(approvalFacts('opening_balances', opening)).toEqual([
      { label: 'What', value: 'Opening balances' },
      { label: 'Cut-over', value: '10 Nov 2026' },
      { label: 'Workbook', value: 'balances.xlsx' },
      { label: 'Leases', value: '3' },
    ]);
    expect(
      approvalFacts('opening_balances', { ...opening, kind: 'adjustment', fileName: null }),
    ).toEqual([
      { label: 'What', value: 'An adjustment to the opening balances' },
      { label: 'Cut-over', value: '10 Nov 2026' },
      { label: 'Leases', value: '3' },
    ]);
  });

  it('carries the money per owner and in total, in the preview’s columns', () => {
    const batch = openingBalancesOf(opening);
    expect(batch?.owners.map((o) => [o.owner.name, o.arrearsMinor])).toEqual([
      ['Yaw Owner', 50_000],
      ['Ama Owner', 25_000],
    ]);
    expect(batch?.totals.arrearsMinor).toBe(75_000);
    expect(OPENING_TOTAL_COLUMNS.map((c) => c.label)).toEqual([
      'Arrears',
      'Paid ahead',
      'Deposits held',
      'Withholding to certify',
      'Agent-held cash',
      'Rent tax outstanding',
    ]);
  });

  it('shows nothing it would have to guess when the payload is not of that shape', () => {
    expect(openingBalancesOf({ batchId: BATCH })).toBeNull();
    expect(approvalFacts('opening_balances', { ...opening, leases: 'three' })).toEqual([]);
    // The card says so instead (the backend's "details unavailable").
    expect(approvalDetailsMissing('opening_balances', { batchId: BATCH })).toBe(true);
    expect(approvalDetailsMissing('opening_balances', opening)).toBe(false);
  });
});

const invite = {
  membershipId: MEMBERSHIP,
  personName: 'Kofi Approver',
  change: 'invite',
  from: { role: 'property_manager', nominatedApprover: false, scope: {}, status: 'invited' },
  to: { role: 'property_manager', nominatedApprover: false, scope: {} },
  needsAcceptance: false,
};

describe('AD-07 an approver change names the person and the role from and to (founder D1, review C2)', () => {
  it('is named, and links to Users and roles', () => {
    expect(approvalActionLabel('membership.approver_change')).toBe(
      'Change who may approve requests',
    );
    expect(subjectHref({ subjectType: 'membership', subjectId: MEMBERSHIP, payload: invite })).toBe(
      '/settings/users',
    );
  });

  it('an invite: the person, the role and what they can see', () => {
    expect(approvalFacts('membership.approver_change', invite)).toEqual([
      { label: 'Person', value: 'Kofi Approver' },
      { label: 'Invited as', value: 'Property manager' },
      { label: 'Can see', value: 'The whole company' },
    ]);
    expect(
      approvalFacts('membership.approver_change', { ...invite, needsAcceptance: true }).at(-1),
    ).toEqual({
      label: 'Once approved',
      value: 'They already have an account, so they join when they accept the invitation.',
    });
  });

  it('a change: the role now and the role asked for, and the scope when it changes', () => {
    const change = {
      ...invite,
      change: 'update',
      from: {
        role: 'caretaker',
        nominatedApprover: false,
        scope: { properties: [PROPERTY] },
        status: 'active',
      },
      to: { role: 'accountant', nominatedApprover: true, scope: {} },
    };
    expect(approvalFacts('membership.approver_change', change)).toEqual([
      { label: 'Person', value: 'Kofi Approver' },
      { label: 'Role now', value: 'Caretaker' },
      { label: 'Role asked for', value: 'Accountant, nominated approver' },
      { label: 'Can see now', value: 'Only 1 property' },
      { label: 'Would see', value: 'The whole company' },
    ]);
    expect(
      approvalFacts('membership.approver_change', {
        ...change,
        from: { ...change.from, scope: {} },
      }).at(-1),
    ).toEqual({ label: 'Can see', value: 'The whole company' });
  });

  it('shows nothing for a payload of another shape', () => {
    expect(approverChangeOf({ personName: 'Kofi' })).toBeNull();
    expect(approvalFacts('membership.approver_change', null)).toEqual([]);
    expect(approvalDetailsMissing('membership.approver_change', null)).toBe(true);
    expect(approvalDetailsMissing('membership.approver_change', invite)).toBe(false);
    // Other requests keep their own summaries.
    expect(approvalDetailsMissing('payment.cash_receipt', null)).toBe(false);
  });
});

describe('P25 the onboarding batch after posting, and while it waits (review C5)', () => {
  const kinds = ['balances', 'adjustment'] as const;

  it('shows the preview from a clean check until the decision, never once posting starts', () => {
    const shown = ONBOARDING_BATCH_STATUSES.filter((status) =>
      showsPreview({ kind: 'balances', status }),
    );
    expect(shown).toEqual(['validated', 'awaiting_approval']);
    for (const kind of kinds) {
      expect(showsPreview({ kind, status: 'posting' })).toBe(false);
      expect(showsPreview({ kind, status: 'posted' })).toBe(false);
    }
    expect(showsPreview({ kind: 'tenancies', status: 'validated' })).toBe(false);
  });

  it('asks again while the worker is busy, and while the batch waits for the second person', () => {
    const every = (status: OnboardingBatchStatus) => pollEvery(status);
    expect(every('awaiting_approval')).toBe(APPROVAL_POLL_MS);
    for (const status of ONBOARDING_BATCH_STATUSES)
      if (isBusy(status)) expect(every(status)).toBe(BUSY_POLL_MS);
    for (const status of [
      'validated',
      'invalid',
      'committed',
      'posted',
      'rejected',
      'failed',
    ] as const)
      expect(every(status)).toBeNull();
  });
});

describe('NFR-DP an export is kept 7 days (founder decision 5, review C3)', () => {
  it('says so beside the export', () => {
    expect(EXPORT_KEPT_TEXT).toBe('Exports are deleted after 7 days; prepare a new one if needed.');
  });

  it('names a deleted export, and says when large files were left out of a ready one', () => {
    expect(dataProtectionMessage({ code: 'export_expired' })).toBe(
      'This export was deleted after 7 days. Prepare a new one.',
    );
    expect(leftOutText({ split: true, leftOut: 3 })).toBe(
      'Some large files weren’t included (3). They’re listed in the export, and you can download them from their records.',
    );
    expect(leftOutText({ split: false, leftOut: 0 })).toBeNull();
    expect(leftOutText({})).toBeNull();
  });
});

describe('NFR-AVAIL a dead-lettered job is run again once from the console (review)', () => {
  it('offers Run again only while the job has not been run again', () => {
    expect(mayRunAgain({ retriedAt: null })).toBe(true);
    expect(mayRunAgain({ retriedAt: '2026-11-10T09:00:00.000Z' })).toBe(false);
  });
});

describe('NFR-SEC the account recovery reason carries no personal data (review)', () => {
  it('asks for no ID numbers or personal details', () => {
    expect(RECOVERY_REASON_HINT).toContain('no ID numbers or personal details');
  });
});
