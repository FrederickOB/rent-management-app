import { daysBetween, parseBusinessDate } from '../dates';
import { normaliseReference, REFERENCE_LENGTH } from '../billing/references';

/**
 * Matching provider payments to leases (BC-03, BC-12; M4b plan 4.5). Only two things match
 * automatically: the pay link's own intent, carried as provider metadata, or one exact lease
 * payment reference in what the payer typed. Everything else waits for a person, who is shown
 * ranked suggestions and confirms each match.
 */

/**
 * The valid payment references in free text such as a MoMo narration: each word, and each pair
 * of neighbouring words, that is a whole reference with its check character (so "K7Q M2XA" and
 * "k7q-m2xa" count). Look-alikes are read as Crockford reads them.
 */
export function referencesIn(text: string): string[] {
  const words = text
    .toUpperCase()
    .split(/[^0-9A-Z]+/)
    .filter((w) => w.length > 0);
  const found = new Set<string>();
  const consider = (candidate: string) => {
    if (candidate.length !== REFERENCE_LENGTH) return;
    const reference = normaliseReference(candidate);
    if (reference) found.add(reference);
  };
  words.forEach((word, i) => {
    consider(word);
    const next = words[i + 1];
    if (next !== undefined) consider(word + next);
  });
  return [...found];
}

export type ExactMatch =
  | { readonly kind: 'intent'; readonly intentId: string }
  | { readonly kind: 'reference'; readonly reference: string }
  | { readonly kind: 'none'; readonly reason: 'nothing' | 'several_references' };

/**
 * The automatic match, if there is one. The intent wins: it was created by our own pay page. A
 * narration naming two different references is never guessed between.
 */
export function exactMatch(input: {
  readonly intentId: string | null;
  readonly narration: string | null;
}): ExactMatch {
  if (input.intentId) return { kind: 'intent', intentId: input.intentId };
  const references = input.narration ? referencesIn(input.narration) : [];
  if (references.length === 1) return { kind: 'reference', reference: references[0] as string };
  return { kind: 'none', reason: references.length > 1 ? 'several_references' : 'nothing' };
}

/** What the queue knows about a payment waiting for a person. */
export interface UnmatchedFacts {
  readonly amountMinor: number;
  readonly receivedOn: string;
  /** E.164, when the provider reports the paying phone. */
  readonly payerPhone: string | null;
  readonly payerName: string | null;
}

/** A lease the payment might belong to, with what the queue compares. */
export interface MatchCandidate {
  readonly leaseId: string;
  readonly tenantName: string;
  /** Due now on the lease, and each open invoice's outstanding amount. */
  readonly dueNowMinor: number;
  readonly openInvoiceMinor: readonly number[];
  /** The rent and service charge for one month, as billed now. */
  readonly monthlyMinor: number;
  /** The tenant's phones and their contacts' (E.164). */
  readonly phones: readonly string[];
  /** Due dates of recent and upcoming invoices. */
  readonly dueDates: readonly string[];
  /** Phones that paid this lease before. */
  readonly previousPayerPhones: readonly string[];
}

export type MatchReason =
  | 'amount_is_due_now'
  | 'amount_is_an_invoice'
  | 'amount_is_a_month'
  | 'phone_is_tenant'
  | 'phone_paid_before'
  | 'near_due_date'
  | 'name_matches';

export interface Suggestion {
  readonly leaseId: string;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

const nameWords = (name: string): Set<string> =>
  new Set(
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );

/**
 * Ranked suggestions (BC-12): an exact open amount, the payer's phone against the tenant's, an
 * earlier payment from the same phone, a date near a due date, and the payer's name. A person
 * still confirms every match; the score only orders the list.
 */
export function suggestMatches(
  payment: UnmatchedFacts,
  candidates: readonly MatchCandidate[],
  limit = 5,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const received = parseBusinessDate(payment.receivedOn);
  for (const c of candidates) {
    const reasons: MatchReason[] = [];
    let score = 0;
    if (payment.amountMinor === c.dueNowMinor && c.dueNowMinor > 0) {
      reasons.push('amount_is_due_now');
      score += 50;
    } else if (c.openInvoiceMinor.includes(payment.amountMinor)) {
      reasons.push('amount_is_an_invoice');
      score += 40;
    } else if (c.monthlyMinor > 0 && payment.amountMinor % c.monthlyMinor === 0) {
      reasons.push('amount_is_a_month');
      score += 20;
    }
    if (payment.payerPhone && c.phones.includes(payment.payerPhone)) {
      reasons.push('phone_is_tenant');
      score += 40;
    }
    if (payment.payerPhone && c.previousPayerPhones.includes(payment.payerPhone)) {
      reasons.push('phone_paid_before');
      score += 30;
    }
    const nearest = c.dueDates.reduce<number | null>((best, due) => {
      const gap = Math.abs(daysBetween(parseBusinessDate(due), received));
      return best === null || gap < best ? gap : best;
    }, null);
    if (nearest !== null && nearest <= 7) {
      reasons.push('near_due_date');
      score += 10 - nearest;
    }
    if (payment.payerName) {
      const payer = nameWords(payment.payerName);
      if ([...nameWords(c.tenantName)].some((w) => payer.has(w))) {
        reasons.push('name_matches');
        score += 15;
      }
    }
    if (score > 0) suggestions.push({ leaseId: c.leaseId, score, reasons });
  }
  return suggestions
    .sort((a, b) => b.score - a.score || (a.leaseId < b.leaseId ? -1 : 1))
    .slice(0, limit);
}
