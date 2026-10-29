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
export type SigningRequestStatus = 'pending' | 'completed' | 'declined' | 'cancelled';

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
