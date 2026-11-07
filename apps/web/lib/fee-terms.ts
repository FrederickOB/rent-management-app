import type { FeeTermsView } from '@rent/contracts';
import { FEE_KINDS, GRA_PAYERS, type FeeKind, type GraPayer } from '@rent/domain/ledger';
import { money, toDecimal } from '@rent/domain/money';
import { formatBusinessDate } from './business-dates';
import { errorCode } from './errors';
import { amountMinorOf } from './payment-form';
import { bpsText } from './reporting';
import { formatMinor } from './tenancy-format';

// Fee terms (AC-02; M9 decision 1, and who pays GRA: founder decision, 2026-11-05). A rate is
// typed as a percentage and sent as integer basis points (8% = 800), read exactly from the text,
// never through a floating-point number. A change is a new version, approved by a second person.

export const FEE_KIND_LABELS: Record<FeeKind, string> = {
  none: 'No management fee',
  percentage: 'A percentage of rent and service charge settled',
  fixed_per_unit: 'A fixed amount per unit per month',
};

export const GRA_PAYER_LABELS: Record<GraPayer, string> = {
  agency: 'The agency pays the owner’s rent tax to GRA (it is held back from remittances)',
  owner: 'The owner pays their own rent tax to GRA',
};

export const feeKindOf = (value: string): FeeKind | null =>
  FEE_KINDS.find((k) => k === value) ?? null;
export const graPayerOf = (value: string): GraPayer | null =>
  GRA_PAYERS.find((p) => p === value) ?? null;

/** "8.5" to 850 basis points, exactly; null for anything that is not 0.01 to 100. */
export function percentToBps(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/%$/, '').trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

/** 850 basis points as the form shows them: "8.5". */
export const bpsToPercent = (bps: number): string => bpsText(bps).replace(/%$/, '');

/** The terms in a line: "8.5% of rent and service charge settled; the agency pays GRA". */
export function termsText(
  terms: Pick<FeeTermsView, 'kind' | 'rateBps' | 'fixedMinor' | 'graPaidBy'>,
): string {
  const fee =
    terms.kind === 'percentage' && terms.rateBps !== null
      ? `${bpsText(terms.rateBps)} of rent and service charge settled, per receipt`
      : terms.kind === 'fixed_per_unit' && terms.fixedMinor !== null
        ? `${formatMinor(terms.fixedMinor)} per billable unit per month`
        : 'No management fee';
  return `${fee}; ${terms.graPaidBy === 'agency' ? 'the agency pays GRA' : 'the owner pays GRA'}`;
}

export const termsFrom = (terms: Pick<FeeTermsView, 'effectiveFrom'>): string =>
  `from ${formatBusinessDate(terms.effectiveFrom)}`;

export interface FeeTermsDraft {
  readonly kind: FeeKind | '';
  readonly percent: string;
  readonly fixed: string;
  readonly graPaidBy: GraPayer | '';
  readonly effectiveFrom: string;
}

export const draftOfTerms = (terms: FeeTermsView | null, tomorrow: string): FeeTermsDraft => ({
  kind: terms?.kind ?? '',
  percent: terms?.rateBps ? bpsToPercent(terms.rateBps) : '',
  fixed: terms?.fixedMinor ? toDecimal(money(terms.fixedMinor)) : '',
  graPaidBy: terms?.graPaidBy ?? '',
  effectiveFrom: tomorrow,
});

export type FeeTermsField = keyof FeeTermsDraft;

/** The change as the API takes it (without the owner the page adds), or the problems. */
export function feeTermsInput(
  draft: FeeTermsDraft,
  today: string,
): {
  readonly input: {
    kind: FeeKind;
    rateBps: number | null;
    fixedMinor: number | null;
    graPaidBy: GraPayer;
    effectiveFrom: string;
  } | null;
  readonly errors: Partial<Record<FeeTermsField, string>>;
} {
  const errors: Partial<Record<FeeTermsField, string>> = {};
  if (!draft.kind) errors.kind = 'Choose the kind of fee';
  let rateBps: number | null = null;
  let fixedMinor: number | null = null;
  if (draft.kind === 'percentage') {
    rateBps = percentToBps(draft.percent);
    if (rateBps === null) errors.percent = 'Enter a percentage from 0.01 to 100, such as 8 or 8.5';
  }
  if (draft.kind === 'fixed_per_unit') {
    const fixed = amountMinorOf(draft.fixed);
    if (fixed.problem) errors.fixed = fixed.problem;
    else fixedMinor = fixed.value;
  }
  if (!draft.graPaidBy) errors.graPaidBy = 'Choose who pays the owner’s rent tax to GRA';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom))
    errors.effectiveFrom = 'Choose the date it takes effect';
  else if (draft.effectiveFrom < today)
    errors.effectiveFrom =
      'It takes effect today or later: earlier receipts keep the terms then in force';
  if (Object.keys(errors).length > 0 || !draft.kind || !draft.graPaidBy)
    return { input: null, errors };
  return {
    input: {
      kind: draft.kind,
      rateBps,
      fixedMinor,
      graPaidBy: draft.graPaidBy,
      effectiveFrom: draft.effectiveFrom,
    },
    errors: {},
  };
}

const FEE_TERMS_MESSAGES: Readonly<Record<string, string>> = {
  APPROVAL_OPEN:
    'A change to this owner’s terms is already waiting for a second person. It must be approved or rejected before another change can be asked for.',
  NOT_AN_AGENCY:
    'Only an agency charges management fees; a landlord who manages their own property pays none.',
  FEE_TERMS:
    'Those terms are not valid: a percentage needs a rate, a fixed fee an amount, and no fee neither.',
  EFFECTIVE_FROM_PAST:
    'The new terms take effect today or later. Receipts before then keep the terms in force at the time.',
};

export const feeTermsMessage = (error: unknown): string | null =>
  FEE_TERMS_MESSAGES[errorCode(error)] ?? null;

/** Review WEB 8: the date note on the change form. */
export const EFFECTIVE_FROM_NOTE =
  'If it is approved after this date, the new terms take effect from the day it is approved: receipts before then keep the terms in force at the time.';
