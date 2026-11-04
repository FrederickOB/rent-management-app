import { daysBetween, parseBusinessDate } from '@rent/domain/dates';
import { DEFAULT_PAID_UNTIL_PROMPT_DAYS } from '@rent/domain/settings';
import { formatBusinessDate } from './business-dates';

// The paid-until prompt (AR-06; M5 plan 5.5 and decision 5). When a lease's paid-until date is
// 90 days away (the company's `paidUntilPromptDays`), the daily job `billing.paid-until-prompt`
// lists the lease on the expiring page, emails its manager and messages the tenant where consent
// is recorded. The lease page shows the same prompt in the same window, so nobody waits for it.

export interface PaidUntilPromptInput {
  readonly paidUntil: string | null;
  /** The lease's last day: a lease paid to its end is a renewal conversation. */
  readonly leaseEnd: string;
  /** How many days ahead the prompt starts (the company's setting; 90 in the PRD). */
  readonly windowDays: number;
  /** A renewal already offered, so the prompt says so rather than asking for one. */
  readonly renewalOffered: boolean;
}

export interface PaidUntilPrompt {
  readonly title: string;
  readonly text: string;
  readonly daysAway: number;
  /** Offer a renewal from the prompt: the lease is paid to its end and none is offered yet. */
  readonly offerRenewal: boolean;
}

const plural = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/** The prompt for `today`, or null when paid-until is further off, already past, or unknown. */
export function paidUntilPrompt(
  input: PaidUntilPromptInput,
  today: string,
): PaidUntilPrompt | null {
  if (!input.paidUntil) return null;
  const daysAway = daysBetween(parseBusinessDate(today), parseBusinessDate(input.paidUntil));
  if (daysAway < 0 || daysAway > input.windowDays) return null;
  const date = formatBusinessDate(input.paidUntil);
  const title =
    daysAway === 0 ? `Paid until today, ${date}` : `Paid until ${date}: ${plural(daysAway)} away`;
  const toEnd = input.paidUntil >= input.leaseEnd;
  if (input.renewalOffered)
    return {
      title,
      text: 'A renewal has been offered. Follow it up with the tenant, and the advance for the new term.',
      daysAway,
      offerRenewal: false,
    };
  return toEnd
    ? {
        title,
        text: 'The rent is paid to the end of the lease. Offer the tenant a renewal now, so there is time to agree the new term and its advance.',
        daysAway,
        offerRenewal: true,
      }
    : {
        title,
        text: 'Talk to the tenant about the next payment before the paid months run out.',
        daysAway,
        offerRenewal: false,
      };
}

/**
 * The prompt's window: the company's `paidUntilPromptDays` setting, or the PRD's 90 days when it is
 * not set (a product setting, not law: CLAUDE.md section 7).
 */
export function promptWindowDays(settings: unknown): number {
  if (typeof settings === 'object' && settings !== null && 'paidUntilPromptDays' in settings) {
    const days = (settings as { readonly paidUntilPromptDays?: unknown }).paidUntilPromptDays;
    if (typeof days === 'number' && Number.isInteger(days) && days > 0) return days;
  }
  return DEFAULT_PAID_UNTIL_PROMPT_DAYS;
}
