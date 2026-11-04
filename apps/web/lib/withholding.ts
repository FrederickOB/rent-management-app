import type { ApiClient } from '@rent/contracts/client';
import { money, multiplyBps } from '@rent/domain/money';
import { checkWithholding } from '@rent/domain/tax';
import { formatBusinessDate } from './business-dates';
import { amountInput } from './lease-form';
import { amountMinorOf, CORRECTION_REASON_MIN, pastDateProblem, type Parsed } from './payment-form';
import { lineKindLabel, periodLabel, rateLabel } from './billing-format';
import { TAX_LIMITS } from './tax-limits';
import { formatMinor } from './tenancy-format';

// Withholding tax by a corporate tenant (TX-04; P19, P20 and P24; M5 plan 5.2 and decision 3).
// The tenant pays net and withholds tax on particular lines; the withholding is pinned to those
// lines, and the tax on them becomes the amount withheld. A manager uploads the certificate and a
// landlord user confirms it, never the person who uploaded it. A certificate that never comes is
// written off with a second person's approval. The API checks all of it again.

export const WITHHOLDING_STATUSES = [
  'awaiting_certificate',
  'certificate_uploaded',
  'certified',
  'written_off',
] as const;
export type WithholdingStatus = (typeof WITHHOLDING_STATUSES)[number];

export const WITHHOLDING_STATUS_LABELS: Record<WithholdingStatus, string> = {
  awaiting_certificate: 'Waiting for the certificate',
  certificate_uploaded: 'Certificate uploaded, waiting for a landlord user to confirm it',
  certified: 'Certificate confirmed',
  written_off: 'Written off: the certificate never came',
};

export const WITHHOLDING_STATUS_TONES: Record<
  WithholdingStatus,
  'amber' | 'blue' | 'green' | 'dark'
> = {
  awaiting_certificate: 'amber',
  certificate_uploaded: 'blue',
  certified: 'green',
  written_off: 'dark',
};

/**
 * What a confirmed certificate did for the owner (decision 2; P20), by the account it was posted
 * to: 2200 settles the rent tax on those lines; 1160 is a tax credit for an owner taxed on income
 * as a letting business. Null before it is confirmed.
 */
export function certificateEffect(debitAccount: string | null): string | null {
  if (debitAccount !== '2200' && debitAccount !== '1160') return null;
  return debitAccount === '1160'
    ? 'The owner lets property as a business and is taxed on income, so the withholding is a tax credit for them.'
    : 'The withholding settles the owner’s rent tax on these lines, so nothing more is paid to GRA for them.';
}

/** An invoice line the tenant may have withheld tax on, as the form shows it. */
export interface WithholdableLine {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly label: string;
  /** The line's amount after credit notes. */
  readonly netMinor: number;
  /** Still owed on it: withholding is never more than this. */
  readonly outstandingMinor: number;
  /** The API's suggestion: the rule's rate on the line's amount, at most what is still owed. */
  readonly suggestedMinor?: number;
  /**
   * Decision 8: false for a month not started yet, whose withholding is held as its advance until
   * the month starts. Absent where the API does not say (a started month).
   */
  readonly started?: boolean;
}

/** The rate on a line's amount, as the tenant would usually withhold it (a suggestion only). */
export function amountAtRate(line: Pick<WithholdableLine, 'netMinor'>, rateBps: number): number {
  return multiplyBps(money(line.netMinor), rateBps).amountMinor;
}

/** The rate's amount for an input box, never more than the line still owes. */
export function suggestedInput(line: WithholdableLine, rateBps: number): string {
  return amountInput(Math.min(amountAtRate(line, rateBps), line.outstandingMinor));
}

export interface WithholdingDraft {
  /** The amount typed against each line, by line id; blank where nothing was withheld. */
  readonly amounts: Readonly<Record<string, string>>;
  /** The day it was withheld: the payment's date, or the date on the tenant's advice. */
  readonly valueDate: string;
  readonly note: string;
}

export type WithholdingField = 'lines' | 'valueDate' | 'note' | `line:${string}`;

export const emptyWithholding = (valueDate: string): WithholdingDraft => ({
  amounts: {},
  valueDate,
  note: '',
});

/**
 * Withholding as `POST /withholding` takes it, without the lease and payment the page gives: the
 * lines it was withheld on, each with its amount (P19).
 */
export type WithholdingInput = Pick<
  Parameters<ApiClient['withholding']['record']>[0],
  'valueDate' | 'note' | 'lines'
>;

export interface WithholdingParsed extends Parsed<WithholdingInput, WithholdingField> {
  readonly totalMinor: number;
  /** Lines where the amount is not the rate on the line: shown, never refused (the domain's rule). */
  readonly differsFromRate: readonly string[];
}

