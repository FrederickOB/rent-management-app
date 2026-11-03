import type { LeaseDetailView, SigningProgress } from '@rent/contracts';
import { SIGNER_ROLE_LABELS } from '@rent/domain/esign';
import type { Problem } from './errors';
import { formatDate, formatTime } from './format';
import {
  ONE_TENANT_PROBLEM,
  partyLink,
  signerContact,
  signsAs,
  STAFF_PART_PROBLEM,
  staffMaySignAs,
  TENANT_SIGNS_PROBLEM,
  type SignerRecords,
} from './lease-form';
import { hasCode } from './register-format';

// The signing screens in the web app (TL-07; plan 4.8 and 4.16): sending a draft for signature,
// following each signer, handing over a link in person (decision 2) and recalling. The API
// decides everything; these helpers put its answers into words.

export type SignerProgress = SigningProgress['signers'][number];
export type RequestStatus = SigningProgress['status'];

/** How often the lease page asks again while a request is open. */
export const SIGNING_POLL_MS = 15_000;

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  preparing: 'Preparing the document',
  pending: 'Out for signature',
  completed: 'Everyone has signed',
  declined: 'Declined',
  cancelled: 'Recalled',
};

/** A request still moving: the page keeps asking for news. */
export const isOpenRequest = (status: RequestStatus): boolean =>
  status === 'preparing' || status === 'pending';

// Sending for signature ---------------------------------------------------------------------------

/**
 * What would stop this draft being sent, as far as the lease and the records this screen could
 * read show (the API checks it all again when it is sent). A signer linked to a record takes the
 * phone and email on that record, so they are checked there when `records` has it; without it,
 * only the API knows them, and such a signer is not flagged.
 */
export function issueBlockers(lease: LeaseDetailView, records?: SignerRecords): string[] {
  const problems: string[] = [];
  const parties = lease.parties;
  if (!lease.template)
    return ['This lease was recorded from paper, so it has no document to send for signing.'];
  if (parties.length === 0) return ['Add the people who sign, in the draft.'];
  if (!signsAs(parties, 'tenant') && !signsAs(parties, 'signatory'))
    problems.push('Add the tenant, or a company tenant’s authorised signatory, as a signer.');
  // A person who rents signs their own lease; someone who lives there too signs with them.
  else if (
    lease.tenant.kind === 'individual' &&
    !parties.some((p) => partyLink(p) === 'tenant_record')
  )
    problems.push(TENANT_SIGNS_PROBLEM);
  if (!signsAs(parties, 'landlord'))
    problems.push('Add who signs for the landlord: an owner or a manager.');
  if (lease.witnessRequired && !signsAs(parties, 'witness'))
    problems.push(
      'Add the witness who will sign, or untick “A witness signs this lease” in the draft.',
    );
  // Only one signer signs as the tenant from the tenant's record; anyone else who lives there
  // signs from their own contact record.
  if (parties.filter((p) => partyLink(p) === 'tenant_record').length > 1)
    problems.push(ONE_TENANT_PROBLEM);
  for (const party of parties) {
    const part = SIGNER_ROLE_LABELS[party.role].toLowerCase();
    if (party.staffPersonId && !staffMaySignAs(party.role))
      problems.push(`${party.name} (${part}): ${STAFF_PART_PROBLEM}`);
    const link = partyLink(party);
    if (!link) {
      if (!party.phone && !party.email)
        problems.push(
          `Add a phone or email for ${party.name} (${part}), so they can get their link and code.`,
        );
      continue;
    }
    if (!records) continue;
    const contact = signerContact(party, records);
    if (contact.from === 'missing')
      problems.push(
        contact.link === 'contact'
          ? `${party.name} (${part}) is no longer one of the tenant’s contacts. Remove them from the signers in the draft.`
          : `${party.name} (${part}) is no longer an active member of your company. Remove them from the signers in the draft.`,
      );
    else if (contact.from === 'record' && !contact.phone && !contact.email)
      problems.push(
        link === 'tenant_record'
          ? `Add a phone or email to the tenant’s record, so ${party.name} can get their link and code.`
          : `Add a phone or email to ${party.name}’s record (${part}), so they can get their link and code.`,
      );
  }
  return problems;
}

