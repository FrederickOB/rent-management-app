import { DEFAULT_TIME_ZONE, formatInstant, instantFrom } from '@rent/domain/dates';

/** An instant for people, always naming the time zone (DO-04), e.g. `28 Oct 2026, 14:05 GMT (Africa/Accra)`. */
export function formatTime(value: string | Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  try {
    return formatInstant(instantFrom(value), timeZone);
  } catch {
    return typeof value === 'string' ? value : value.toISOString();
  }
}

/** The calendar date of an instant in the company's time zone, e.g. `28 Oct 2026`. */
export function formatDate(value: string, timeZone: string = DEFAULT_TIME_ZONE): string {
  try {
    const format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    return format.format(instantFrom(value).epochMilliseconds);
  } catch {
    return value;
  }
}

/** Display names only; what a role may do is decided by the policy, never here. */
const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  agency_admin: 'Agency admin',
  property_manager: 'Property manager',
  accountant: 'Accountant',
  caretaker: 'Caretaker',
  adviser: 'Adviser',
  platform_admin: 'Platform admin',
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return 'No role';
  return ROLE_LABELS[role] ?? humanise(role);
}

const COMPANY_KIND_LABELS: Record<string, string> = {
  landlord: 'Landlord',
  agency: 'Agency',
  platform: 'Platform',
};

export function companyKindLabel(kind: string): string {
  return COMPANY_KIND_LABELS[kind] ?? humanise(kind);
}

/** `sender_name`, `senderName` and `sender-name` all become `Sender name`. */
export function humanise(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Two letters for a company without a logo. */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((word) => /^[A-Za-z]/.test(word));
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}
