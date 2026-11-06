/**
 * Maintenance jobs (MI-01 to MI-06; CM-04; architecture section 7). M6 created jobs in their first
 * state only, with a ticket number per company and the media attached; M8 adds triage,
 * assignment, artisans and the board on the same table.
 */
export const MAINTENANCE_JOB_STATUSES = [
  'reported',
  'triaged',
  'assigned',
  'in_progress',
  'work_done',
  'closed',
  'cancelled',
] as const;
export type MaintenanceJobStatus = (typeof MAINTENANCE_JOB_STATUSES)[number];

export const MAINTENANCE_JOB_STATUS_LABELS: Record<MaintenanceJobStatus, string> = {
  reported: 'Reported',
  triaged: 'Triaged',
  assigned: 'Assigned',
  in_progress: 'In progress',
  work_done: 'Work done',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** Jobs still to be worked: the board's open columns. */
export const OPEN_MAINTENANCE_STATUSES: readonly MaintenanceJobStatus[] = [
  'reported',
  'triaged',
  'assigned',
  'in_progress',
  'work_done',
];

/** Where a repair was reported (MI-01). */
export const MAINTENANCE_SOURCES = ['whatsapp', 'app', 'sms', 'email', 'staff'] as const;
export type MaintenanceSource = (typeof MAINTENANCE_SOURCES)[number];

/** Media a repair may carry (CM-04): photos, video, voice notes and documents. */
export const MAINTENANCE_ATTACHMENT_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type MaintenanceAttachmentKind = (typeof MAINTENANCE_ATTACHMENT_KINDS)[number];

/**
 * When a file was taken (MI-06): with the report, before work started, after it was done, or at
 * some other step (a note, a dispute).
 */
export const MAINTENANCE_ATTACHMENT_STAGES = ['report', 'before', 'after', 'other'] as const;
export type MaintenanceAttachmentStage = (typeof MAINTENANCE_ATTACHMENT_STAGES)[number];

/** MI-02. */
export const MAINTENANCE_PRIORITIES = ['emergency', 'urgent', 'routine'] as const;
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

export const MAINTENANCE_PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  emergency: 'Emergency',
  urgent: 'Urgent',
  routine: 'Routine',
};

/** MI-03: the PRD's ten categories, plus "other". */
export const MAINTENANCE_CATEGORIES = [
  'plumbing',
  'electrical',
  'roofing',
  'carpentry',
  'painting',
  'pest_control',
  'air_conditioning',
  'generator',
  'borehole',
  'septic',
  'other',
] as const;
export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];

export const MAINTENANCE_CATEGORY_LABELS: Record<MaintenanceCategory, string> = {
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  roofing: 'Roofing',
  carpentry: 'Carpentry',
  painting: 'Painting',
  pest_control: 'Pest control',
  air_conditioning: 'Air conditioning',
  generator: 'Generator',
  borehole: 'Borehole',
  septic: 'Septic',
  other: 'Other',
};

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
