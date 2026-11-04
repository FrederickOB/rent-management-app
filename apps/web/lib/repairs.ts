import type {
  MaintenanceAttachmentKind,
  MaintenanceJobStatus,
  MaintenanceSource,
} from '@rent/domain/maintenance';

// Reported repairs (CM-04 stub; M6 decision 12). Only the first state exists until M8.

export const REPAIR_STATUS_LABELS: Record<MaintenanceJobStatus, string> = {
  reported: 'Reported',
};

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
