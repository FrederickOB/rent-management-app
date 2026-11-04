/**
 * Maintenance jobs (MI-01; CM-04 stub; M6 decision 12). M6 creates jobs in their first state only,
 * with a ticket number per company and the media attached; M8 adds triage, assignment, artisans
 * and the board on the same table (architecture section 7).
 */
export const MAINTENANCE_JOB_STATUSES = ['reported'] as const;
export type MaintenanceJobStatus = (typeof MAINTENANCE_JOB_STATUSES)[number];

/** Where a repair was reported (MI-01). */
export const MAINTENANCE_SOURCES = ['whatsapp', 'app', 'sms', 'email', 'staff'] as const;
export type MaintenanceSource = (typeof MAINTENANCE_SOURCES)[number];

/** Media a repair may carry (CM-04): photos, video, voice notes and documents. */
export const MAINTENANCE_ATTACHMENT_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type MaintenanceAttachmentKind = (typeof MAINTENANCE_ATTACHMENT_KINDS)[number];

/** The ticket number as tenants and staff see it: `MT-0042`. Numbers start at 1 per company. */
export function formatTicketNumber(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Not a ticket number: ${n}`);
  return `MT-${String(n).padStart(4, '0')}`;
}

/** The number in `MT-0042`, or null when the text is not a ticket number. */
export function parseTicketNumber(text: string): number | null {
  const match = /^MT-(\d{4,9})$/i.exec(text.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 ? n : null;
}
