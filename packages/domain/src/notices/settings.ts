import type { CompanySettings } from '../settings/company-settings';
import { DEFAULT_NOTICE_LINK_EXPIRY_DAYS } from './links';
import {
  DEFAULT_NOTICE_SEND_WINDOW,
  defaultNoticeLadder,
  noticeLadderSteps,
  sendWindowOf,
  type NoticeLadderConfig,
  type NoticeLadderStep,
  type NoticeSendWindow,
} from './ladder';
import { NOTICE_TYPE_RULES, NOTICE_TYPES, type LadderNoticeType, type NoticeType } from './types';

/** The M7 notice settings with their defaults applied (plan 4.9): product choices, not law. */
export interface NoticeSettings {
  readonly ladders: Readonly<Record<NoticeType, NoticeLadderConfig>>;
  readonly sendWindow: NoticeSendWindow & { readonly from: string; readonly to: string };
  readonly linkExpiryDays: number;
}

type NoticeSettingsInput = Pick<
  CompanySettings,
  'noticeReminderOffsetsHours' | 'noticeLadders' | 'noticeSendWindow' | 'noticeLinkExpiryDays'
>;

/**
 * Per type: the company's own ladder for that type, else the type's default (defaultNoticeLadder,
 * from the company's M1 four-rung setting or the PRD's). A tenant-originated notice never has
 * one. The sending window is 07:00 to 20:00 and links last 90 days unless the company says
 * otherwise.
 */
export function noticeSettingsOf(settings: NoticeSettingsInput): NoticeSettings {
  const ladders = Object.fromEntries(
    NOTICE_TYPES.map((type) => {
      const own =
        NOTICE_TYPE_RULES[type].ladder === 'none'
          ? undefined
          : settings.noticeLadders?.[type as LadderNoticeType];
      return [type, own ?? defaultNoticeLadder(type, settings.noticeReminderOffsetsHours)];
    }),
  ) as Record<NoticeType, NoticeLadderConfig>;
  const window = settings.noticeSendWindow ?? DEFAULT_NOTICE_SEND_WINDOW;
  return {
    ladders,
    sendWindow: { ...window, ...sendWindowOf(window) },
    linkExpiryDays: settings.noticeLinkExpiryDays ?? DEFAULT_NOTICE_LINK_EXPIRY_DAYS,
  };
}

/** The ladder steps for a type under a company's settings. */
export const noticeLadderFor = (type: NoticeType, settings: NoticeSettings): NoticeLadderStep[] =>
  noticeLadderSteps(settings.ladders[type]);