const NOTE_MAX = 500;

/**
 * The withholding form (P19): an amount on each line the tenant withheld on, above zero and never
 * more than the line still owes. An amount that is not the rate on the line is accepted with a
 * note to check it: the tenant decides what it withholds, and the certificate is the evidence.
 */
export function withholdingForm(
  draft: WithholdingDraft,
  lines: readonly WithholdableLine[],
  rateBps: number | null,
  today: string,
): WithholdingParsed {
  const errors: Partial<Record<WithholdingField, string>> = {};
  const picked: { line: WithholdableLine; amountMinor: number }[] = [];
  for (const line of lines) {
    const typed = draft.amounts[line.id] ?? '';
    if (!typed.trim()) continue;
    const amount = amountMinorOf(typed, {
      maxMinor: line.outstandingMinor,
      message: `At most ${formatMinor(line.outstandingMinor)}, what is still owed on this line`,
    });
    if (amount.problem || amount.value === null) errors[`line:${line.id}`] = amount.problem ?? '';
    else picked.push({ line, amountMinor: amount.value });
  }
  const known = new Set(lines.map((line) => line.id));
  const typedElsewhere = Object.entries(draft.amounts).some(
    ([id, text]) => text.trim() && !known.has(id),
  );
  if (typedElsewhere) errors.lines = 'A line has changed since the form opened. Reload the page.';
  if (picked.length === 0 && !Object.keys(errors).some((key) => key.startsWith('line:')))
    errors.lines = 'Enter the amount withheld on at least one line';
  const date = pastDateProblem(draft.valueDate, today, 'the tax was withheld');
  if (date) errors.valueDate = date;
  if (draft.note.trim().length > NOTE_MAX) errors.note = `Use at most ${NOTE_MAX} characters`;
  const totalMinor = picked.reduce((sum, p) => sum + p.amountMinor, 0);
  if (Object.keys(errors).length) return { input: null, errors, totalMinor, differsFromRate: [] };
  // The domain's own check: one line once, above zero, never more than owed, and the rate's note.
  const check =
    rateBps === null
      ? null
      : checkWithholding(
          picked.map((p) => ({
            lineId: p.line.id,
            netMinor: p.line.netMinor,
            outstandingMinor: p.line.outstandingMinor,
            withheldMinor: p.amountMinor,
          })),
          rateBps,
        );
  return {
    input: {
      valueDate: draft.valueDate,
      note: draft.note.trim() || null,
      lines: picked.map((p) => ({ lineId: p.line.id, amountMinor: p.amountMinor })),
    },
    errors: {},
    totalMinor,
    differsFromRate: check?.differsFromRate.map((d) => d.lineId) ?? [],
  };
}

/** The note beside a line whose amount is not the rate on it. */
export function rateNote(line: WithholdableLine, rateBps: number): string {
  return `${rateLabel(rateBps)} of ${formatMinor(line.netMinor)} is ${formatMinor(amountAtRate(line, rateBps))}. Check the amount against the tenant’s advice or certificate.`;
}

// The certificate (P20; decision 3) -------------------------------------------------------------

/** A withholding record, as the moves on it need it. */
export interface WithholdingMovesInput {
  readonly status: WithholdingStatus;
  /** Who uploaded the certificate, once one is uploaded. */
  readonly certificateUploadedBy: string | null;
  /**
   * The API's answer for this person: a user for the owner, or an agency admin where the owner
   * has none, and never the uploader (decision 3). Left out, the API decides on the request.
   */
  readonly mayConfirm?: boolean;
  /** A write-off waiting for a second person (P24). */
  readonly openWriteOffApprovalId: string | null;
}

export interface WithholdingMoves {
  readonly upload: boolean;
  /** Confirm the certificate, or reject it with a reason (a wrong file, the wrong amount). */
  readonly confirm: boolean;
  /** Why this person cannot decide an uploaded certificate, or null. */
  readonly confirmBlocked: string | null;
  readonly writeOff: boolean;
}

/**
 * What to offer on a withholding record (decision 3). `can` says what the policy allows this
 * session; the uploader is never offered "Confirm" or "Reject", and the API refuses it too, in
 * the database. A rejected certificate leaves the record waiting for another; only one
 * certificate is live at a time, so a wrong file is rejected before another is uploaded.
 */
