import {
  MAINTENANCE_JOB_STATUS_LABELS,
  type MaintenanceAttachmentKind,
  type MaintenanceJobStatus,
  type MaintenanceSource,
} from '@rent/domain/maintenance';

// Reported repairs (CM-04; M6 decision 12). M8 widens the statuses; their names come from the
// domain, so a new status can never leave a badge blank.

export const REPAIR_STATUS_LABELS: Readonly<Record<MaintenanceJobStatus, string>> =
  MAINTENANCE_JOB_STATUS_LABELS;

export const REPAIR_SOURCE_LABELS: Record<MaintenanceSource, string> = {
  whatsapp: 'On WhatsApp',
  app: 'In the tenant app',
  sms: 'By SMS',
  email: 'By email',
  staff: 'By staff',
};

export const REPAIR_MEDIA_LABELS: Record<MaintenanceAttachmentKind, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice note',
  document: 'Document',
};
