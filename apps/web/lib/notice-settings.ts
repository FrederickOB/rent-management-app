import type { CompanyProfile } from '@rent/contracts';
import {
  LADDER_NOTICE_TYPES,
  noticeSettingsOf,
  NOTICE_TYPE_RULES,
  type LadderNoticeType,
} from '@rent/domain/notices';
import {
  ladderConfigOf,
  ladderDraftOf,
  linkExpiryProblem,
  sendWindowProblem,
  type LadderDraft,
} from './notices';

// Notice settings (plan 4.9): the ladder per type, the sending window and link expiry, as the
// company's settings hold them with the domain's defaults applied. Product settings, not law.

export interface NoticeSettingsDraft {
  readonly ladders: Readonly<Record<LadderNoticeType, LadderDraft>>;
  readonly from: string;
  readonly to: string;
  readonly linkExpiryDays: string;
}

/** The form, from the settings in force (the API sends them with defaults applied). */
export function noticeSettingsDraftOf(settings: CompanyProfile['settings']): NoticeSettingsDraft {
  const inForce = noticeSettingsOf({
    noticeReminderOffsetsHours: settings.noticeReminderOffsetsHours,
    noticeLadders: settings.noticeLadders,
    noticeSendWindow: settings.noticeSendWindow,
    noticeLinkExpiryDays: settings.noticeLinkExpiryDays,
  });
  const ladders = Object.fromEntries(
    LADDER_NOTICE_TYPES.map((type) => [type, ladderDraftOf(inForce.ladders[type])]),
  ) as Record<LadderNoticeType, LadderDraft>;
  return {
    ladders,
    from: inForce.sendWindow.from,
    to: inForce.sendWindow.to,
    linkExpiryDays: String(inForce.linkExpiryDays),
  };
}

/** Whether a type's ladder has an in-person step and escalation (`full`), or reminders only. */
export const ladderIsFull = (type: LadderNoticeType): boolean =>
  NOTICE_TYPE_RULES[type].ladder === 'full';

/** As the settings contract takes a ladder (mutable arrays). */
type LadderSetting = {
  reminderHours: number[];
  inPersonHours: number | null;
  escalationHours: number | null;
};

export type NoticeSettingsPatch = {
  noticeLadders: Partial<Record<LadderNoticeType, LadderSetting>>;
  noticeSendWindow: { from: string; to: string };
  noticeLinkExpiryDays: number;
};

/** The settings to save, or the first problem by where it is on the form. */
export function noticeSettingsPatch(
  draft: NoticeSettingsDraft,
): { readonly patch: NoticeSettingsPatch } | { readonly errors: Readonly<Record<string, string>> } {
  const errors: Record<string, string> = {};
  const ladders: Partial<Record<LadderNoticeType, LadderSetting>> = {};
  for (const type of LADDER_NOTICE_TYPES) {
    const typed = ladderIsFull(type)
      ? draft.ladders[type]
      : { ...draft.ladders[type], inPersonHours: '', escalationHours: '' };
    const parsed = ladderConfigOf(typed);
    if ('error' in parsed) errors[type] = parsed.error;
    else ladders[type] = { ...parsed.config, reminderHours: [...parsed.config.reminderHours] };
  }
  const window = sendWindowProblem(draft.from, draft.to);
  if (window) errors.window = window;
  const expiry = linkExpiryProblem(draft.linkExpiryDays);
  if (expiry) errors.linkExpiryDays = expiry;
  if (Object.keys(errors).length) return { errors };
  return {
    patch: {
      noticeLadders: ladders,
      noticeSendWindow: { from: draft.from, to: draft.to },
      noticeLinkExpiryDays: Number.parseInt(draft.linkExpiryDays.trim(), 10),
    },
  };
}

/** The OQ-16 acceptance: the admin's own name, typed (decision 9). */
export function acknowledgementProblem(typedName: string): string | null {
  const length = typedName.trim().length;
  if (length < 2) return 'Type your full name to accept.';
  if (length > 120) return 'Use at most 120 characters.';
  return null;
}
