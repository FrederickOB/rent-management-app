import type { Me } from '@rent/contracts';
import {
  DATA_PROTECTION_REQUEST_KINDS,
  DATA_PROTECTION_REQUEST_STATUSES,
  RETENTION_CATEGORIES,
} from '@rent/domain/data-protection';
import { ONBOARDING_BATCH_KINDS, ONBOARDING_BATCH_STATUSES } from '@rent/domain/onboarding';
import { describe, expect, it } from 'vitest';
import {
  DATA_PROTECTION_MESSAGES,
  dataProtectionMessage,
  dueText,
  erasureLines,
  isClosed,
  nextStatuses,
  receivedProblem,
  REQUEST_KIND_LABELS,
  REQUEST_STATUS_LABELS,
  RETENTION_CATEGORY_LABELS,
} from './data-protection';
import { scanNote } from './document-scan';
import { QUARANTINED_TEXT, SCAN_PENDING_TEXT, toProblem } from './errors';
import { navFor } from '../components/nav';
import {
  approvalText,
  BATCH_KIND_LABELS,
  BATCH_STATUS_LABELS,
  balanceWord,
  canCommit,
  changedFigures,
  countRows,
  cutOverProblem,
  cutOverText,
  hasPreview,
  isBusy,
  ONBOARDING_MESSAGES,
  onboardingMessage,
  totalsRows,
} from './onboarding';
import {
  ageText,
  alertContextRows,
  alertDataOf,
  heartbeatText,
  opsReasonProblem,
  retentionStatusText,
  thresholdsText,
} from './ops';
import { gate1ExtraRows, gate1Targets, type Gate1 } from './reporting';

const time = (iso: string) => `[${iso}]`;

describe('P25 onboarding: steps, reports and the preview in words', () => {
  it('names every batch kind and status', () => {
    for (const kind of ONBOARDING_BATCH_KINDS) expect(BATCH_KIND_LABELS[kind]).toBeTruthy();
    for (const status of ONBOARDING_BATCH_STATUSES)
      expect(BATCH_STATUS_LABELS[status]).toBeTruthy();
  });

  it('waits while the worker reads or posts, and commits only a clean check', () => {
    expect(
      ['uploaded', 'validating', 'committing', 'posting'].every((s) => isBusy(s as never)),
    ).toBe(true);
    expect(isBusy('validated')).toBe(false);
    expect(isBusy('awaiting_approval')).toBe(false);
    const report = { issueCount: 0 } as never;
    expect(canCommit({ status: 'validated', report })).toBe(true);
    expect(canCommit({ status: 'validated', report: { issueCount: 2 } as never })).toBe(false);
    expect(canCommit({ status: 'invalid', report })).toBe(false);
    expect(hasPreview('tenancies')).toBe(false);
    expect(hasPreview('balances')).toBe(true);
    expect(hasPreview('adjustment')).toBe(true);
  });

  it('lists counts by sheet and the money a commit posts', () => {
    expect(
      countRows({
        Tenants: { create: 3, update: 1, unchanged: 0 },
        Leases: { create: 3, update: 0, unchanged: 1 },
      }).map((r) => [r.sheet, r.create, r.update, r.unchanged]),
    ).toEqual([
      ['Tenants', 3, 1, 0],
      ['Leases', 3, 0, 1],
    ]);
    expect(
      totalsRows({
        arrearsMinor: 1,
        advancesMinor: 2,
        depositsMinor: 3,
        withholdingMinor: 4,
        agentCashMinor: 5,
        rentTaxOutstandingMinor: 6,
      }).map((r) => [r.label, r.amountMinor]),
    ).toEqual([
      ['Arrears', 1],
      ['Paid ahead', 2],
      ['Deposits held', 3],
      ['Withholding to certify', 4],
      ['Agent-held cash', 5],
      ['Rent tax outstanding', 6],
    ]);
  });

  it('shows an adjustment’s changed figures only, and a balance in words', () => {
    const figures = {
      arrearsMinor: 10_000,
      arrearsByAge: { '0_30': 10_000, '31_60': 0, '61_90': 0, '90_plus': 0 },
      advanceMinor: 0,
      paidUntil: null,
      depositHeldMinor: 50_000,
      withholdingOutstandingMinor: 0,
      balanceMinor: 10_000,
    };
    expect(changedFigures(null, figures)).toEqual([]);
    expect(
      changedFigures(figures, { ...figures, arrearsMinor: 5_000, balanceMinor: 5_000 }),
    ).toEqual(['arrearsMinor', 'balanceMinor']);
    expect(balanceWord(1)).toBe('owes');
    expect(balanceWord(-1)).toBe('in credit');
    expect(balanceWord(0)).toBe('settled');
  });

  it('keeps the cut-over on or before today, and says when it is fixed', () => {
    expect(cutOverProblem('2026-11-10', '2026-11-10')).toBeNull();
    expect(cutOverProblem('2026-10-31', '2026-11-10')).toBeNull();
    expect(cutOverProblem('2026-11-11', '2026-11-10')).toMatch(/never later/);
    expect(cutOverProblem('', '2026-11-10')).toBe('Choose the cut-over date.');
    expect(cutOverText({ cutOverDate: null, cutOverFixed: false })).toBe('No cut-over date yet.');
    expect(cutOverText({ cutOverDate: '2026-10-31', cutOverFixed: true })).toBe(
      'Cut-over 31 Oct 2026, fixed: opening balances are posted on it.',
    );
  });

  it('asks a second person, or after the cooling-off the only user (OQ-29)', () => {
    expect(approvalText(null, time)).toBeNull();
    expect(approvalText({ requestId: 'r', status: 'pending', selfConfirmFrom: null }, time)).toBe(
      'A second person approves it in Approvals. Nothing is posted until then.',
    );
    expect(
      approvalText(
        { requestId: 'r', status: 'pending', selfConfirmFrom: '2026-11-11T09:00:00.000Z' },
        time,
      ),
    ).toContain('you can confirm it yourself from [2026-11-11T09:00:00.000Z]');
  });

  it('puts every onboarding refusal into words', () => {
    for (const code of [
      'CUT_OVER_FIXED',
      'STEP_ORDER',
      'NOT_VALIDATED',
      'HAS_ISSUES',
      'CUT_OVER_MISSING',
      'SCAN_PRESENT',
    ])
      expect(onboardingMessage({ status: 409, code }), code).toBe(ONBOARDING_MESSAGES[code]);
    expect(onboardingMessage({ status: 409, code: 'OTHER' })).toBeNull();
  });
});

