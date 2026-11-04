import type { SigningPage } from './links-api';

// A notice's signing page (M7 plan 4.5 and 4.8; CLAUDE.md section 9). A notice is acknowledged,
// never agreed to: the page says so above the signature box, offers no decline, and never blocks
// the notice because it is not signed. A notice that was corrected or closed still opens,
// read-only, with a banner naming the new notice where there is one.

export type Notice = NonNullable<SigningPage['notice']>;

/** Whether the link is for a notice. */
export const isNotice = (page: SigningPage): boolean =>
  page.subject === 'notice' || Boolean(page.notice);

/** The notice on a notice's link, or null for a lease. */
export const noticeOf = (page: SigningPage): Notice | null =>
  isNotice(page) ? (page.notice ?? null) : null;

/**
 * Whether the page may offer "I do not want to sign". Never for a notice: a tenant cannot decline
 * receipt (plan 4.5). For a lease, unless the API says otherwise.
 */
export const canDecline = (page: SigningPage): boolean =>
  !isNotice(page) && page.canDecline !== false;

/** The read-only state of a notice that was corrected or closed, or null while it is live. */
export function readOnlyReason(page: SigningPage): 'superseded' | 'closed' | null {
  if (!isNotice(page)) return null;
  if (page.reason === 'notice_superseded') return 'superseded';
  if (page.reason === 'notice_closed') return 'closed';
  return null;
}

/** The banner on a notice that was corrected or closed (plan 4.8). */
export function readOnlyBanner(page: SigningPage): string | null {
  const why = readOnlyReason(page);
  const landlord = page.landlord.name;
  if (why === 'superseded') {
    const next = page.notice?.supersededBy?.number;
    return next
      ? `This notice has been replaced by notice ${next}. ${landlord} sends you the new notice with a link of its own. You can still read and download this one.`
      : `This notice has been replaced by a later notice. ${landlord} sends you the new notice with a link of its own. You can still read and download this one.`;
  }
  if (why === 'closed')
    return `${landlord} has closed this notice. You can still read and download it here.`;
  return null;
}

/** "Notice N-000001: Notice of entry", or the document's title when the API sends no notice. */
export function noticeHeading(page: SigningPage): string {
  const notice = noticeOf(page);
  return notice ? `Notice ${notice.number}: ${notice.typeLabel}` : page.document.title;
}

/** The decline route's answer when the API refuses to decline a notice (409). */
export const NOTICE_NOT_DECLINABLE = 'NOTICE_NOT_DECLINABLE';

/**
 * The problem code to send the page after a refused decline. The API refuses a notice with 409;
 * its code names the notice. Anything else keeps the API's own code, as for a lease.
 */
export function declineProblem(result: { readonly status: number; readonly code: string }): string {
  return result.status === 409 && /NOTICE/i.test(result.code) ? NOTICE_NOT_DECLINABLE : result.code;
}
