/**
 * Data protection requests under Act 843 (M11 decision 5; plan 4.4; prd-issues 30). The landlord
 * is the controller: the register lives in its app.
 */
export const DATA_PROTECTION_REQUEST_KINDS = [
  'access',
  'correction',
  'erasure',
  'objection',
] as const;
export type DataProtectionRequestKind = (typeof DATA_PROTECTION_REQUEST_KINDS)[number];

export const DATA_PROTECTION_REQUEST_STATUSES = [
  'received',
  'in_progress',
  'completed',
  'refused',
] as const;
export type DataProtectionRequestStatus = (typeof DATA_PROTECTION_REQUEST_STATUSES)[number];

/**
 * The categories of personal records, each anonymised only once its retention rule is verified
 * and its period has passed (decision 5).
 */
export const RETENTION_CATEGORIES = [
  'financial_and_notices',
  'messages',
  'identity',
  'webhook_bodies',
  'tenant_profile',
  // M11 follow-up (0074): the photos, videos and voice notes a tenant sent.
  'photos_and_recordings',
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

/** The rules key for the response time to a request (null and unverified until counsel). */
export const REQUEST_RESPONSE_DAYS_RULE = 'data_protection.request_response_days';