describe('NFR-DP the request register in words', () => {
  it('names every kind, status and retention category', () => {
    for (const kind of DATA_PROTECTION_REQUEST_KINDS)
      expect(REQUEST_KIND_LABELS[kind]).toBeTruthy();
    for (const status of DATA_PROTECTION_REQUEST_STATUSES)
      expect(REQUEST_STATUS_LABELS[status]).toBeTruthy();
    for (const category of RETENTION_CATEGORIES)
      expect(RETENTION_CATEGORY_LABELS[category]).toBeTruthy();
  });

  it('leaves the due date blank while counsel has not set the response time (OQ-65)', () => {
    expect(dueText({ dueOn: null, dueRuleUnverified: true })).toBe(
      'No due date yet: the response time is still to be set by counsel.',
    );
    expect(dueText({ dueOn: '2026-12-10', dueRuleUnverified: true })).toBe(
      'Due 10 Dec 2026 (the response time is not yet verified by counsel)',
    );
    expect(dueText({ dueOn: '2026-12-10', dueRuleUnverified: false })).toBe('Due 10 Dec 2026');
  });

  it('moves a request on, and closes it for good', () => {
    expect(nextStatuses('received')).toEqual(['in_progress', 'completed', 'refused']);
    expect(nextStatuses('in_progress')).toEqual(['completed', 'refused']);
    expect(nextStatuses('completed')).toEqual([]);
    expect(isClosed('refused')).toBe(true);
    expect(isClosed('in_progress')).toBe(false);
    expect(receivedProblem('2026-11-11', '2026-11-10')).toMatch(/today or earlier/);
    expect(receivedProblem('2026-11-10', '2026-11-10')).toBeNull();
  });

  it('says what an erasure anonymised and what is held, until when and why', () => {
    expect(
      erasureLines({
        messagingStopped: true,
        anonymised: [{ category: 'messages', records: 12 }],
        held: [
          {
            category: 'financial_and_notices',
            records: 3,
            until: null,
            reason: 'The retention rule is not yet verified.',
          },
          { category: 'identity', records: 1, until: '2032-11-10', reason: 'Act 915 s.27' },
        ],
      }),
    ).toEqual([
      'Messages to the tenant have stopped on every channel.',
      'Messages: 12 records anonymised.',
      'Financial records and notices: 3 records kept until the retention period is set, because the retention rule is not yet verified.',
      'Identity checks: 1 record kept until 10 Nov 2032, because act 915 s.27.',
    ]);
  });

  it('puts every register refusal into words', () => {
    for (const code of Object.keys(DATA_PROTECTION_MESSAGES))
      expect(dataProtectionMessage({ status: 409, code })).toBe(DATA_PROTECTION_MESSAGES[code]);
  });
});