/** What to do about a refusal: change the draft, reload the page, or nothing on this page. */
export type Fix = 'edit_draft' | 'reload' | null;

export interface SigningProblem {
  readonly message: string;
  readonly fix: Fix;
}

const ISSUE_PROBLEMS: Readonly<Record<string, SigningProblem>> = {
  parties_required: { message: 'Add the people who sign, in the draft.', fix: 'edit_draft' },
  tenant_signer_required: {
    message: 'Add the tenant, or a company tenant’s authorised signatory, as a signer.',
    fix: 'edit_draft',
  },
  landlord_signer_required: {
    message: 'Add who signs for the landlord: an owner or a manager.',
    fix: 'edit_draft',
  },
  witness_required: {
    message:
      'Add the witness who will sign. Your company asks for a witness on every lease; a draft can turn this off.',
    fix: 'edit_draft',
  },
  lease_overlap: {
    message:
      'Another lease holds this unit for some of these dates. Change the dates in the draft, or end the other lease first.',
    fix: 'edit_draft',
  },
  signing_open: {
    message: 'This lease is already out for signature. Reload the page to follow it.',
    fix: 'reload',
  },
  lease_not_draft: {
    message: 'This lease is no longer a draft; someone may have sent it already. Reload the page.',
    fix: 'reload',
  },
  lease_without_template: {
    message: 'This lease was recorded from paper, so it has no document to send for signing.',
    fix: null,
  },
  tenant_signer_once: { message: ONE_TENANT_PROBLEM, fix: 'edit_draft' },
};

/** Codes whose own message names the signer, so it is kept, with what to do about it. */
const NAMED_PROBLEMS: Readonly<Record<string, string>> = {
  signer_contact: 'Add their phone or email in the draft, then send it again.',
  party_contact: 'Remove them from the signers in the draft, or add them as a contact again.',
  party_staff: 'Change who signs in the draft, then send it again.',
};

/** A refusal of "Send for signing" in plain words, with what to fix. */
export function issueProblem(problem: Problem): SigningProblem {
  for (const [code, known] of Object.entries(ISSUE_PROBLEMS))
    if (hasCode(problem.code, code)) return known;
  for (const [code, fix] of Object.entries(NAMED_PROBLEMS))
    if (hasCode(problem.code, code))
      return { message: `${problem.message.replace(/[.;]?\s*$/, '.')} ${fix}`, fix: 'edit_draft' };
  return { message: problem.message, fix: null };
}

/** A refusal of "Recall" in plain words. */
export function recallProblem(problem: Problem): SigningProblem {
  if (hasCode(problem.code, 'signing_complete'))
    return {
      message:
        'Everyone has signed, so it can no longer be recalled. A signed lease is cancelled with a second person’s approval instead.',
      fix: 'reload',
    };
  if (hasCode(problem.code, 'lease_not_pending'))
    return {
      message: 'This lease is no longer waiting for signatures. Reload the page.',
      fix: 'reload',
    };
  return { message: problem.message, fix: null };
}

/** A refusal of a hand-over link in plain words. */
export function handoverProblem(problem: Problem): SigningProblem {
  if (problem.status === 404)
    return {
      message: 'This signer or signing request was not found. Reload the page.',
      fix: 'reload',
    };
  if (hasCode(problem.code, 'link_unavailable')) return { message: problem.message, fix: 'reload' };
  return { message: problem.message, fix: null };
}

// Progress ---------------------------------------------------------------------------------------

export type SignerTone = 'green' | 'red' | 'amber' | 'blue' | 'neutral';

