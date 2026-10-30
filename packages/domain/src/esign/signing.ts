import { DomainError } from '../errors';

/**
 * The e-signature engine's rules (TL-07; CLAUDE.md section 9; ADR-007). One engine serves leases
 * now and notices from M7. These are security defaults held in code, not legal values.
 */
export const SIGNER_ROLES = ['tenant', 'signatory', 'landlord', 'guarantor', 'witness'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export const SIGNER_ROLE_LABELS: Record<SignerRole, string> = {
  tenant: 'Tenant',
  signatory: 'Signatory for the tenant',
  landlord: 'For the landlord',
  guarantor: 'Guarantor',
  witness: 'Witness',
};

export type SignerStatus = 'pending' | 'signed' | 'declined';
/** `preparing` while the frozen PDF renders; signers get their links once it is `pending`. */
export type SigningRequestStatus = 'preparing' | 'pending' | 'completed' | 'declined' | 'cancelled';

/** A request still collecting signatures, or about to. */
export const OPEN_SIGNING_STATUSES: readonly SigningRequestStatus[] = ['preparing', 'pending'];

/** One-time codes for signing (section 9): 6 digits, 10 minutes, 5 attempts, then a lock. */
export const SIGNING_CODE = {
  digits: 6,
  validMinutes: 10,
  maxAttempts: 5,
  lockMinutes: 30,
  sendsPerLinkPer15Minutes: 3,
} as const;

/** Signing links expire after 30 days (architecture section 9). */
export const SIGNING_LINK_DAYS = 30;

/**
 * What a signer's secure link is for: signing, then downloading the signed copy once everyone
 * has signed (M3 plan 4.8). Each link serves one signer and one purpose.
 */
export const SIGNER_LINK_PURPOSES = ['sign', 'signed_copy'] as const;
export type SignerLinkPurpose = (typeof SIGNER_LINK_PURPOSES)[number];

/** A signed-copy link works for 30 days too; the tenant app keeps the copy after that. */
export const SIGNED_COPY_LINK_DAYS = 30;

/**
 * Limits on the signing page (CLAUDE.md sections 9 and 10; architecture section 11). Security
 * defaults, not law. The per-link code limit is the plan's (4.8). The per-destination and per-IP
 * limits are wider: one landlord's signatory signs many leases from one phone, and mobile networks
 * in Ghana put many people behind one address. Windows are fixed, in minutes.
 */
export const SIGNING_LIMITS = {
  codeSendsPerLink: { count: SIGNING_CODE.sendsPerLinkPer15Minutes, windowMinutes: 15 },
  codeSendsPerDestination: { count: 10, windowMinutes: 15 },
  codeSendsPerIp: { count: 30, windowMinutes: 15 },
  /** Signing and declining attempts. */
  actionsPerIp: { count: 60, windowMinutes: 15 },
  opensPerLink: { count: 60, windowMinutes: 15 },
  opensPerIp: { count: 600, windowMinutes: 15 },
} as const;

/** Signing reminders go out this many hours after the links were sent: a product default. */
export const DEFAULT_SIGNING_REMINDER_HOURS: readonly number[] = [24, 72, 168];

/** A reminder step on the signing ladder, keyed for idempotency (`after-24h`). */
export interface SigningReminderStep {
  readonly key: string;
  readonly hours: number;
}

/**
 * The reminder steps due once `elapsedMs` have passed since the links went out, oldest first.
 * The caller sends only the latest unsent one (reminderToSend), so a missed run never sends a
 * burst of reminders.
 */
export function dueSigningReminders(
  elapsedMs: number,
  hours: readonly number[],
): SigningReminderStep[] {
  return [...new Set(hours)]
    .filter((h) => Number.isFinite(h) && h > 0 && elapsedMs >= h * 3_600_000)
    .sort((a, b) => a - b)
    .map((h) => ({ key: `after-${h}h`, hours: h }));
}

/** How a signer was verified, for the certificate: never the full phone number or email. */
export function verificationLabel(channel: 'sms' | 'email', destinationMasked: string): string {
  return channel === 'sms'
    ? `One-time code sent by SMS to ${destinationMasked}`
    : `One-time code sent by email to ${destinationMasked}`;
}

/** An email address masked for display: the first letter and the domain (`k***@example.org`). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

/** A request is complete when every required signer has signed and nobody has declined. */
export function signingComplete(
  signers: readonly { readonly required: boolean; readonly status: SignerStatus }[],
): boolean {
  if (signers.some((s) => s.status === 'declined')) return false;
  const required = signers.filter((s) => s.required);
  return required.length > 0 && required.every((s) => s.status === 'signed');
}

export const SIGNATURE_METHODS = ['typed', 'drawn'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

/** A typed signature is the signer's name; a drawn one must come with the drawing. */
export function checkSignature(input: {
  readonly method: SignatureMethod;
  readonly typedName?: string | null;
  readonly hasDrawing?: boolean;
}): { method: SignatureMethod; typedName: string | null } {
  if (input.method === 'typed') {
    const name = input.typedName?.trim() ?? '';
    if (name.length < 2 || name.length > 120)
      throw new DomainError('signature.name_required', 'Type your full name to sign');
    return { method: 'typed', typedName: name };
  }
  if (!input.hasDrawing)
    throw new DomainError('signature.drawing_required', 'Draw your signature to sign');
  return { method: 'drawn', typedName: input.typedName?.trim() || null };
}

/**
 * The consent shown before signing, by version; the version and its hash are kept with every
 * signature. It describes what is recorded, not the legal effect (counsel: OQ-44, OQ-10).
 */
export const SIGNING_CONSENT: Readonly<Record<string, string>> = {
  'consent.v1':
    'I have read this document and I agree to sign it electronically. I understand that my ' +
    'signature, the time, the phone number or email that received my code, and my device ' +
    'details are recorded with the document’s fingerprint.',
};
export const CURRENT_CONSENT = 'consent.v1';
