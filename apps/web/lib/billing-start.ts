import { firstPeriodStartOnOrAfter } from '@rent/domain/billing';
import { parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { periodStart, type LeaseTerms } from '@rent/domain/tenancy';
import { formatBusinessDate } from './business-dates';

// Where billing starts for a lease recorded on paper (M4a decision 1). By default it is the first
// rent period that starts on or after the day it is recorded; staff may choose an earlier period
// start to bring recent arrears in, or a later one to leave out months the tenant paid before the
// platform. Anything before it arrives with opening balances (P25, M11).

export interface BillingStartChoice {
  readonly value: string;
  readonly label: string;
}

/** The default billing start and every period start to choose from, in order. */
export function billingStartChoices(
  terms: Pick<LeaseTerms, 'startDate' | 'periodCount'>,
  today: string,
): { readonly defaultStart: string; readonly choices: BillingStartChoice[] } {
  const defaultStart = firstPeriodStartOnOrAfter(terms, today);
  const start = parseBusinessDate(terms.startDate);
  const starts: string[] = [];
  for (let k = 0; k < terms.periodCount; k += 1) starts.push(toIsoDate(periodStart(start, k)));
  // A lease whose term has passed starts billing with its first held-over month.
  if (!starts.includes(defaultStart)) starts.push(defaultStart);
  return {
    defaultStart,
    choices: starts.map((value, index) => ({
      value,
      label: [
        formatBusinessDate(value),
        index === 0 ? 'the first day of the lease' : null,
        value === defaultStart ? 'the default: the first period from today' : null,
      ]
        .filter(Boolean)
        .join(', '),
    })),
  };
}

/**
 * What a chosen billing start means, in words, or null for the default. A start after the lease's
 * first day issues no deposit invoice: that deposit arrives with opening balances (decision 1).
 */
export function billingStartNote(input: {
  readonly chosen: string;
  readonly defaultStart: string;
  readonly leaseStart: string;
  readonly hasDeposit: boolean;
}): string | null {
  const notes: string[] = [];
  if (input.chosen < input.defaultStart)
    notes.push(
      `Rent from ${formatBusinessDate(input.chosen)} is invoiced at once, and shows as arrears until it is paid.`,
    );
  else if (input.chosen > input.defaultStart)
    notes.push(
      `Months before ${formatBusinessDate(input.chosen)} are never invoiced. Choose this when the tenant paid them before you used the platform.`,
    );
  if (input.hasDeposit && input.chosen !== input.leaseStart)
    notes.push(
      'No deposit invoice is issued, because billing starts after the first day of the lease: the deposit comes in with opening balances.',
    );
  return notes.length ? notes.join(' ') : null;
}
