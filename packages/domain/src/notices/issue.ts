import { DomainError } from '../errors';
import {
  checkEffectiveDate,
  checkQuitBar,
  type EarliestDateInput,
  type EffectiveDateCheck,
  type NoticeRuleInput,
  type QuitBarCheck,
  type RentAssessmentFact,
} from './effective-date';
import { NOTICE_TYPE_LABELS, NOTICE_TYPE_RULES, type NoticeType } from './types';

/**
 * OQ-16 (decision 9): notices to quit are enabled while the company's latest acknowledgement
 * event is a grant. Withdrawing turns them off again; notices already issued carry on.
 */
export function quitNoticesEnabled(
  events: readonly { readonly action: 'grant' | 'withdraw' }[],
): boolean {
  return events.at(-1)?.action === 'grant';
}

export interface NoticeIssueBlocker {
  readonly code: string;
  readonly message: string;
}

export interface NoticeIssueCheck {
  readonly blockers: readonly NoticeIssueBlocker[];
  readonly effective: EffectiveDateCheck | null;
  readonly quitBar: QuitBarCheck | null;
}

/**
 * Everything that refuses an issue (plan 4.3 and 4.6), checked in the composer and again inside
 * NoticesService.issue with the actual issue date and the rules in force that day. A non-empty
 * list refuses the issue; the notice goes back to draft with these reasons. Approvals are the
 * approvals engine's.
 */
export function noticeIssueBlockers(input: {
  readonly type: NoticeType;
  readonly effective: EarliestDateInput & { readonly effectiveDate: string | null };
  readonly assessments: readonly RentAssessmentFact[];
  readonly assessmentBarRule: NoticeRuleInput | null;
  /** The company's OQ-16 acknowledgement is in force (quitNoticesEnabled). */
  readonly quitAcknowledged: boolean;
}): NoticeIssueCheck {
  const rules = NOTICE_TYPE_RULES[input.type];
  const blockers: NoticeIssueBlocker[] = [];
  const guard = <T>(run: () => T): T | null => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      blockers.push({ code: error.code, message: error.message });
      return null;
    }
  };
  if (input.effective.type !== input.type)
    throw new DomainError('notice.type_mismatch', 'The checks are for another type of notice');
  if (!rules.issuable)
    blockers.push({
      code: 'notice.not_issuable',
      message: `A ${NOTICE_TYPE_LABELS[input.type].toLowerCase()} is recorded, not issued`,
    });
  if (rules.needsQuitAcknowledgement && !input.quitAcknowledged)
    blockers.push({
      code: 'notice.quit_not_enabled',
      message:
        'Notices to quit are switched off until a company admin records that they accept the risk (OQ-16)',
    });
  const effective = guard(() => checkEffectiveDate(input.effective));
  if (effective && !effective.ok)
    blockers.push({ code: 'notice.effective_date_too_early', message: effective.reason! });
  const quitBar = guard(() =>
    checkQuitBar({
      type: input.type,
      issueDate: input.effective.issueDate,
      assessments: input.assessments,
      rule: input.assessmentBarRule,
    }),
  );
  if (quitBar?.barred) blockers.push({ code: 'notice.quit_barred', message: quitBar.reason! });
  return { blockers, effective, quitBar };
}
