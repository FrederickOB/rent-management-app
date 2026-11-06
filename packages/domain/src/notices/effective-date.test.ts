import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, compareDates, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';
import { parseRuleValue, type VerificationStatus } from '../rules';
import {
  ASSESSMENT_BAR_KEY,
  assertEffectiveDate,
  assertNotQuitBarred,
  checkEffectiveDate,
  checkQuitBar,
  earliestLawfulDate,
  quitBarredUntil,
  servedTooLate,
  statutoryMinimumKey,
  type EarliestDateInput,
  type NoticeLeaseFacts,
  type NoticeRuleInput,
} from './effective-date';
import { noticeIssueBlockers, quitNoticesEnabled } from './issue';
import type { NoticeType } from './types';

const lease = (over: Partial<NoticeLeaseFacts> = {}): NoticeLeaseFacts => ({
  use: 'residential',
  noticeDays: 30,
  endDate: '2027-10-31',
  electronicServiceClause: true,
  ...over,
});

/** The statutory-minimum row as seeded in M1: null and unverified (D7). */
const seededStatutory = (use: 'residential' | 'commercial' = 'residential'): NoticeRuleInput => ({
  id: `rule-statutory-${use}`,
  key: statutoryMinimumKey(use),
  value: null,
  verificationStatus: 'unverified',
});

const statutory = (
  days: number,
  status: VerificationStatus = 'verified',
  use: 'residential' | 'commercial' = 'residential',
): NoticeRuleInput => ({
  id: `rule-statutory-${use}-${days}`,
  key: statutoryMinimumKey(use),
  value: { days },
  verificationStatus: status,
});

const barRule = (months = 24, status: VerificationStatus = 'unverified'): NoticeRuleInput => ({
  id: 'rule-bar',
  key: ASSESSMENT_BAR_KEY,
  value: { months },
  verificationStatus: status,
});

const quit = (over: Partial<EarliestDateInput> = {}): EarliestDateInput => ({
  type: 'notice_to_quit',
  lease: lease(),
  issueDate: '2026-11-04',
  statutoryRule: seededStatutory(),
  wordingReviewed: false,
  ...over,
});

const codes = (input: EarliestDateInput) => earliestLawfulDate(input).warnings.map((w) => w.code);

