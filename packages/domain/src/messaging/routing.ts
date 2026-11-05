import type { Instant } from '../dates';

/**
 * Who an inbound message belongs to (CM-01, CM-02; M6 decision 4; TL-12). A company's own number
 * belongs to that company. On the shared platform number, in order:
 *
 * 1. the company that last messaged this phone on this number within 24 hours;
 * 2. the only company where this phone is a tenant or contact;
 * 3. otherwise the person is asked which landlord, choosing only among the companies where this
 *    phone is a tenant or contact.
 *
 * An unknown number goes to triage: the company's own on a company number, the platform's (which
 * names no company) on the shared number.
 */
export const ROUTING_RECENT_HOURS = 24;
const RECENT_MS = ROUTING_RECENT_HOURS * 60 * 60 * 1000;

export type SendingNumber =
  { readonly kind: 'shared' } | { readonly kind: 'company'; readonly companyId: string };

export interface RoutingInput {
  readonly number: SendingNumber;
  /** Companies that sent this phone a WhatsApp message on this number, with when they last did. */
  readonly recentOutbound: readonly { readonly companyId: string; readonly at: Instant }[];
  /** Companies where this phone belongs to a tenant, a tenant's contact or a linked identity. */
  readonly knownIn: readonly string[];
  readonly now: Instant;
}

export type Route =
  | {
      readonly kind: 'company';
      readonly companyId: string;
      readonly basis: 'company_number' | 'recent_outbound' | 'only_company';
    }
  | { readonly kind: 'ask'; readonly companyIds: readonly string[] }
  | { readonly kind: 'triage'; readonly companyId: string | null };

export function routeInbound(input: RoutingInput): Route {
  if (input.number.kind === 'company')
    return { kind: 'company', companyId: input.number.companyId, basis: 'company_number' };
  const now = input.now.epochMilliseconds;
  const recent = input.recentOutbound
    .filter((r) => {
      const age = now - r.at.epochMilliseconds;
      return age >= 0 && age < RECENT_MS;
    })
    .sort((a, b) => b.at.epochMilliseconds - a.at.epochMilliseconds);
  if (recent[0])
    return { kind: 'company', companyId: recent[0].companyId, basis: 'recent_outbound' };
  const known = [...new Set(input.knownIn)].sort();
  if (known.length === 1) return { kind: 'company', companyId: known[0]!, basis: 'only_company' };
  if (known.length > 1) return { kind: 'ask', companyIds: known };
  return { kind: 'triage', companyId: null };
}

/** The question for rule 3. Only the companies where this phone is known are named. */
export function landlordQuestion(
  options: readonly { readonly companyId: string; readonly name: string }[],
): {
  readonly text: string;
  readonly choices: readonly { readonly id: string; readonly title: string }[];
} {
  const lines = options.map((o, i) => `${i + 1} ${o.name}`);
  return {
    text: `Which landlord is this about? Reply with a number:\n${lines.join('\n')}`,
    choices: options.map((o) => ({ id: `landlord:${o.companyId}`, title: o.name.slice(0, 24) })),
  };
}

/**
 * The person's answer to the question: a list row (`landlord:<id>`) or its number. Anything else,
 * or a company not offered, is no answer, and the question is asked again.
 */
export function landlordChoice(
  answer: { readonly choiceId?: string | null; readonly text?: string | null },
  offered: readonly string[],
): string | null {
  if (answer.choiceId?.startsWith('landlord:')) {
    const id = answer.choiceId.slice('landlord:'.length);
    return offered.includes(id) ? id : null;
  }
  const n = Number.parseInt((answer.text ?? '').trim(), 10);
  if (!Number.isInteger(n) || String(n) !== (answer.text ?? '').trim()) return null;
  return offered[n - 1] ?? null;
}
