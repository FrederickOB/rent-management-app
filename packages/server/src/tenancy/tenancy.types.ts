import type { SignerRole } from '@rent/domain/esign';
import type { MessageChannel } from '@rent/domain/messaging';
import type {
  BreakParty,
  IdType,
  LeaseStatus,
  LeaseUse,
  RentCycle,
  StarterTemplateKind,
  TemplateContent,
} from '@rent/domain/tenancy';

/** Views and inputs of the tenancy module (M3 plan sections 4.3 to 4.15). */
export const TENANT_KINDS = ['individual', 'company'] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

export const ID_STATUSES = [
  'none',
  'not_started',
  'pending',
  'verified',
  'not_matched',
  'recorded',
] as const;
export type IdStatus = (typeof ID_STATUSES)[number];

export const CONTACT_KINDS = [
  'guarantor',
  'next_of_kin',
  'employer',
  'signatory',
  'finance',
] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export type ConsentState = Record<MessageChannel, boolean>;

export interface ContactInput {
  readonly kind: ContactKind;
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly relationship?: string | null;
  readonly organisation?: string | null;
  readonly position?: string | null;
  readonly notes?: string | null;
  /** Consent the person gave, by channel (M3 decision 2), recorded with the contact. */
  readonly consent?: Partial<ConsentState>;
}

export interface TenantInput {
  readonly kind: TenantKind;
  readonly displayName: string;
  readonly legalName?: string | null;
  readonly phone?: string | null;
  readonly whatsappPhone?: string | null;
  readonly email?: string | null;
  readonly occupation?: string | null;
  readonly businessType?: string | null;
  readonly registrationNumber?: string | null;
  readonly tin?: string | null;
  readonly idType?: IdType | null;
  readonly idNumber?: string | null;
  /** A passport's issuing country, two letters. */
  readonly idCountry?: string | null;
  readonly notes?: string | null;
  readonly consent?: Partial<ConsentState>;
  readonly contacts?: readonly ContactInput[];
}

export type TenantPatch = Partial<Omit<TenantInput, 'kind' | 'contacts' | 'consent'>>;

export interface ContactView {
  readonly id: string;
  readonly kind: ContactKind;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly relationship: string | null;
  readonly organisation: string | null;
  readonly position: string | null;
  readonly notes: string | null;
  readonly consent: ConsentState;
  readonly archived: boolean;
}

/** What someone with only `tenant.view` sees (a caretaker): name, phone and unit (plan 4.14). */
export interface TenantLimitedView {
  readonly access: 'limited';
  readonly id: string;
  readonly kind: TenantKind;
  readonly displayName: string;
  readonly phone: string | null;
  readonly units: readonly string[];
}

export interface TenantView {
  readonly access: 'full';
  readonly id: string;
  readonly kind: TenantKind;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly phone: string | null;
  readonly whatsappPhone: string | null;
  readonly email: string | null;
  readonly occupation: string | null;
  readonly businessType: string | null;
  readonly registrationNumber: string | null;
  /** Masked; revealing it needs tenant.id.reveal and a reason. */
  readonly tinMasked: string | null;
  readonly identity: {
    readonly type: IdType | null;
    readonly masked: string | null;
    readonly status: IdStatus;
    readonly verifiedAt: Date | null;
  };
  readonly notes: string | null;
  readonly units: readonly string[];
  readonly consent: ConsentState;
  readonly archived: boolean;
  readonly createdAt: Date;
}

export interface TenantDetail extends TenantView {
  readonly contacts: readonly ContactView[];
  readonly leases: readonly LeaseSummary[];
  readonly idChecks: readonly IdCheckView[];
}

export interface DuplicateWarning {
  readonly tenantId: string;
  readonly displayName: string;
  readonly matchedOn: 'phone' | 'id_number' | 'tin';
}