describe('LN-01 earliest lawful date', () => {
  it('counts the lease’s notice days from electronic service on the issue date (D7: statutory null)', () => {
    const result = earliestLawfulDate(quit());
    expect(result).toMatchObject({
      earliestDate: '2026-12-04',
      serviceDate: '2026-11-04',
      serviceDateBasis: 'electronic_issue',
      periodDays: 30,
      periodSource: 'contractual',
      contractualDays: 30,
      statutoryDays: null,
      leaseEndApplied: false,
    });
    expect(result.rulesUsed).toEqual([
      {
        key: 'notice_to_quit.statutory_min_days.residential',
        ruleId: 'rule-statutory-residential',
        value: null,
        verificationStatus: 'unverified',
      },
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual([
      'statutory_minimum_unverified',
      'statutory_minimum_not_set',
      'counsel_wording_outstanding',
    ]);
    expect(result.warnings[0]!.ruleKey).toBe('notice_to_quit.statutory_min_days.residential');
    expect(result.warnings[0]!.message).toMatch(/unverified: counsel to confirm/);
  });

  it('uses a longer statutory minimum once one is entered, and names its status', () => {
    const verified = earliestLawfulDate(quit({ statutoryRule: statutory(90) }));
    expect(verified).toMatchObject({
      earliestDate: '2027-02-02',
      periodDays: 90,
      periodSource: 'statutory',
      statutoryDays: 90,
    });
    expect(verified.warnings.map((w) => w.code)).toEqual(['counsel_wording_outstanding']);

    const fromPrd = earliestLawfulDate(
      quit({ statutoryRule: statutory(90, 'from_prd'), wordingReviewed: true }),
    );
    expect(fromPrd.warnings.map((w) => w.code)).toEqual(['statutory_minimum_unverified']);
    expect(fromPrd.warnings[0]!.message).toMatch(/taken from the PRD/);
  });

  it('keeps the contractual period when it is the longer one, a tie included', () => {
    expect(earliestLawfulDate(quit({ statutoryRule: statutory(10) }))).toMatchObject({
      periodDays: 30,
      periodSource: 'contractual',
    });
    expect(earliestLawfulDate(quit({ statutoryRule: statutory(30) }))).toMatchObject({
      periodDays: 30,
      periodSource: 'contractual',
    });
  });

  it('reads the statutory key for the lease’s use and refuses another rule', () => {
    const commercial = quit({
      lease: lease({ use: 'commercial', noticeDays: 90 }),
      statutoryRule: seededStatutory('commercial'),
    });
    expect(earliestLawfulDate(commercial).rulesUsed[0]!.key).toBe(
      'notice_to_quit.statutory_min_days.commercial',
    );
    expect(() =>
      earliestLawfulDate(quit({ statutoryRule: seededStatutory('commercial') })),
    ).toThrow(expect.objectContaining({ code: 'notice.rule_mismatch' }));
  });

  it('warns and enforces only the lease when no statutory row is in force', () => {
    const result = earliestLawfulDate(quit({ statutoryRule: null, wordingReviewed: true }));
    expect(result.earliestDate).toBe('2026-12-04');
    expect(result.rulesUsed).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['statutory_rule_missing']);
  });

  it('counts from physical service without the electronic-service clause (decision 4)', () => {
    const planned = earliestLawfulDate(quit({ lease: lease({ electronicServiceClause: false }) }));
    expect(planned).toMatchObject({
      serviceDate: '2026-11-04',
      serviceDateBasis: 'planned_issue',
      earliestDate: '2026-12-04',
    });
    expect(planned.warnings.map((w) => w.code)).toContain('no_electronic_service_clause');
    expect(
      planned.warnings.find((w) => w.code === 'no_electronic_service_clause')!.message,
    ).toMatch(/period runs from the day it is served/);

    const served = earliestLawfulDate(
      quit({
        lease: lease({ electronicServiceClause: false }),
        physicalServiceDate: '2026-11-09',
      }),
    );
    expect(served).toMatchObject({
      serviceDate: '2026-11-09',
      serviceDateBasis: 'physical_service',
      earliestDate: '2026-12-09',
    });
  });

  it('counts from physical service when every channel is withheld after an opt-out (decision 5)', () => {
    const result = earliestLawfulDate(
      quit({ electronicChannelsWithheld: true, physicalServiceDate: '2026-11-06' }),
    );
    expect(result).toMatchObject({
      serviceDateBasis: 'physical_service',
      earliestDate: '2026-12-06',
    });
    expect(result.warnings.map((w) => w.code)).toContain('electronic_service_withheld');
  });

  it('ignores a physical service date when service was electronic', () => {
    expect(earliestLawfulDate(quit({ physicalServiceDate: '2026-11-20' }))).toMatchObject({
      serviceDate: '2026-11-04',
      earliestDate: '2026-12-04',
    });
  });

  it('refuses physical service before the issue date', () => {
    expect(() =>
      earliestLawfulDate(
        quit({
          lease: lease({ electronicServiceClause: false }),
          physicalServiceDate: '2026-11-03',
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'notice.service_before_issue' }));
  });

  it('never lets a non-renewal take effect before the lease ends', () => {
    const late = earliestLawfulDate({
      type: 'non_renewal',
      lease: lease({ endDate: '2027-03-31' }),
      issueDate: '2026-11-04',
      wordingReviewed: true,
    });
    expect(late).toMatchObject({ earliestDate: '2027-03-31', leaseEndApplied: true });
    expect(late.rulesUsed).toEqual([]);

    const soon = earliestLawfulDate({
      type: 'non_renewal',
      lease: lease({ endDate: '2026-11-20' }),
      issueDate: '2026-11-04',
      wordingReviewed: true,
    });
    expect(soon).toMatchObject({ earliestDate: '2026-12-04', leaseEndApplied: false });
  });

  it('uses the contractual period for a rent review and none for a rent demand', () => {
    const review = earliestLawfulDate({
      type: 'rent_review',
      lease: lease({ noticeDays: 60 }),
      issueDate: '2026-11-04',
      wordingReviewed: true,
    });
    expect(review).toMatchObject({ earliestDate: '2027-01-03', periodSource: 'contractual' });
    const demand = earliestLawfulDate({
      type: 'rent_demand',
      lease: lease(),
      issueDate: '2026-11-04',
      wordingReviewed: true,
    });
    expect(demand).toMatchObject({
      earliestDate: '2026-11-04',
      periodDays: 0,
      periodSource: 'none',
    });
    expect(demand.warnings).toEqual([]);
  });

  it('warns that no period is recorded for entry and breach notices', () => {
    for (const type of ['entry', 'breach'] as const)
      expect(
        codes({ type, lease: lease(), issueDate: '2026-11-04', wordingReviewed: true }),
      ).toEqual(['no_period_enforced']);
  });

  it('needs a lease except for a building-wide notice', () => {
    expect(
      earliestLawfulDate({
        type: 'building_wide',
        lease: null,
        issueDate: '2026-11-04',
        wordingReviewed: true,
      }),
    ).toMatchObject({ serviceDateBasis: 'issue', earliestDate: '2026-11-04', warnings: [] });
    expect(() =>
      earliestLawfulDate({
        type: 'rent_review',
        lease: null,
        issueDate: '2026-11-04',
        wordingReviewed: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'notice.lease_required' }));
  });

  it('refuses a lease notice period outside 0 to 3650 days', () => {
    expect(() => earliestLawfulDate(quit({ lease: lease({ noticeDays: -1 }) }))).toThrow(
      expect.objectContaining({ code: 'notice.lease_notice_days_invalid' }),
    );
    expect(() => earliestLawfulDate(quit({ lease: lease({ noticeDays: 1.5 }) }))).toThrow(
      DomainError,
    );
  });

  it('refuses an effective date before the earliest date, at the composer and at issue', () => {
    const tooEarly = checkEffectiveDate({ ...quit(), effectiveDate: '2026-12-03' });
    expect(tooEarly).toMatchObject({ ok: false, shortByDays: 1 });
    expect(tooEarly.reason).toBe(
      "The effective date must be on or after 4 December 2026: the lease's 30-day notice period, counted from 4 November 2026, the day it is served.",
    );
    expect(() => assertEffectiveDate({ ...quit(), effectiveDate: '2026-12-03' })).toThrow(
      expect.objectContaining({ code: 'notice.effective_date_too_early' }),
    );
    expect(checkEffectiveDate({ ...quit(), effectiveDate: '2026-12-04' })).toMatchObject({
      ok: true,
      reason: null,
    });
  });

  it('a date that held at the composer is refused at issue once approval took too long', () => {
    const composed = checkEffectiveDate({ ...quit(), effectiveDate: '2026-12-04' });
    expect(composed.ok).toBe(true);
    const atIssue = checkEffectiveDate({
      ...quit({ issueDate: '2026-11-06' }),
      effectiveDate: '2026-12-04',
    });
    expect(atIssue).toMatchObject({ ok: false, shortByDays: 2 });
  });

  it('checks a no-period type’s date against the service date', () => {
    const base = {
      type: 'rent_demand' as const,
      lease: lease(),
      issueDate: '2026-11-04',
      wordingReviewed: true,
    };
    expect(checkEffectiveDate({ ...base, effectiveDate: '2026-11-03' })).toMatchObject({
      ok: false,
      reason: 'The pay-by date cannot be before 4 November 2026, the day the notice is served.',
    });
    expect(checkEffectiveDate({ ...base, effectiveDate: '2026-11-04' }).ok).toBe(true);
    expect(
      checkEffectiveDate({
        type: 'building_wide',
        lease: null,
        issueDate: '2026-11-04',
        wordingReviewed: true,
        effectiveDate: null,
      }).ok,
    ).toBe(true);
    expect(() => checkEffectiveDate({ ...quit(), effectiveDate: null })).toThrow(
      expect.objectContaining({ code: 'notice.effective_date_required' }),
    );
  });

  it('is never earlier than service plus every applicable period (property-based)', () => {
    const periodTypes: NoticeType[] = ['rent_review', 'notice_to_quit', 'non_renewal'];
    fc.assert(
      fc.property(
        fc.record({
          type: fc.constantFrom(...periodTypes),
          use: fc.constantFrom('residential' as const, 'commercial' as const),
          noticeDays: fc.integer({ min: 0, max: 400 }),
          statutoryDays: fc.option(fc.integer({ min: 0, max: 400 })),
          rulePresent: fc.boolean(),
          status: fc.constantFrom<VerificationStatus>('verified', 'from_prd', 'unverified'),
          clause: fc.boolean(),
          withheld: fc.boolean(),
          issueOffset: fc.integer({ min: 0, max: 1500 }),
          serviceDelay: fc.option(fc.integer({ min: 0, max: 60 })),
          endOffset: fc.integer({ min: -400, max: 900 }),
          effectiveOffset: fc.integer({ min: -100, max: 1000 }),
        }),
        (c) => {
          const issue = addDays(parseBusinessDate('2026-01-01'), c.issueOffset);
          const physical = c.serviceDelay === null ? null : addDays(issue, c.serviceDelay);
          const end = addDays(issue, c.endOffset);
          const effective = addDays(issue, c.effectiveOffset);
          const rule: NoticeRuleInput | null = c.rulePresent
            ? {
                id: 'r',
                key: statutoryMinimumKey(c.use),
                value: c.statutoryDays === null ? null : { days: c.statutoryDays },
                verificationStatus: c.status,
              }
            : null;
          const check = checkEffectiveDate({
            type: c.type,
            lease: {
              use: c.use,
              noticeDays: c.noticeDays,
              endDate: toIsoDate(end),
              electronicServiceClause: c.clause,
            },
            electronicChannelsWithheld: c.withheld,
            issueDate: toIsoDate(issue),
            physicalServiceDate: physical ? toIsoDate(physical) : null,
            statutoryRule: rule,
            wordingReviewed: true,
            effectiveDate: toIsoDate(effective),
          });
          // The service date, worked out again here.
          const electronic = c.clause && !c.withheld;
          const service = electronic || !physical ? issue : physical;
          const floors = [addDays(service, c.noticeDays)];
          if (c.type === 'notice_to_quit' && rule && c.statutoryDays !== null)
            floors.push(addDays(service, c.statutoryDays));
          if (c.type === 'non_renewal') floors.push(end);
          const holds = floors.every((f) => compareDates(effective, f) >= 0);
          expect(check.ok).toBe(holds);
          expect(
            compareDates(parseBusinessDate(check.earliest.serviceDate), issue),
          ).toBeGreaterThanOrEqual(0);
          for (const f of floors)
            expect(
              compareDates(parseBusinessDate(check.earliest.earliestDate), f),
            ).toBeGreaterThanOrEqual(0);
          if (c.type === 'notice_to_quit' && c.status !== 'verified' && rule)
            expect(check.earliest.warnings.map((w) => w.code)).toContain(
              'statutory_minimum_unverified',
            );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses at issue exactly the dates that stopped holding (property-based)', () => {
    fc.assert(
      fc.property(
        fc.record({
          noticeDays: fc.integer({ min: 0, max: 120 }),
          slack: fc.integer({ min: 0, max: 30 }),
          delay: fc.integer({ min: 0, max: 60 }),
          statutoryAtIssue: fc.option(fc.integer({ min: 0, max: 200 })),
          clause: fc.boolean(),
        }),
        (c) => {
          const composeDay = parseBusinessDate('2026-11-04');
          const issueDay = addDays(composeDay, c.delay);
          const leaseFacts = lease({ noticeDays: c.noticeDays, electronicServiceClause: c.clause });
          const composer = earliestLawfulDate(
            quit({ lease: leaseFacts, issueDate: toIsoDate(composeDay) }),
          );
          const effectiveDate = toIsoDate(
            addDays(parseBusinessDate(composer.earliestDate), c.slack),
          );
          expect(checkEffectiveDate({ ...quit({ lease: leaseFacts }), effectiveDate }).ok).toBe(
            true,
          );
          const ruleAtIssue =
            c.statutoryAtIssue === null
              ? seededStatutory()
              : statutory(c.statutoryAtIssue, 'unverified');
          const atIssue = {
            ...quit({
              lease: leaseFacts,
              issueDate: toIsoDate(issueDay),
              statutoryRule: ruleAtIssue,
            }),
            effectiveDate,
          };
          const recheck = checkEffectiveDate(atIssue);
          const period = Math.max(c.noticeDays, c.statutoryAtIssue ?? 0);
          const stillHolds =
            compareDates(parseBusinessDate(effectiveDate), addDays(issueDay, period)) >= 0;
          expect(recheck.ok).toBe(stillHolds);
          const blockers = noticeIssueBlockers({
            type: 'notice_to_quit',
            effective: atIssue,
            assessments: [],
            assessmentBarRule: null,
            quitAcknowledged: true,
          }).blockers.map((b) => b.code);
          expect(blockers.includes('notice.effective_date_too_early')).toBe(!stillHolds);
          if (c.statutoryAtIssue === null && c.delay > c.slack) expect(recheck.ok).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('LN-01 late physical service', () => {
  const noClause = quit({ lease: lease({ electronicServiceClause: false }) });

  it('flags a notice served too late for its stated date', () => {
    const late = servedTooLate({
      ...noClause,
      effectiveDate: '2026-12-04',
      physicalServiceDate: '2026-11-09',
    });
    expect(late).toMatchObject({
      tooLate: true,
      earliestFromService: '2026-12-09',
      shortByDays: 5,
    });
    expect(late.reason).toMatch(
      /^Served too late for its date\. .*physical service on 9 November 2026/,
    );
    expect(
      servedTooLate({
        ...noClause,
        effectiveDate: '2026-12-09',
        physicalServiceDate: '2026-11-09',
      }),
    ).toMatchObject({ tooLate: false, reason: null });
  });

  it('never flags a notice served electronically', () => {
    expect(
      servedTooLate({ ...quit(), effectiveDate: '2026-12-04', physicalServiceDate: '2026-11-30' })
        .tooLate,
    ).toBe(false);
  });
});

describe('LN-01 s.23 bar (decision 3)', () => {
  it('registers the bar rule as whole months that cannot be null', () => {
    expect(parseRuleValue(ASSESSMENT_BAR_KEY, { months: 24 })).toEqual({ months: 24 });
    expect(() => parseRuleValue(ASSESSMENT_BAR_KEY, null)).toThrow(
      expect.objectContaining({ code: 'rule.null_value' }),
    );
    expect(() => parseRuleValue(ASSESSMENT_BAR_KEY, { months: 1.5 })).toThrow(
      expect.objectContaining({ code: 'rule.bad_value' }),
    );
  });

  it('bars until the anniversary of the latest assessment, inclusive', () => {
    expect(quitBarredUntil([], 24)).toBeNull();
    expect(quitBarredUntil([{ date: '2025-03-10' }], 24)).toBe('2027-03-10');
    expect(quitBarredUntil([{ date: '2025-03-10' }, { date: '2024-01-01' }], 24)).toBe(
      '2027-03-10',
    );
    expect(quitBarredUntil([{ date: '2024-02-29' }], 24)).toBe('2026-02-28');
    expect(() => quitBarredUntil([{ date: '2025-03-10' }], -1)).toThrow(DomainError);
  });

  it('blocks a notice to quit inside the bar and shows the rule’s status', () => {
    const input = {
      type: 'notice_to_quit' as const,
      issueDate: '2027-03-10',
      assessments: [{ date: '2025-03-10' }],
      rule: barRule(),
    };
    const barred = checkQuitBar(input);
    expect(barred).toMatchObject({
      barred: true,
      barredUntil: '2027-03-10',
      latestAssessment: '2025-03-10',
      ruleUsed: { key: ASSESSMENT_BAR_KEY, ruleId: 'rule-bar', verificationStatus: 'unverified' },
    });
    expect(barred.warnings.map((w) => w.code)).toEqual(['assessment_bar_unverified']);
    expect(barred.reason).toBe(
      'A notice to quit cannot be issued until after 10 March 2027: a Rent Officer assessed the unit on 10 March 2025 (Act 220 s.23, 24 months).',
    );
    expect(() => assertNotQuitBarred(input)).toThrow(
      expect.objectContaining({ code: 'notice.quit_barred' }),
    );
    expect(checkQuitBar({ ...input, issueDate: '2027-03-11' }).barred).toBe(false);
    expect(checkQuitBar({ ...input, rule: barRule(24, 'verified') }).warnings).toEqual([]);
  });

  it('never bars other types, and reads no rule without an assessment', () => {
    expect(
      checkQuitBar({
        type: 'rent_demand',
        issueDate: '2026-01-01',
        assessments: [{ date: '2025-12-01' }],
        rule: null,
      }),
    ).toMatchObject({ barred: false, ruleUsed: null });
    expect(
      checkQuitBar({
        type: 'notice_to_quit',
        issueDate: '2026-01-01',
        assessments: [],
        rule: null,
      }),
    ).toMatchObject({ barred: false, ruleUsed: null, warnings: [] });
  });

  it('refuses to guess when an assessment is on record and no bar rule is in force', () => {
    expect(() =>
      checkQuitBar({
        type: 'notice_to_quit',
        issueDate: '2026-01-01',
        assessments: [{ date: '2025-12-01' }],
        rule: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'notice.quit_bar_rule_missing' }));
    expect(() =>
      checkQuitBar({
        type: 'notice_to_quit',
        issueDate: '2026-01-01',
        assessments: [{ date: '2025-12-01' }],
        rule: { ...barRule(), key: 'notice_to_quit.statutory_min_days.residential' },
      }),
    ).toThrow(expect.objectContaining({ code: 'notice.rule_mismatch' }));
  });
});

describe('LN-01 issue checks (OQ-16, decision 3, plan 4.3)', () => {
  const effective = { ...quit(), effectiveDate: '2026-12-04' };

  it('lets a valid, acknowledged notice to quit through', () => {
    const result = noticeIssueBlockers({
      type: 'notice_to_quit',
      effective,
      assessments: [],
      assessmentBarRule: barRule(),
      quitAcknowledged: true,
    });
    expect(result.blockers).toEqual([]);
    expect(result.effective?.ok).toBe(true);
  });

  it('collects every reason a notice to quit is refused', () => {
    const result = noticeIssueBlockers({
      type: 'notice_to_quit',
      effective: { ...effective, effectiveDate: '2026-12-01' },
      assessments: [{ date: '2025-06-01' }],
      assessmentBarRule: barRule(),
      quitAcknowledged: false,
    });
    expect(result.blockers.map((b) => b.code)).toEqual([
      'notice.quit_not_enabled',
      'notice.effective_date_too_early',
      'notice.quit_barred',
    ]);
  });

  it('turns a missing bar rule into a blocker rather than a crash', () => {
    const result = noticeIssueBlockers({
      type: 'notice_to_quit',
      effective,
      assessments: [{ date: '2025-06-01' }],
      assessmentBarRule: null,
      quitAcknowledged: true,
    });
    expect(result.blockers.map((b) => b.code)).toEqual(['notice.quit_bar_rule_missing']);
    expect(result.quitBar).toBeNull();
  });

  it('needs no acknowledgement for other types, and never issues a tenant’s notice', () => {
    expect(
      noticeIssueBlockers({
        type: 'rent_demand',
        effective: {
          type: 'rent_demand',
          lease: lease(),
          issueDate: '2026-11-04',
          wordingReviewed: true,
          effectiveDate: '2026-11-18',
        },
        assessments: [{ date: '2026-01-01' }],
        assessmentBarRule: null,
        quitAcknowledged: false,
      }).blockers,
    ).toEqual([]);
    expect(
      noticeIssueBlockers({
        type: 'tenant_originated',
        effective: {
          type: 'tenant_originated',
          lease: lease(),
          issueDate: '2026-11-04',
          wordingReviewed: true,
          effectiveDate: null,
        },
        assessments: [],
        assessmentBarRule: null,
        quitAcknowledged: true,
      }).blockers.map((b) => b.code),
    ).toEqual(['notice.not_issuable']);
  });

  it('enables notices to quit while the latest acknowledgement is a grant (OQ-16)', () => {
    expect(quitNoticesEnabled([])).toBe(false);
    expect(quitNoticesEnabled([{ action: 'grant' }])).toBe(true);
    expect(quitNoticesEnabled([{ action: 'grant' }, { action: 'withdraw' }])).toBe(false);
    expect(
      quitNoticesEnabled([{ action: 'grant' }, { action: 'withdraw' }, { action: 'grant' }]),
    ).toBe(true);
  });
});