/** A signer's state at `now`, for the badge. */
export function signerState(
  signer: SignerProgress,
  now: Date,
  open = true,
): { readonly tone: SignerTone; readonly label: string } {
  if (signer.status === 'signed') return { tone: 'green', label: 'Signed' };
  if (signer.status === 'declined') return { tone: 'red', label: 'Declined' };
  // A request that closed (recalled, declined by someone else) leaves the rest unsigned.
  if (!open) return { tone: 'neutral', label: 'Did not sign' };
  if (signer.lockedUntil && new Date(signer.lockedUntil) > now)
    return { tone: 'amber', label: 'Locked after wrong codes' };
  if (signer.firstOpenedAt || signer.lastLink?.openedAt)
    return { tone: 'blue', label: 'Opened, not signed' };
  return { tone: 'neutral', label: 'Not opened yet' };
}

const VIA: Record<NonNullable<SignerProgress['lastLink']>['via'], string> = {
  message: 'sent by message',
  handover: 'handed over in person',
  tenant_app: 'opened from the tenant app',
};

/**
 * The lines under a signer: what happened, with times in the company's zone (DO-04). Links, codes
 * and locks are shown only while the request is open, since a closed request's links stop working.
 */
export function signerLines(
  signer: SignerProgress,
  timeZone: string,
  now: Date,
  open = true,
): string[] {
  const lines: string[] = [];
  if (signer.signedAt) lines.push(`Signed ${formatTime(signer.signedAt, timeZone)}`);
  if (signer.declinedAt)
    lines.push(
      `Declined ${formatTime(signer.declinedAt, timeZone)}${signer.declineReason ? `: “${signer.declineReason}”` : ''}`,
    );
  const waiting = open && signer.status === 'pending';
  if (waiting && signer.lockedUntil && new Date(signer.lockedUntil) > now)
    lines.push(
      `Five wrong codes: signing is locked until ${formatTime(signer.lockedUntil, timeZone)}`,
    );
  if (signer.firstOpenedAt)
    lines.push(
      signer.lastOpenedAt && signer.lastOpenedAt !== signer.firstOpenedAt
        ? `First opened ${formatTime(signer.firstOpenedAt, timeZone)}, last ${formatTime(signer.lastOpenedAt, timeZone)}`
        : `Opened ${formatTime(signer.firstOpenedAt, timeZone)}`,
    );
  if (waiting) {
    const link = signer.lastLink;
    lines.push(
      link
        ? `Link ${VIA[link.via]} ${formatTime(link.createdAt, timeZone)}${link.openedAt ? `, opened ${formatTime(link.openedAt, timeZone)}` : ', not opened yet'}; it works until ${formatDate(link.expiresAt, timeZone)}`
        : 'No link has gone out: they have no channel they agreed to. Hand one over in person.',
    );
  }
  const destination = signer.codeChannel === 'sms' ? signer.phoneMasked : signer.emailMasked;
  if (waiting && destination)
    lines.push(`Codes go by ${signer.codeChannel === 'sms' ? 'SMS' : 'email'} to ${destination}`);
  return lines;
}

/** Whether a signer needs a link handed over: nothing has gone out to them. */
export const needsHandover = (signer: SignerProgress): boolean =>
  signer.status === 'pending' && signer.lastLink === null;

/** `a1b2c3d4…e5f6a7b8`: a fingerprint short enough to read, with the full value one copy away. */
export function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

/** One line about the request, such as `Out for signature since 29 Oct 2026, 15:32 GMT (Africa/Accra)`. */
export function requestLine(progress: SigningProgress, timeZone: string): string {
  switch (progress.status) {
    case 'preparing':
      return 'The document is being prepared. The links go out as soon as it is ready.';
    case 'pending':
      return `Out for signature since ${formatTime(progress.openedAt ?? progress.createdAt, timeZone)}.`;
    case 'completed':
      return `Everyone signed by ${formatTime(progress.completedAt ?? progress.createdAt, timeZone)}.`;
    case 'declined':
      return `Declined ${formatTime(progress.declinedAt ?? progress.createdAt, timeZone)}${progress.declineReason ? `: “${progress.declineReason}”` : ''}. The lease went back to draft.`;
    case 'cancelled':
      return `Recalled ${formatTime(progress.cancelledAt ?? progress.createdAt, timeZone)}${progress.cancelReason ? `: “${progress.cancelReason}”` : ''}. Its links no longer work.`;
  }
}
