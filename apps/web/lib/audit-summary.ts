import { humanise, roleLabel } from './format';

/** One line of an audit event's summary: a field and its value before and after. */
export interface Change {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface AuditSummary {
  /** `changed`: before and after; `created` or `removed`: one side; `details`: a service event's data. */
  readonly kind: 'changed' | 'created' | 'removed' | 'details' | 'none';
  readonly changes: readonly Change[];
}

// Bookkeeping columns that change on every write and say nothing to a reader.
const NOISE = new Set(['updated_at', 'updatedAt']);
const NOISE_ON_CREATE = new Set([
  'id',
  'company_id',
  'companyId',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
]);

const FIELD_LABELS: Record<string, string> = {
  display_name: 'Display name',
  legal_name: 'Legal name',
  sender_name: 'Sender name',
  primary_colour: 'Primary colour',
  accent_colour: 'Accent colour',
  logo_document_id: 'Logo',
  time_zone: 'Time zone',
  country_code: 'Country',
  nominated_approver: 'Nominated approver',
  person_id: 'Person',
  invited_by: 'Invited by',
  revoked_at: 'Removed at',
  authMethod: 'Sign-in method',
  rentReminderOffsetsDays: 'Rent reminders (days from the due date)',
  noticeReminderOffsetsHours: 'Notice reminders (hours after issue)',
  renewalReminderDays: 'Renewal reminders (days before the lease ends)',
  advanceRentPolicy: 'Advance rent over the limit',
  approvalExpiryDays: 'Approval requests expire after (days)',
  approvalCoolingOffHours: 'Cooling-off before self-confirmation (hours)',
};

const VALUE_LABELS: Record<string, (value: unknown) => string | null> = {
  role: (value) => (typeof value === 'string' ? roleLabel(value) : null),
  authMethod: (value) =>
    value === 'password_totp'
      ? 'Password and authenticator code'
      : value === 'phone_otp'
        ? 'Phone code'
        : null,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const fieldLabel = (key: string): string => FIELD_LABELS[key] ?? humanise(key);

/** A value as people read it. Never empty, so a cleared field still shows. */
export function formatValue(value: unknown, key?: string): string {
  const special = key ? VALUE_LABELS[key]?.(value) : null;
  if (special) return special;
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value))
    return value.length === 0 ? '(none)' : value.map((item) => formatValue(item)).join(', ');
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '(none)';
    return entries.map(([k, v]) => `${fieldLabel(k)}: ${formatValue(v, k)}`).join('; ');
  }
  return JSON.stringify(value) ?? '(none)';
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Field-by-field differences; nested objects (company settings) are compared key by key. */
function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = '',
): Change[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes: Change[] = [];
  for (const key of keys) {
    if (NOISE.has(key)) continue;
    const a = before[key];
    const b = after[key];
    if (same(a, b)) continue;
    const label = prefix ? `${prefix}: ${fieldLabel(key)}` : fieldLabel(key);
    if (isPlainObject(a) && isPlainObject(b)) {
      changes.push(...diff(a, b, label));
    } else {
      changes.push({ field: label, before: formatValue(a, key), after: formatValue(b, key) });
    }
  }
  return changes;
}

function oneSide(row: Record<string, unknown>, side: 'before' | 'after'): Change[] {
  return Object.entries(row)
    .filter(([key]) => !NOISE_ON_CREATE.has(key))
    .map(([key, value]) => {
      const text = formatValue(value, key);
      return {
        field: fieldLabel(key),
        before: side === 'before' ? text : null,
        after: side === 'after' ? text : null,
      };
    });
}

/**
 * A readable summary of an audit event's data (AD-07). Row changes recorded by the database
 * carry `before` and `after` rows; service events carry their own small payloads.
 */
export function summarise(data: unknown): AuditSummary {
  if (!isPlainObject(data)) return { kind: 'none', changes: [] };
  const before = isPlainObject(data.before) ? data.before : null;
  const after = isPlainObject(data.after) ? data.after : null;
  const hidden = Array.isArray(data.redacted_changed)
    ? data.redacted_changed
        .filter((key): key is string => typeof key === 'string')
        .map((key) => ({ field: fieldLabel(key), before: '(hidden)', after: '(hidden)' }))
    : [];
  if (before && after) return { kind: 'changed', changes: [...diff(before, after), ...hidden] };
  if (after) return { kind: 'created', changes: oneSide(after, 'after') };
  if (before) return { kind: 'removed', changes: oneSide(before, 'before') };
  const details = Object.entries(data).map(([key, value]) => ({
    field: fieldLabel(key),
    before: null,
    after: formatValue(value, key),
  }));
  return details.length > 0 ? { kind: 'details', changes: details } : { kind: 'none', changes: [] };
}
