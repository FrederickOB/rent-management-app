import { companySettingsSchema, type LeaseBilling, type PAY_LINK_PROBLEMS } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import type { InvoiceStatus } from '@rent/domain/billing';
import { DESTINATION_PROBLEM_TEXT } from '@rent/domain/payments';

// Collecting rent from staff screens (BC-04, BC-09; M4b plan 4.3 and 4.7): sending a tenant the
// pay link for an invoice, and the reminder ladder in words. Whether a link can go, on which
// channel and why not, is decided by the API: consent per channel (CM-09), and a settlement
// destination for the lease's owner (ADR-008). The screen says what it answered.

export type PayLinkAnswer = Awaited<ReturnType<ApiClient['paymentsQueue']['sendPayLink']>>;
type Channel = PayLinkAnswer['channels'][number];

const CHANNEL_WORDS: Record<Channel, string> = { sms: 'SMS', email: 'email' };

/** `SMS and email`, `email`. */
export function channelsLabel(channels: readonly Channel[]): string {
  const words = [...new Set(channels)].map((c) => CHANNEL_WORDS[c]);
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** What the API did with a pay link, in one sentence: where it went, or why nothing went. */
export function payLinkOutcome(answer: PayLinkAnswer): {
  readonly sent: boolean;
  readonly text: string;
} {
  if (answer.channels.length > 0)
    return {
      sent: true,
      text: `Pay link sent by ${channelsLabel(answer.channels)}. It works until the invoice is paid, or for 60 days.`,
    };
  return {
    sent: false,
    text: answer.notSentReason
      ? `No pay link was sent: ${lowerFirst(answer.notSentReason)}`
      : 'No pay link was sent: the tenant has no channel we may use.',
  };
}

const lowerFirst = (text: string): string => {
  const trimmed = text.trim().replace(/\.?$/, '.');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
};

/** A pay link is offered for an invoice that still asks for money (BC-04). */
export function payLinkOffered(invoice: {
  readonly status: InvoiceStatus;
  readonly outstandingMinor: number;
}): boolean {
  return (
    invoice.outstandingMinor > 0 && (invoice.status === 'issued' || invoice.status === 'part_paid')
  );
}

export type PayLinkAvailability = NonNullable<LeaseBilling['payLink']>;
export type PayLinkProblem = (typeof PAY_LINK_PROBLEMS)[number];

/** The API's reasons in words, for when it sends none of its own (`text`). */
export const PAY_LINK_PROBLEM_LABELS: Record<PayLinkProblem, string> = {
  ...DESTINATION_PROBLEM_TEXT,
  not_billed: 'The lease is not billed, so there is nothing to pay by link',
  nothing_due: 'Nothing is left to pay on this lease now',
  no_consent:
    'The tenant has not agreed to messages by SMS or email, so a link cannot be sent to them',
};

export type PayLinkState =
  | { readonly kind: 'send'; readonly invoiceId: string }
  | { readonly kind: 'none'; readonly tone: 'info' | 'warning'; readonly text: string };

/**
 * Whether the lease page offers a pay link, before anyone tries (BC-04; plan 4.2 and 4.3): the
 * API's answer for the lease, with the oldest invoice still to pay. When it cannot, the page says
 * why: where the owner's rent goes is not set, no usable settlement account, no consent. Nothing
 * due is not a problem, so it reads as information.
 */
export function payLinkState(payLink: PayLinkAvailability): PayLinkState {
  if (payLink.available && payLink.invoiceId) return { kind: 'send', invoiceId: payLink.invoiceId };
  const reason = payLink.reason;
  const text =
    payLink.text?.trim() ||
    (reason ? PAY_LINK_PROBLEM_LABELS[reason] : 'A pay link cannot be sent for this lease now');
  return {
    kind: 'none',
    tone: reason === 'nothing_due' || reason === 'not_billed' ? 'info' : 'warning',
    text: text.replace(/\.?$/, '.'),
  };
}

// The landlord's own payment instructions (plan 4.3 and 4.9) -----------------------------------

/** The most the API keeps, from the company settings contract. */
function instructionsMax(): number {
  const max = companySettingsSchema.shape.manualPaymentInstructions.unwrap().unwrap().maxLength;
  if (!max) throw new Error('The company settings contract has no limit for payment instructions');
  return max;
}

export const MANUAL_INSTRUCTIONS_MAX = instructionsMax();

/**
 * The instructions to save, shown on the pay page when online payment is unavailable (every
 * provider down, or no usable settlement account): blank clears them.
 */
export function manualInstructionsOf(text: string): {
  readonly value: string | null;
  readonly error: string | null;
} {
  const trimmed = text.trim();
  if (trimmed.length > MANUAL_INSTRUCTIONS_MAX)
    return { value: null, error: `Use at most ${MANUAL_INSTRUCTIONS_MAX} characters.` };
  return { value: trimmed || null, error: null };
}

// The reminder ladder (BC-09) -------------------------------------------------------------------

const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;

/** `3, 7 and 14`. */
function listOf(values: readonly number[]): string {
  if (values.length <= 1) return values.map(String).join('');
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

/**
 * The company's rent reminder offsets in words (BC-09): `7 days before the due date, on the due
 * date, and 3, 7 and 14 days after it`. Each step goes once per invoice, in the company's time
 * zone, and the ladder stops once the invoice is paid.
 */
export function ladderWords(offsetsDays: readonly number[]): string {
  const unique = [...new Set(offsetsDays)].sort((a, b) => a - b);
  const before = unique.filter((d) => d < 0).map((d) => -d);
  const after = unique.filter((d) => d > 0);
  const parts: string[] = [];
  if (before.length)
    parts.push(
      before.length === 1
        ? `${days(before[0] as number)} before the due date`
        : `${listOf(before)} days before the due date`,
    );
  if (unique.includes(0)) parts.push('on the due date');
  if (after.length) {
    // "After it" only once an earlier part has named the due date.
    const due = parts.length ? 'it' : 'the due date';
    parts.push(
      after.length === 1
        ? `${days(after[0] as number)} after ${due}`
        : `${listOf(after)} days after ${due}`,
    );
  }
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}
