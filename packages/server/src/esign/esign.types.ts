import type {
  SignatureMethod,
  SignerLinkPurpose,
  SignerRole,
  SignerStatus,
  SigningRequestStatus,
} from '@rent/domain/esign';

/** Who a signer is, for consent and messages (M3 plan 4.8 and 4.9). */
export type SignerSubject =
  | { readonly type: 'tenant' }
  | { readonly type: 'tenant_contact'; readonly contactId: string }
  | { readonly type: 'staff'; readonly personId: string }
  | { readonly type: 'other' };

/** A signer as the request snapshots them when it is created. */
export interface NewSigner {
  readonly role: SignerRole;
  readonly subject: SignerSubject;
  readonly leasePartyId: string | null;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly required: boolean;
  readonly isTestContact: boolean;
}

/** A lease sent for signature: its frozen PDF is rendering under `renderRequestId`. */
export interface NewLeaseSigningRequest {
  readonly companyId: string;
  readonly propertyId: string;
  readonly tenantId: string;
  readonly leaseId: string;
  readonly renderRequestId: string;
  readonly createdBy: string | null;
  readonly signers: readonly NewSigner[];
}

/** The browser behind a links API call, as apps/links saw it. Evidence, never logged. */
export interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string;
}

/** What a link's page shows. Only `sign` accepts any action. */
export type LinkScreen = 'sign' | 'signed' | 'declined' | 'copy' | 'expired' | 'revoked' | 'closed';

/**
 * Why a link no longer signs: a newer link went out, the request closed, or everyone who must
 * sign has signed (`signed_by_all`, review finding 9).
 */
export type LinkReason =
  'superseded' | 'cancelled' | 'declined' | 'completed' | 'preparing' | 'signed_by_all' | null;

/** Who to contact about a link: the company and the landlord's signatory on the request. */
export interface LandlordContact {
  readonly name: string;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface SigningCodeState {
  readonly channel: 'sms' | 'email';
  /** Never the full phone number or email. */
  readonly destinationMasked: string;
  readonly sentAt: Date | null;
  readonly expiresAt: Date | null;
  readonly attemptsLeft: number;
  readonly sendsLeft: number;
  readonly lockedUntil: Date | null;
}

/** The signing page (apps/links /l/[token]). Document content only on the `sign` screen. */
export interface SigningPageView {
  readonly screen: LinkScreen;
  readonly reason: LinkReason;
  readonly purpose: SignerLinkPurpose;
  readonly landlord: LandlordContact;
  readonly timeZone: string;
  readonly linkExpiresAt: Date;
  readonly document: {
    readonly title: string;
    readonly reference: string;
    /** The frozen PDF's SHA-256: what every signer signs. */
    readonly sha256: string | null;
    /** The signed copy's SHA-256, once everyone has signed. */
    readonly finalSha256: string | null;
    /** The document's words as HTML, from the same template and data as the PDF. */
    readonly html: string | null;
    /**
     * Whether this link downloads a PDF now: the frozen document while signing, the document a
     * signer signed while their link is live, the signed copy on a copy link (review finding 4).
     */
    readonly downloadable: boolean;
  };
  readonly signer: {
    readonly name: string;
    readonly role: SignerRole;
    readonly roleLabel: string;
    readonly status: SignerStatus;
    readonly signedAt: Date | null;
    readonly declinedAt: Date | null;
  };
  readonly signers: readonly {
    readonly name: string;
    readonly roleLabel: string;
    readonly status: SignerStatus;
    readonly required: boolean;
  }[];
  readonly code: SigningCodeState | null;
  readonly consent: { readonly version: string; readonly text: string } | null;
}

export interface SignInput {
  readonly code: string;
  readonly method: SignatureMethod;
  readonly typedName?: string | null;
  /** A PNG data URL or its base64, from the drawing pad. */
  readonly drawing?: string | null;
  readonly consentVersion: string;
  readonly consentAccepted: boolean;
}

/** A link made for one signer: the raw token leaves the server once, in this result or a message. */
export interface IssuedLink {
  readonly url: string;
  readonly expiresAt: Date;
}

/** Signing progress for staff (lease detail, M3 plan 4.16). */
export interface SigningProgressView {
  readonly requestId: string;
  readonly status: SigningRequestStatus;
  readonly createdAt: Date;
  readonly openedAt: Date | null;
  readonly completedAt: Date | null;
  readonly declinedAt: Date | null;
  readonly declineReason: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelReason: string | null;
  readonly documentSha256: string | null;
  readonly finalSha256: string | null;
  readonly frozenDocument: boolean;
  readonly signedDocument: boolean;
  readonly signers: readonly SignerProgress[];
}

export interface SignerProgress {
  readonly id: string;
  readonly role: SignerRole;
  readonly roleLabel: string;
  readonly name: string;
  readonly phoneMasked: string | null;
  readonly emailMasked: string | null;
  /** Where codes go: the phone, or the email for a signatory with only an email. */
  readonly codeChannel: 'sms' | 'email';
  readonly required: boolean;
  readonly position: number;
  readonly status: SignerStatus;
  readonly firstOpenedAt: Date | null;
  readonly lastOpenedAt: Date | null;
  readonly signedAt: Date | null;
  readonly declinedAt: Date | null;
  readonly declineReason: string | null;
  readonly lockedUntil: Date | null;
  /** The newest link made for this signer, and how it went out. */
  readonly lastLink: {
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly via: 'message' | 'handover' | 'tenant_app';
    readonly openedAt: Date | null;
  } | null;
  /** A signed copy has been sent (by message) once everyone signed. */
  readonly copySent: boolean;
}

/** A signing request the tenant app lists for the signed-in tenant (GET /me/signing). */
export interface TenantSigningRequest {
  readonly signingRequestId: string;
  readonly leaseId: string;
  readonly status: SigningRequestStatus;
  readonly title: string;
  readonly sentAt: Date | null;
  /** The tenant's own signer on the request. */
  readonly signer: {
    readonly id: string;
    readonly name: string;
    readonly status: SignerStatus;
    readonly signedAt: Date | null;
  };
  readonly signers: readonly {
    readonly roleLabel: string;
    readonly name: string;
    readonly status: SignerStatus;
  }[];
}
