import type { DataProtectionRequestView } from '@rent/contracts';
import type {
  DataProtectionRequestKind,
  DataProtectionRequestStatus,
  RetentionCategory,
} from '@rent/domain/data-protection';
import { formatBusinessDate } from './business-dates';
import { errorCode } from './errors';

// Data protection requests under Act 843 (M11 decision 5; plan 4.4): words for the register on
// the tenant page and under Settings, Data protection. The landlord is the controller.

export const REQUEST_KIND_LABELS: Record<DataProtectionRequestKind, string> = {
  access: 'See their data (access)',
  correction: 'Correct their data',
  erasure: 'Erase their data',
  objection: 'Object to a use of their data',
};

export const REQUEST_STATUS_LABELS: Record<DataProtectionRequestStatus, string> = {
  received: 'Received',
  in_progress: 'In progress',
  completed: 'Completed',
  refused: 'Refused',
};

export const RETENTION_CATEGORY_LABELS: Record<RetentionCategory, string> = {
  financial_and_notices: 'Financial records and notices',
  messages: 'Messages',
  identity: 'Identity checks',
  webhook_bodies: 'Payment provider messages',
  tenant_profile: 'The tenant’s profile',
  photos_and_recordings: 'Photos, videos and voice notes',
};

/** A request's due date, or why it has none (OQ-65: the response time is not set yet). */
export function dueText(
  request: Pick<DataProtectionRequestView, 'dueOn' | 'dueRuleUnverified'>,
): string {
  if (request.dueOn)
    return `Due ${formatBusinessDate(request.dueOn)}${request.dueRuleUnverified ? ' (the response time is not yet verified by counsel)' : ''}`;
  return 'No due date yet: the response time is still to be set by counsel.';
}

/** Closed requests take no more changes (409 REQUEST_CLOSED). */
export const isClosed = (status: DataProtectionRequestStatus): boolean =>
  status === 'completed' || status === 'refused';

/** The statuses a request may move to from where it is. */
export function nextStatuses(status: DataProtectionRequestStatus): DataProtectionRequestStatus[] {
  if (status === 'received') return ['in_progress', 'completed', 'refused'];
  if (status === 'in_progress') return ['completed', 'refused'];
  return [];
}

/**
 * An erasure's outcome in words (decision 5): what was anonymised, and each record kept under
 * its retention rule, with until when.
 */
export function erasureLines(
  request: Pick<DataProtectionRequestView, 'anonymised' | 'held' | 'messagingStopped'>,
): string[] {
  const lines: string[] = [];
  if (request.messagingStopped) lines.push('Messages to the tenant have stopped on every channel.');
  for (const item of request.anonymised)
    lines.push(
      `${RETENTION_CATEGORY_LABELS[item.category]}: ${item.records} ${item.records === 1 ? 'record' : 'records'} anonymised.`,
    );
  for (const item of request.held)
    lines.push(
      `${RETENTION_CATEGORY_LABELS[item.category]}: ${item.records} ${item.records === 1 ? 'record' : 'records'} kept ${
        item.until ? `until ${formatBusinessDate(item.until)}` : 'until the retention period is set'
      }, because ${item.reason.charAt(0).toLowerCase()}${item.reason.slice(1).replace(/\.$/, '')}.`,
    );
  return lines;
}

/** A received date: on or before today. */
export function receivedProblem(value: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter the day the request was received.';
  if (value > today) return 'A request is received today or earlier.';
  return null;
}

export const DATA_PROTECTION_MESSAGES: Record<string, string> = {
  REQUEST_CLOSED: 'The request is closed, so it can’t change any more.',
  NOT_ACCESS_REQUEST: 'Only an access request has an export.',
  NOT_ERASURE_REQUEST: 'Only an erasure request erases anything.',
};

export const dataProtectionMessage = (error: unknown): string | null =>
  DATA_PROTECTION_MESSAGES[errorCode(error)] ?? null;

export const EXPORT_POLL_MS = 3_000;
export const EXPORT_POLL_TRIES = 40;