export interface IdCheckView {
  readonly id: string;
  readonly idType: IdType;
  readonly status: 'pending' | 'verified' | 'not_matched' | 'cancelled';
  readonly lastResult: string | null;
  readonly polls: number;
  readonly lastPolledAt: Date | null;
  readonly checkedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export interface TimelineEvent {
  readonly at: Date;
  readonly action: string;
  readonly recordType: string | null;
  readonly recordId: string | null;
  readonly actorName: string | null;
  /** Only for people who may see the tenant's details. */
  readonly data: Record<string, unknown> | null;
}

// Leases -------------------------------------------------------------------------------------

export interface PartyInput {
  readonly role: SignerRole;
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly tenantContactId?: string | null;
  readonly staffPersonId?: string | null;
  readonly required?: boolean;
  /** A lease signed on paper: when this party signed (decision 7). */
  readonly paperSignedOn?: string | null;
}

export interface LeaseTermsInput {
  readonly startDate: string;
  readonly endDate: string;
  readonly monthlyRentMinor: number;
  readonly cycle: RentCycle;
  readonly initialAdvanceMonths?: number | null;
  readonly depositMinor?: number | null;
  readonly serviceChargeMonthlyMinor?: number | null;
  readonly steps?: readonly { readonly effectiveFrom: string; readonly monthlyRentMinor: number }[];
  readonly breakClause?: {
    readonly fromDate: string;
    readonly party: BreakParty;
    readonly noticeDays: number;
    readonly creditUnusedDays: boolean;
  } | null;
  readonly noticeDays: number;
  readonly use?: LeaseUse;
}

export interface LeaseDraftInput extends LeaseTermsInput {
  readonly unitId: string;
  readonly tenantId: string;
  /** The template whose latest version the lease is built from. */
  readonly templateId?: string | null;
  readonly servicePhones?: readonly string[];
  readonly serviceEmails?: readonly string[];
  readonly witnessRequired?: boolean;
  readonly parties?: readonly PartyInput[];
}

export type LeaseDraftPatch = Partial<Omit<LeaseDraftInput, 'unitId' | 'tenantId'>>;

export interface PaperLeaseInput extends LeaseDraftInput {
  /** The signed scan, uploaded through createUpload. */
  readonly scanUploadId: string;
  /** When the last party signed, a business date. */
  readonly signedOn: string;
}

export interface PartyView {
  readonly id: string;
  readonly role: SignerRole;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly tenantContactId: string | null;
  readonly staffPersonId: string | null;
  readonly required: boolean;
  readonly position: number;
  readonly paperSignedOn: string | null;
}

/** A rule a tracker deadline came from, shown with it (CLAUDE.md section 7). */
export interface RuleRef {
  readonly ruleId: string;
  readonly verificationStatus: 'verified' | 'from_prd' | 'unverified';
  readonly source: string;
  /** True until the value is verified: staff see a warning wherever the deadline is used. */
  readonly warning: boolean;
}

export interface LeaseTrackersView {
  readonly rentControl: {
    readonly applies: boolean;
    readonly deadline: string | null;
    readonly registrationNumber: string | null;
    readonly registeredOn: string | null;
    readonly done: boolean;
    readonly rule: RuleRef | null;
  };
  readonly stamping: {
    readonly deadline: string | null;
    readonly stampedOn: string | null;
    readonly stampedCopy: boolean;
    readonly done: boolean;
    readonly rule: RuleRef | null;
  };
  readonly formalLease: {
    readonly required: boolean;
    readonly practitioner: string | null;
    readonly wetSignedCopy: boolean;
    readonly registeredOn: string | null;
    readonly registrationNumber: string | null;
    readonly done: boolean;
    readonly rule: RuleRef | null;
  };
}

/** What someone with only `lease.view` sees (a caretaker): the unit and the dates (plan 4.14). */
export interface LeaseLimitedView {
  readonly access: 'limited';
  readonly id: string;
  readonly status: LeaseStatus;
  readonly unit: { readonly id: string; readonly code: string };
  readonly startDate: string;
  readonly endDate: string;
}

export interface LeaseView {
  readonly access: 'full';
  readonly id: string;
  readonly status: LeaseStatus;
  readonly use: LeaseUse;
  readonly unit: {
    readonly id: string;
    readonly code: string;
    readonly propertyId: string;
    readonly propertyName: string;
  };
  readonly tenant: { readonly id: string; readonly displayName: string; readonly kind: TenantKind };
  readonly template: {
    readonly templateId: string;
    readonly versionId: string;
    readonly name: string;
    readonly version: number;
    readonly counselReviewed: boolean;
  } | null;
  readonly terms: {
    readonly startDate: string;
    readonly endDate: string;
    readonly monthlyRentMinor: number;
    readonly currency: 'GHS';
    readonly cycle: RentCycle;
    readonly initialAdvanceMonths: number | null;
    readonly depositMinor: number | null;
    readonly serviceChargeMonthlyMinor: number | null;
    readonly steps: readonly {
      readonly effectiveFrom: string;
      readonly monthlyRentMinor: number;
    }[];
    readonly breakClause: {
      readonly fromDate: string;
      readonly party: BreakParty;
      readonly noticeDays: number;
      readonly creditUnusedDays: boolean;
    } | null;
    readonly noticeDays: number;
    readonly periodCount: number;
  };
  readonly servicePhones: readonly string[];
  readonly serviceEmails: readonly string[];
  readonly witnessRequired: boolean;
  readonly parties: readonly PartyView[];
  /**
   * Set only when the company's advance_rent_policy is `warn` and the terms ask for more months
   * in advance than the rule allows (AR-05). Never describes an advance as compliant.
   */
  readonly advanceFlag: {
    readonly monthsDemanded: number;
    readonly limitMonths: number;
    readonly rule: RuleRef | null;
  } | null;
  readonly signing: {
    readonly signedAt: Date | null;
    readonly method: 'esign' | 'paper' | null;
    /** A lease recorded from paper claims no e-signature evidence (decision 7). */
    readonly signedOnPaper: boolean;
    readonly signedDocument: boolean;
  };
  readonly lifecycle: {
    readonly activatedOn: string | null;
    readonly holdingOverSince: string | null;
    readonly endingReason: 'non_renewal' | 'notice' | null;
    readonly endingNote: string | null;
    readonly moveOutDate: string | null;
    readonly endedOn: string | null;
    readonly endReason: 'moved_out' | 'renewed' | null;
    readonly cancelledAt: Date | null;
    readonly cancelReason: string | null;
  };
  readonly renewsLeaseId: string | null;
  readonly renewal: {
    readonly id: string;
    readonly status: LeaseStatus;
    readonly startDate: string;
  } | null;
  readonly trackers: LeaseTrackersView;
  /** The template version has not been reviewed by counsel (decision 3). */
  readonly counselReviewWarning: boolean;
  readonly createdAt: Date;
}

export interface LeaseListRow {
  readonly access: 'full';
  readonly id: string;
  readonly status: LeaseStatus;
  readonly unit: { readonly id: string; readonly code: string };
  readonly propertyName: string;
  readonly tenant: { readonly id: string; readonly displayName: string };
  readonly startDate: string;
  readonly endDate: string;
  readonly monthlyRentMinor: number;
  readonly cycle: RentCycle;
  readonly signedOnPaper: boolean;
  readonly advanceFlagged: boolean;
}

export interface LeaseSummary {
  readonly id: string;
  readonly status: LeaseStatus;
  readonly unitCode: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface ChargePeriodView {
  readonly sequence: number;
  readonly chargeType: 'rent' | 'service_charge';
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly amountMinor: number;
  readonly currency: 'GHS';
  readonly prorated: boolean;
  readonly source: 'schedule' | 'holding_over';
}

export interface ExpiringLease {
  readonly id: string;
  readonly status: LeaseStatus;
  readonly unitCode: string;
  readonly propertyName: string;
  readonly tenantName: string;
  readonly endDate: string;
  readonly daysLeft: number;
  readonly renewal: { readonly id: string; readonly status: LeaseStatus } | null;
}

// Templates ------------------------------------------------------------------------------------

export interface TemplateVersionView {
  readonly id: string;
  readonly version: number;
  readonly content: TemplateContent;
  readonly changeNote: string | null;
  readonly createdAt: Date;
  readonly counselReview: {
    readonly reviewedAt: Date;
    readonly reviewedBy: string | null;
    readonly note: string;
  } | null;
}

export interface TemplateView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'residential' | 'commercial' | 'short_fixed_term' | 'custom';
  readonly starterKind: StarterTemplateKind | null;
  readonly archived: boolean;
  readonly latest: TemplateVersionView;
  readonly versions: readonly {
    readonly id: string;
    readonly version: number;
    readonly counselReviewed: boolean;
  }[];
}