export function withholdingMoves(
  record: WithholdingMovesInput,
  personId: string,
  can: { readonly upload: boolean; readonly confirm: boolean; readonly writeOff: boolean },
): WithholdingMoves {
  const waitingCertificate = record.status === 'awaiting_certificate';
  const waitingConfirmation = record.status === 'certificate_uploaded';
  const uploader = record.certificateUploadedBy === personId;
  const confirmBlocked = !waitingConfirmation
    ? null
    : uploader
      ? 'You uploaded this certificate, so another landlord user must confirm it.'
      : !can.confirm || record.mayConfirm === false
        ? 'A user for the owner confirms the certificate, or an agency admin where the owner has none.'
        : null;
  return {
    upload: can.upload && waitingCertificate,
    confirm: waitingConfirmation && confirmBlocked === null,
    confirmBlocked,
    writeOff:
      can.writeOff &&
      (waitingCertificate || waitingConfirmation) &&
      record.openWriteOffApprovalId === null,
  };
}

/** The certificate's own details, as the upload form takes them. */
export interface CertificateDraft {
  readonly certificateNumber: string;
  readonly issuedOn: string;
}

export type CertificateField = keyof CertificateDraft | 'file';

export interface CertificateInput {
  readonly certificateNumber: string | null;
  readonly issuedOn: string | null;
}

/** The certificate form: its number and date are optional, the file is not (checked by the page). */
export function certificateForm(
  draft: CertificateDraft,
  today: string,
): Parsed<CertificateInput, CertificateField> {
  const errors: Partial<Record<CertificateField, string>> = {};
  const number = draft.certificateNumber.trim();
  if (number.length > TAX_LIMITS.certificateNumberMax)
    errors.certificateNumber = `Use at most ${TAX_LIMITS.certificateNumberMax} characters`;
  if (draft.issuedOn) {
    const date = pastDateProblem(draft.issuedOn, today, 'the certificate was issued');
    if (date) errors.issuedOn = date;
  }
  if (Object.keys(errors).length) return { input: null, errors };
  return {
    input: { certificateNumber: number || null, issuedOn: draft.issuedOn || null },
    errors: {},
  };
}

/**
 * A reason someone else reads: the write-off of withholding whose certificate never came (P24),
 * which a second person approves, or why a certificate is rejected.
 */
export function withholdingWriteOffForm(
  reason: string,
): Parsed<{ readonly reason: string }, 'reason'> {
  const text = reason.trim();
  if (text.length < CORRECTION_REASON_MIN)
    return {
      input: null,
      errors: { reason: `Give a reason of at least ${CORRECTION_REASON_MIN} characters` },
    };
  if (text.length > 500) return { input: null, errors: { reason: 'Use at most 500 characters' } };
  return { input: { reason: text }, errors: {} };
}

/** One line of a withholding record, in words: `INV-000123 Rent, 1 Nov 2026: GH₵1,500.00`. */
export function withheldLineLabel(line: {
  readonly invoiceNumber: string;
  readonly label: string;
  readonly amountMinor: number;
}): string {
  return `${line.invoiceNumber} ${line.label}: ${formatMinor(line.amountMinor)}`;
}

/** When and by whom the certificate was confirmed, for the record's summary. */
export function confirmedLabel(confirmedOn: string | null, byName: string | null): string | null {
  if (!confirmedOn) return null;
  return `Confirmed ${formatBusinessDate(confirmedOn)}${byName ? ` by ${byName}` : ''}`;
}

/** Why a certificate is rejected: the uploader reads it before uploading the right one. */
export const certificateRejectForm = withholdingWriteOffForm;

// Where the record form's lines and rate come from -------------------------------------------------

/** An invoice line as the invoice API gives it: what the form needs to offer it. */
export interface InvoiceLineFacts {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly netMinor: number;
  readonly outstandingMinor: number;
  /** Rent and service charge: the period has started (P02). */
  readonly accrued: boolean;
}

/**
 * The lines a tenant may have withheld tax on (P19, the API's rule): rent and service charge of
 * months that have started, still owed. Oldest invoice first, as the invoices are given.
 */
export function withholdableLines(
  invoices: readonly { readonly number: string; readonly lines: readonly InvoiceLineFacts[] }[],
): WithholdableLine[] {
  return invoices.flatMap((invoice) =>
    invoice.lines
      .filter(
        (line) =>
          (line.kind === 'rent' || line.kind === 'service_charge') &&
          line.accrued &&
          line.outstandingMinor > 0,
      )
      .map((line) => ({
        id: line.id,
        invoiceNumber: invoice.number,
        label: line.label,
        netMinor: line.netMinor,
        outstandingMinor: line.outstandingMinor,
      })),
  );
}

/** A rules row as `GET /rules` lists it. */
export interface RuleRowFacts {
  readonly key: string;
  readonly value: unknown;
  readonly verificationStatus: 'verified' | 'from_prd' | 'unverified';
  readonly warning: boolean;
}