describe('NFR-AVAIL queue ages, the heartbeat and replay reasons', () => {
  it('writes ages and thresholds plainly', () => {
    expect(ageText(null)).toBe('None waiting');
    expect(ageText(45)).toBe('45 s');
    expect(ageText(12 * 60)).toBe('12 min');
    expect(ageText(3 * 3600 + 5 * 60)).toBe('3 h 5 min');
    expect(ageText(2 * 3600)).toBe('2 h');
    expect(thresholdsText(300, 900)).toBe('warning after 5 min, critical after 15 min');
  });

  it('says whether the worker is running', () => {
    expect(heartbeatText({ healthy: true, ageSeconds: 20 })).toBe(
      'The worker is running: last heard from 20 s ago.',
    );
    expect(heartbeatText({ healthy: false, ageSeconds: 600 })).toBe(
      'The worker has not reported in for 10 min. Jobs are not being run.',
    );
    expect(heartbeatText({ healthy: false, ageSeconds: null })).toBe(
      'The worker has never reported in.',
    );
  });

  it('takes a reason of 5 to 500 characters for a replay or retry', () => {
    expect(opsReasonProblem('abc')).toMatch(/at least 5/);
    expect(opsReasonProblem('Provider was down at 09:00')).toBeNull();
    expect(opsReasonProblem('x'.repeat(501))).toMatch(/under 500/);
  });
});

describe('PRD section 19 Gate 1 targets and the M11 measures', () => {
  const base = {
    collectionRate: {
      dueMinor: 0,
      collectedMinor: 0,
      rate: { numerator: 0, denominator: 0, bps: null },
    },
  } as unknown as Gate1;

  it('reads met, missed or not measurable from the API', () => {
    const g = {
      ...base,
      targets: {
        collectionRate: { targetBps: 9_500, met: true },
        autoMatch: { targetBps: 9_500, met: null },
      },
    } as Gate1;
    expect(gate1Targets(g).map((t) => [t.key, t.state, t.text])).toEqual([
      ['collection', 'met', 'Target 95%: met'],
      ['auto_match', 'unknown', 'Target 95%: not measurable yet'],
    ]);
    expect(gate1Targets(base)).toEqual([]);
  });

  it('adds the new measures only when the month has them, and NRR needs 12 months', () => {
    expect(gate1ExtraRows(base)).toEqual([]);
    const rows = gate1ExtraRows({
      ...base,
      arrearsOver60: {
        arrearsMinor: 50_000,
        rentRollMinor: 1_000_000,
        share: { numerator: 50_000, denominator: 1_000_000, bps: 500 },
        baselineMonth: null,
        baselineShare: null,
      },
      netRevenueRetention: { available: false, monthsOfHistory: 3, share: null },
    } as Gate1);
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['arrears_60', '5%'],
      ['nrr', '—'],
    ]);
    expect(rows[0]!.detail).toContain('no baseline yet');
    expect(rows[1]!.detail).toBe('Needs 12 months of subscription invoices; 3 so far');
  });
});

