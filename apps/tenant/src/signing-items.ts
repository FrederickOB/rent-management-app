import type { TenantSigningView } from '@rent/contracts';
import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import { formatDate, formatTime, leasesAre } from './format';

// What waits for the tenant under "To sign" (TL-07; M7 plan 4.5 and 4.10): leases to sign and
// notices to acknowledge. A notice is acknowledged, never agreed to, and never declined; not
// signing it never stops it. The words for a lease stay as they were before M7.

type Item = TenantSigningView;
export type ItemNotice = NonNullable<Item['notice']>;

/** Whether an item is a notice to acknowledge rather than a lease to sign. */
export const isNoticeItem = (item: Item): boolean =>
  item.subject === 'notice' || Boolean(item.notice);

/** Waiting for the tenant's own signature now. */
export const isWaiting = (item: Item): boolean =>
  item.status === 'pending' && item.signer.status === 'pending';

/** "1 notice is", "2 notices are". */
export function noticesAre(count: number): string {
  return count === 1 ? '1 notice is' : `${count} notices are`;
}

export interface ToSignSummary {
  readonly text: string;
  readonly waiting: boolean;
  readonly action: string;
}

/** Home's line about what waits under To sign. */
export function toSignSummary(items: readonly Item[]): ToSignSummary {
  const waiting = items.filter(isWaiting);
  const leases = waiting.filter((item) => !isNoticeItem(item)).length;
  const notices = waiting.length - leases;
  if (waiting.length === 0) {
    const leaseOut = items.some((item) => !isNoticeItem(item));
    return leaseOut
      ? {
          text: 'You have signed. We are waiting for the others to sign.',
          waiting: false,
          action: 'See who has signed',
        }
      : { text: 'You have acknowledged every notice here.', waiting: false, action: 'See them' };
  }
  const parts: string[] = [];
  if (leases > 0) parts.push(`${leasesAre(leases)} waiting for your signature.`);
  if (notices > 0) parts.push(`${noticesAre(notices)} waiting for you to acknowledge receipt.`);
  return {
    text: parts.join(' '),
    waiting: true,
    action: leases > 0 ? 'Review and sign' : 'Read and acknowledge',
  };
}

/** "Issued 4 Nov 2026, 09:00 GMT (Africa/Accra)", and the notice's date where it has one. */
export function noticeDates(notice: ItemNotice): string[] {
  const lines = [`Issued ${formatTime(notice.issuedAt)}`];
  if (notice.effectiveDate) lines.push(`Effective date ${formatDate(notice.effectiveDate)}`);
  return lines;
}

/** The statement that signing acknowledges receipt: the API's, or the domain's own words. */
export const noticeStatement = (notice: ItemNotice): string =>
  notice.statement.trim() || NOTICE_SIGNING_STATEMENT;