/**
 * The withholding rate for the lease's use (`withholding_tax.rate.residential` or `.commercial`,
 * unverified), as a suggestion and the comparison the API makes; null when the table has none.
 */
export function withholdingRate(
  rules: readonly RuleRowFacts[],
  use: 'residential' | 'commercial',
): { readonly rateBps: number; readonly rule: RuleRowFacts } | null {
  const rule = rules.find((r) => r.key === `withholding_tax.rate.${use}`);
  const value = rule?.value;
  const bps =
    typeof value === 'object' && value !== null && 'bps' in value
      ? (value as { readonly bps?: unknown }).bps
      : null;
  return rule && typeof bps === 'number' && Number.isSafeInteger(bps) && bps >= 0
    ? { rateBps: bps, rule }
    : null;
}

// The record form's choices, from `GET /leases/{leaseId}/withholding-options` -------------------

/** A month the tenant can withhold on, as the options endpoint lists it. */
export interface OptionLine {
  readonly lineId: string;
  readonly invoiceNumber: string;
  readonly kind: 'rent' | 'service_charge';
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Decision 8: false for a month not started yet (the options' `advanceLines`). */
  readonly started?: boolean;
  readonly netMinor: number;
  readonly outstandingMinor: number;
  readonly suggestedMinor: number;
}

/** The options' months as the form shows them: `Rent, 1 Nov 2026 to 30 Nov 2026`. */
export function optionLines(lines: readonly OptionLine[]): WithholdableLine[] {
  return lines.map((line) => ({
    id: line.lineId,
    invoiceNumber: line.invoiceNumber,
    label: `${lineKindLabel(line.kind)}, ${periodLabel(line.periodStart, line.periodEnd) ?? ''}`,
    netMinor: line.netMinor,
    outstandingMinor: line.outstandingMinor,
    suggestedMinor: line.suggestedMinor,
    ...(line.started === undefined ? {} : { started: line.started }),
  }));
}

/**
 * Every month the form offers (decision 8): those started and still owed, then those not started
 * yet, whose withholding is held as their advance until each month starts.
 */
export function formLines(options: {
  readonly lines: readonly OptionLine[];
  readonly advanceLines?: readonly OptionLine[];
}): WithholdableLine[] {
  return [
    ...optionLines(options.lines),
    ...optionLines(options.advanceLines ?? []).map((line) => ({ ...line, started: false })),
  ];
}

/** A month whose withholding is held as its advance until it starts (decision 8). */
export const HELD_AS_ADVANCE = 'held until the month starts';

// Decision 7 (OQ-29): the sole uploader confirms their own certificate after the cooling-off ----

/** The certificate's request for its uploader to confirm it themselves, as the API sends it. */
export interface SelfConfirmation {
  readonly approvalId: string;
  readonly status: 'pending' | 'cooling_off' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  readonly coolingOffUntil: string | null;
}

export type SelfConfirmState =
  /** No such request, or this person is not the uploader. */
  | { readonly kind: 'none' }
  /** Open, and the cooling-off has not passed: confirmable from `until`. */
  | { readonly kind: 'waiting'; readonly approvalId: string; readonly until: string | null }
  /** Open, and the cooling-off has passed: confirm with a code from the authenticator app. */
  | { readonly kind: 'ready'; readonly approvalId: string }
  /** The request closed without confirming it (rejected, withdrawn or expired). */
  | { readonly kind: 'closed'; readonly status: SelfConfirmation['status'] };

/**
 * Where a sole uploader's own confirmation stands at `now` (decision 7). It goes through the
 * approvals engine (`approvals.decide`, `self_confirm`, with a TOTP code), never through the
 * certificate's own confirm, which refuses its uploader.
 */
export function selfConfirmState(
  certificate: {
    readonly uploadedBy: string;
    readonly selfConfirmation?: SelfConfirmation | null;
  },
  personId: string,
  now: Date,
): SelfConfirmState {
  const request = certificate.selfConfirmation;
  if (!request || certificate.uploadedBy !== personId) return { kind: 'none' };
  if (request.status === 'approved') return { kind: 'none' };
  if (request.status !== 'pending' && request.status !== 'cooling_off')
    return { kind: 'closed', status: request.status };
  const ready = request.coolingOffUntil !== null && new Date(request.coolingOffUntil) <= now;
  return ready
    ? { kind: 'ready', approvalId: request.approvalId }
    : { kind: 'waiting', approvalId: request.approvalId, until: request.coolingOffUntil };
}

/** The amount the form offers for a line: the API's suggestion, else the rate on its amount. */
export function suggestionFor(line: WithholdableLine, rateBps: number): string {
  return line.suggestedMinor === undefined
    ? suggestedInput(line, rateBps)
    : amountInput(line.suggestedMinor);
}

/**
 * The warning before recording amounts that are not the rule's rate on their lines (TX-04): the
 * tenant decides what it withholds, so it is recorded, but someone should check it first.
 */
export function differsWarning(
  lineIds: readonly string[],
  lines: readonly WithholdableLine[],
  rateBps: number,
): string | null {
  const named = lines.filter((line) => lineIds.includes(line.id));
  if (named.length === 0) return null;
  const which = named.map((line) => `${line.invoiceNumber} ${line.label}`).join('; ');
  return `${named.length === 1 ? 'This amount is' : 'These amounts are'} not ${rateLabel(rateBps)} of the line${named.length === 1 ? '' : 's'}: ${which}. Check against the tenant’s advice or certificate before recording; it is recorded as typed.`;
}

// M5 review: how a withholding's rent tax was treated, and a sole uploader's fresh request -------

export type RentTaxTreatment = 'accrued' | 'letting_business' | 'not_assessed';

/**
 * How the withholding's rent tax was treated when it was recorded, which its certificate (P20)
 * follows (M5 review 1). Null for withholding recorded before the API said.
 */
export function treatmentText(treatment: RentTaxTreatment | null | undefined): string | null {
  switch (treatment) {
    case 'accrued':
      return 'Its rent tax is the amount withheld; once confirmed, the certificate settles it.';
    case 'letting_business':
      return 'The owner lets property as a business and is taxed on income, so the certificate is a tax credit for them.';
    case 'not_assessed':
      return 'Its rent tax was not worked out when it was recorded, because a rules row was missing, so the certificate is a tax credit for the owner.';
    default:
      return null;
  }
}

type RequestStatus = SelfConfirmation['status'];

export type SelfDecisionState =
  /** Nothing for this person to decide themselves. */
  | { readonly kind: 'none' }
  /** A request is open and the cooling-off has not passed. */
  | {
      readonly kind: 'waiting';
      readonly decision: 'confirm' | 'withdraw';
      readonly approvalId: string;
      readonly until: string | null;
    }
  /** A request is open and the cooling-off has passed: decide it with a TOTP code. */
  | {
      readonly kind: 'ready';
      readonly decision: 'confirm' | 'withdraw';
      readonly approvalId: string;
    }
  /**
   * The last request lapsed (rejected, withdrawn or expired) and none is open: its uploader may
   * ask again to confirm it, or to withdraw it, when the API says so.
   */
  | {
      readonly kind: 'lapsed';
      readonly decision: 'confirm' | 'withdraw';
      readonly status: RequestStatus;
      readonly mayRequest: boolean;
    };

const OPEN: ReadonlySet<RequestStatus> = new Set(['pending', 'cooling_off']);

/**
 * Where a sole uploader's own decision on their certificate stands at `now` (decision 7; M5
 * review 4): a request to confirm it or to withdraw it, each decided after the cooling-off with
 * a code through the approvals engine. Only its uploader ever decides it this way.
 */
export function selfDecisionState(
  certificate: {
    readonly uploadedBy: string;
    readonly selfConfirmation?: SelfConfirmation | null;
    readonly selfWithdrawal?: SelfConfirmation | null;
    readonly mayRequestSelfDecision?: boolean;
  },
  personId: string,
  now: Date,
): SelfDecisionState {
  if (certificate.uploadedBy !== personId) return { kind: 'none' };
  const requests = [
    { decision: 'withdraw' as const, request: certificate.selfWithdrawal ?? null },
    { decision: 'confirm' as const, request: certificate.selfConfirmation ?? null },
  ];
  const open = requests.find((r) => r.request && OPEN.has(r.request.status));
  if (open?.request) {
    const ready =
      open.request.coolingOffUntil !== null && new Date(open.request.coolingOffUntil) <= now;
    return ready
      ? { kind: 'ready', decision: open.decision, approvalId: open.request.approvalId }
      : {
          kind: 'waiting',
          decision: open.decision,
          approvalId: open.request.approvalId,
          until: open.request.coolingOffUntil,
        };
  }
  const lapsed = requests.find(
    (r) => r.request && !OPEN.has(r.request.status) && r.request.status !== 'approved',
  );
  if (lapsed?.request)
    return {
      kind: 'lapsed',
      decision: lapsed.decision,
      status: lapsed.request.status,
      mayRequest: certificate.mayRequestSelfDecision === true,
    };
  return { kind: 'none' };
}