describe('NFR-SEC a file is opened only once its malware scan is clean', () => {
  it('words the two scan refusals everywhere, and as a note on a file button', () => {
    const pending = {
      status: 409,
      data: { body: { code: 'DOCUMENT_SCAN_PENDING', message: 'x' } },
    };
    const quarantined = { status: 410, data: { body: { code: 'document_quarantined' } } };
    expect(toProblem(pending).message).toBe(SCAN_PENDING_TEXT);
    expect(toProblem(quarantined).message).toBe(QUARANTINED_TEXT);
    expect(scanNote(pending)).toEqual({ state: 'pending', text: SCAN_PENDING_TEXT });
    expect(scanNote(quarantined)).toEqual({ state: 'quarantined', text: QUARANTINED_TEXT });
    expect(scanNote({ status: 404, code: 'NOT_FOUND' })).toBeNull();
    expect(QUARANTINED_TEXT).toMatch(/failed the virus check, so it can’t be opened/);
  });
});

describe('P25 onboarding and NFR-DP the menu follows the policy, never a role', () => {
  const member = (
    role: string,
    options: {
      readonly scope?: { properties?: string[] };
      readonly phone?: boolean;
      readonly platform?: boolean;
    } = {},
  ): Me =>
    ({
      personId: '019a3000-0000-7000-8000-0000000000aa',
      name: 'Someone (demo)',
      state: 'ready',
      authMethod: options.phone ? 'phone_otp' : 'password_totp',
      sessionExpiresAt: '2026-11-10T13:00:00.000Z',
      actorKind: options.platform ? 'platform_admin' : 'staff',
      activeCompanyId: '019a3000-0000-7000-8000-000000000001',
      role,
      memberships: [
        {
          membershipId: '019a3000-0000-7000-8000-0000000000bb',
          companyId: '019a3000-0000-7000-8000-000000000001',
          companyName: 'Demo company',
          companyKind: options.platform ? 'platform' : 'agency',
          role,
          nominatedApprover: false,
          ...(options.scope ? { scope: options.scope } : {}),
        },
      ],
    }) as Me;
  const m11 = (me: Me) =>
    navFor(me, [])
      .map((item) => item.label)
      .filter((label) => label === 'Onboarding' || label === 'Data protection');

  it('gives onboarding to admins and unscoped managers, and data protection to admins', () => {
    expect(m11(member('agency_admin'))).toEqual(['Onboarding', 'Data protection']);
    expect(m11(member('property_manager'))).toEqual(['Onboarding']);
  });

  it('keeps both from scoped staff, caretakers, advisers and platform admins', () => {
    expect(
      m11(
        member('property_manager', {
          scope: { properties: ['019a3000-0000-7000-8000-0000000000c1'] },
        }),
      ),
    ).toEqual([]);
    expect(
      m11(
        member('caretaker', {
          phone: true,
          scope: { properties: ['019a3000-0000-7000-8000-0000000000c1'] },
        }),
      ),
    ).toEqual([]);
    expect(m11(member('adviser'))).toEqual([]);
    expect(m11(member('platform_admin', { platform: true }))).toEqual([]);
  });
});

describe('NFR-AVAIL and NFR-DP an alert’s context, and the retention review, in words', () => {
  it('lists an alert’s stored context as text, key by key', () => {
    expect(
      alertContextRows({
        mismatches: [{ invoiceLineId: 'l1', differenceMinor: 500 }],
        count: 3,
        note: '<b>not html</b>',
        none: null,
      }),
    ).toEqual([
      { key: 'mismatches', value: '[{"invoiceLineId":"l1","differenceMinor":500}]' },
      { key: 'count', value: '3' },
      { key: 'note', value: '<b>not html</b>' },
      { key: 'none', value: '—' },
    ]);
    expect(alertContextRows(null)).toEqual([]);
    expect(alertContextRows(['a'])).toEqual([]);
    expect(alertDataOf({ code: 'x' })).toBeUndefined();
    expect(alertDataOf({ code: 'x', data: { a: 1 } })).toEqual({ a: 1 });
  });

  it('says an unverified rule keeps everything, and a verified one its period', () => {
    expect(retentionStatusText({ verified: false, years: null })).toBe(
      'No value yet: counsel must supply it. Everything is kept.',
    );
    expect(retentionStatusText({ verified: false, years: 6 })).toBe(
      '6 years, not yet verified by counsel: nothing is counted, everything is kept.',
    );
    expect(retentionStatusText({ verified: true, years: 6 })).toBe('Kept 6 years.');
  });
});
