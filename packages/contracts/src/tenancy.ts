import { oc } from '@orpc/contract';
import { SIGNER_ROLES } from '@rent/domain/esign';
import { MESSAGE_CHANNELS } from '@rent/domain/messaging';
import {
  BREAK_PARTIES,
  ID_TYPES,
  LEASE_END_REASONS,
  LEASE_STATUSES,
  LEASE_USES,
  PLACEHOLDERS,
  RENT_CYCLES,
  STARTER_TEMPLATE_KINDS,
} from '@rent/domain/tenancy';
import { z } from 'zod';
import { approvalSchema } from './approvals';

/**
 * Tenants, leases, templates and e-signing (TL-01 to TL-07, TL-09, PB-09, TX-05, AR-05; M3 plan
 * 4.15). Amounts are integer pesewas in `*Minor` fields. The signing pages' own API is in links.ts.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const phone = z.string().trim().max(24);
const email = z.string().trim().email().max(254);
const minor = z.number().int();
const flag = z.stringbool().optional();
const ok = z.object({ ok: z.literal(true) });

const TENANT_KINDS = ['individual', 'company'] as const;
const CONTACT_KINDS = ['guarantor', 'next_of_kin', 'employer', 'signatory', 'finance'] as const;
const ID_STATUSES = [
  'none',
  'not_started',
  'pending',
  'verified',
  'not_matched',
  'recorded',
] as const;

export const consentStateSchema = z.object({ sms: z.boolean(), email: z.boolean() });
const consentInput = z.object({ sms: z.boolean().optional(), email: z.boolean().optional() });

export const contactSchema = z.object({
  id: uuid,
  kind: z.enum(CONTACT_KINDS),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  relationship: z.string().nullable(),
  organisation: z.string().nullable(),
  position: z.string().nullable(),
  notes: z.string().nullable(),
  consent: consentStateSchema,
  archived: z.boolean(),
});
export type ContactRow = z.infer<typeof contactSchema>;

const contactInput = z.object({
  kind: z.enum(CONTACT_KINDS),
  name: z.string().trim().min(2).max(160),
  phone: phone.nullable().optional(),
  email: email.nullable().optional(),
  relationship: optionalText(80),
  organisation: optionalText(160),
  position: optionalText(120),
  notes: optionalText(1000),
  consent: consentInput.optional(),
});

/** A caretaker sees a tenant's name, phone and units only (plan 4.14). */
export const tenantLimitedSchema = z.object({
  access: z.literal('limited'),
  id: uuid,
  kind: z.enum(TENANT_KINDS),
  displayName: z.string(),
  phone: z.string().nullable(),
  units: z.array(z.string()),
});

export const tenantSchema = z.object({
  access: z.literal('full'),
  id: uuid,
  kind: z.enum(TENANT_KINDS),
  displayName: z.string(),
  legalName: z.string().nullable(),
  phone: z.string().nullable(),
  whatsappPhone: z.string().nullable(),
  email: z.string().nullable(),
  occupation: z.string().nullable(),
  businessType: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  tinMasked: z.string().nullable(),
  identity: z.object({
    type: z.enum(ID_TYPES).nullable(),
    masked: z.string().nullable(),
    status: z.enum(ID_STATUSES),
    verifiedAt: iso.nullable(),
  }),
  notes: z.string().nullable(),
  units: z.array(z.string()),
  consent: consentStateSchema,
  archived: z.boolean(),
  createdAt: iso,
});
export type TenantRowView = z.infer<typeof tenantSchema>;

export const idCheckSchema = z.object({
  id: uuid,
  idType: z.enum(ID_TYPES),
  status: z.enum(['pending', 'verified', 'not_matched', 'cancelled']),
  lastResult: z.string().nullable(),
  polls: z.number().int(),
  lastPolledAt: iso.nullable(),
  checkedAt: iso.nullable(),
  completedAt: iso.nullable(),
  createdAt: iso,
});

const leaseSummarySchema = z.object({
  id: uuid,
  status: z.enum(LEASE_STATUSES),
  unitCode: z.string(),
  startDate: isoDate,
  endDate: isoDate,
});

export const tenantDetailSchema = tenantSchema.extend({
  contacts: z.array(contactSchema),
  leases: z.array(leaseSummarySchema),
  idChecks: z.array(idCheckSchema),
});
export type TenantDetailView = z.infer<typeof tenantDetailSchema>;

const tenantAnySchema = z.discriminatedUnion('access', [tenantSchema, tenantLimitedSchema]);
const tenantDetailAnySchema = z.discriminatedUnion('access', [
  tenantDetailSchema,
  tenantLimitedSchema,
]);

export const duplicateSchema = z.object({
  tenantId: uuid,
  displayName: z.string(),
  matchedOn: z.enum(['phone', 'id_number', 'tin']),
});

const tenantSaved = z.object({ tenant: tenantDetailSchema, duplicates: z.array(duplicateSchema) });

const identityInput = {
  idType: z.enum(ID_TYPES).nullable().optional(),
  /** Never logged; stored encrypted and shown masked. */
  idNumber: z.string().trim().max(32).nullable().optional(),
  idCountry: z.string().trim().length(2).nullable().optional(),
  tin: z.string().trim().max(20).nullable().optional(),
};

const tenantFields = {
  displayName: z.string().trim().min(2).max(160),
  legalName: optionalText(200),
  phone: phone.nullable().optional(),
  whatsappPhone: phone.nullable().optional(),
  email: email.nullable().optional(),
  occupation: optionalText(120),
  businessType: optionalText(120),
  registrationNumber: optionalText(40),
  notes: optionalText(2000),
  ...identityInput,
};

export const timelineEventSchema = z.object({
  at: iso,
  action: z.string(),
  recordType: z.string().nullable(),
  recordId: z.string().nullable(),
  actorName: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
});

export const tenantsContract = {
  list: oc
    .route({ method: 'GET', path: '/tenants', summary: 'Tenants this person may see (TL-01)' })
    .input(
      z.object({
        // M11 review: no `search` here; a name or phone goes by POST (`search` below).
        kind: z.enum(TENANT_KINDS).optional(),
        withActiveLease: flag,
        idStatus: z.enum(ID_STATUSES).optional(),
        includeArchived: flag,
      }),
    )
    .output(z.array(tenantAnySchema)),
  /**
   * M11 decision 6: the search by POST, so a phone number or a name never sits in a URL (and so
   * in no access log or browser history). `list` takes the filters only (M11 review).
   */
  search: oc
    .route({ method: 'POST', path: '/tenants/search', summary: 'Search tenants (TL-01)' })
    .input(
      z.object({
        search: z.string().max(80).optional(),
        kind: z.enum(TENANT_KINDS).optional(),
        withActiveLease: z.boolean().optional(),
        idStatus: z.enum(ID_STATUSES).optional(),
        includeArchived: z.boolean().optional(),
      }),
    )
    .output(z.array(tenantAnySchema)),
  get: oc
    .route({ method: 'GET', path: '/tenants/{tenantId}' })
    .input(z.object({ tenantId: uuid }))
    .output(tenantDetailAnySchema),
  timeline: oc
    .route({ method: 'GET', path: '/tenants/{tenantId}/timeline' })
    .input(z.object({ tenantId: uuid }))
    .output(z.array(timelineEventSchema)),
  create: oc
    .route({
      method: 'POST',
      path: '/tenants',
      summary: 'An individual or company tenant, with contacts and consent (TL-01 to TL-04)',
    })
    .input(
      z.object({
        kind: z.enum(TENANT_KINDS),
        ...tenantFields,
        consent: consentInput.optional(),
        contacts: z.array(contactInput).max(20).optional(),
      }),
    )
    .output(tenantSaved),
  update: oc
    .route({ method: 'PATCH', path: '/tenants/{tenantId}' })
    .input(
      z.object({
        tenantId: uuid,
        ...tenantFields,
        displayName: z.string().trim().min(2).max(160).optional(),
      }),
    )
    .output(tenantSaved),
  archive: oc
    .route({ method: 'POST', path: '/tenants/{tenantId}/archive' })
    .input(z.object({ tenantId: uuid }))
    .output(ok),
  duplicates: oc
    .route({
      method: 'POST',
      path: '/tenants/duplicates',
      summary: 'Tenants with the same phone, ID number or TIN (a warning, never a block)',
    })
    .input(
      z.object({
        phone: phone.nullable().optional(),
        ...identityInput,
        excludeTenantId: uuid.nullable().optional(),
      }),
    )
    .output(z.array(duplicateSchema)),
  addContact: oc
    .route({ method: 'POST', path: '/tenants/{tenantId}/contacts' })
    .input(contactInput.extend({ tenantId: uuid }))
    .output(contactSchema),
  updateContact: oc
    .route({ method: 'PATCH', path: '/tenants/{tenantId}/contacts/{contactId}' })
    .input(
      z.object({
        tenantId: uuid,
        contactId: uuid,
        name: z.string().trim().min(2).max(160).optional(),
        phone: phone.nullable().optional(),
        email: email.nullable().optional(),
        relationship: optionalText(80),
        organisation: optionalText(160),
        position: optionalText(120),
        notes: optionalText(1000),
      }),
    )
    .output(contactSchema),
  archiveContact: oc
    .route({ method: 'POST', path: '/tenants/{tenantId}/contacts/{contactId}/archive' })
    .input(z.object({ tenantId: uuid, contactId: uuid }))
    .output(ok),
  recordConsent: oc
    .route({
      method: 'POST',
      path: '/tenants/{tenantId}/consent',
      summary:
        'Record that the tenant or a contact granted or withdrew consent, by channel (CM-09)',
    })
    .input(
      z.object({
        tenantId: uuid,
        contactId: uuid.nullable().optional(),
        channel: z.enum(MESSAGE_CHANNELS),
        action: z.enum(['grant', 'withdraw']),
      }),
    )
    .output(consentStateSchema),
  startIdCheck: oc
    .route({
      method: 'POST',
      path: '/tenants/{tenantId}/id-check',
      summary: 'Start a biometric Ghana Card check through the identity provider (TL-02)',
    })
    .input(z.object({ tenantId: uuid }))
    .output(idCheckSchema),
  refreshIdCheck: oc
    .route({ method: 'POST', path: '/tenants/{tenantId}/id-check/refresh', summary: 'Check again' })
    .input(z.object({ tenantId: uuid }))
    .output(idCheckSchema),
  revealIdNumber: oc
    .route({
      method: 'POST',
      path: '/tenants/{tenantId}/id-number/reveal',
      summary: 'Show the ID number, with a reason; audited (TL-02)',
    })
    .input(z.object({ tenantId: uuid, reason: z.string().trim().min(10).max(300) }))
    .output(z.object({ idType: z.enum(ID_TYPES), idNumber: z.string(), country: z.string() })),
  revealTin: oc
    .route({
      method: 'POST',
      path: '/tenants/{tenantId}/tin/reveal',
      summary: 'Show a company tenant’s TIN, with a reason; audited (TL-04)',
    })
    .input(z.object({ tenantId: uuid, reason: z.string().trim().min(10).max(300) }))
    .output(z.object({ tin: z.string() })),
};

// Templates ------------------------------------------------------------------------------------

const placeholderNames = Object.keys(PLACEHOLDERS) as [string, ...string[]];

export const templateContentSchema = z.object({
  sections: z
    .array(
      z.object({
        key: z.string().min(2).max(41),
        heading: z.string().trim().min(1).max(200),
        clauses: z
          .array(
            z.object({
              key: z.string().min(2).max(41),
              title: z.string().trim().max(200).nullable(),
              body: z.string().max(6_000),
              required: z.boolean(),
              editable: z.boolean(),
            }),
          )
          .max(100),
      }),
    )
    .min(1)
    .max(30),
});

export const templateVersionSchema = z.object({
  id: uuid,
  version: z.number().int(),
  content: templateContentSchema,
  changeNote: z.string().nullable(),
  createdAt: iso,
  counselReview: z
    .object({ reviewedAt: iso, reviewedBy: uuid.nullable(), note: z.string() })
    .nullable(),
});

export const templateSchema = z.object({
  id: uuid,
  name: z.string(),
  kind: z.enum(['residential', 'commercial', 'short_fixed_term', 'custom']),
  starterKind: z.enum(STARTER_TEMPLATE_KINDS).nullable(),
  archived: z.boolean(),
  latest: templateVersionSchema,
  versions: z.array(
    z.object({ id: uuid, version: z.number().int(), counselReviewed: z.boolean() }),
  ),
});
export type TemplateRowView = z.infer<typeof templateSchema>;

export const leaseTemplatesContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/lease-templates',
      summary: 'Templates, with the three starters seeded on first use (TL-05)',
    })
    .input(z.object({ includeArchived: flag }))
    .output(z.array(templateSchema)),
  get: oc
    .route({ method: 'GET', path: '/lease-templates/{templateId}' })
    .input(z.object({ templateId: uuid }))
    .output(templateSchema),
  placeholders: oc
    .route({ method: 'GET', path: '/lease-templates/placeholders', summary: 'The fixed list' })
    .output(z.array(z.object({ name: z.enum(placeholderNames), description: z.string() }))),
  create: oc
    .route({ method: 'POST', path: '/lease-templates' })
    .input(
      z.object({
        name: z.string().trim().min(2).max(120),
        kind: z.enum(['residential', 'commercial', 'short_fixed_term', 'custom']),
        content: templateContentSchema,
        changeNote: optionalText(500),
      }),
    )
    .output(templateSchema),
  publish: oc
    .route({
      method: 'POST',
      path: '/lease-templates/{templateId}/versions',
      summary: 'Publish a new version; earlier versions never change',
    })
    .input(
      z.object({
        templateId: uuid,
        content: templateContentSchema,
        changeNote: optionalText(500),
        /**
         * The version the editor started from. When it is no longer the latest, the publish is
         * refused (409 `template_changed`), so one person's changes never silently replace another's.
         */
        baseVersion: z.number().int().positive().optional(),
      }),
    )
    .output(templateSchema),
  review: oc
    .route({
      method: 'POST',
      path: '/lease-template-versions/{versionId}/review',
      summary: 'Record, once, that counsel reviewed this version (decision 3)',
    })
    .input(z.object({ versionId: uuid, note: z.string().trim().min(10).max(1000) }))
    .output(templateSchema),
};

// Leases ---------------------------------------------------------------------------------------

const ruleRefSchema = z.object({
  ruleId: uuid,
  verificationStatus: z.enum(['verified', 'from_prd', 'unverified']),
  source: z.string(),
  warning: z.boolean(),
});

const breakClauseSchema = z.object({
  fromDate: isoDate,
  party: z.enum(BREAK_PARTIES),
  noticeDays: z.number().int().min(0).max(3650),
  creditUnusedDays: z.boolean(),
});

const stepSchema = z.object({ effectiveFrom: isoDate, monthlyRentMinor: minor.positive() });

export const partyInputSchema = z.object({
  role: z.enum(SIGNER_ROLES),
  name: z.string().trim().min(2).max(160),
  phone: phone.nullable().optional(),
  email: email.nullable().optional(),
  tenantContactId: uuid.nullable().optional(),
  staffPersonId: uuid.nullable().optional(),
  required: z.boolean().optional(),
  paperSignedOn: isoDate.nullable().optional(),
});

export const partySchema = z.object({
  id: uuid,
  role: z.enum(SIGNER_ROLES),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  tenantContactId: uuid.nullable(),
  staffPersonId: uuid.nullable(),
  required: z.boolean(),
  position: z.number().int(),
  paperSignedOn: isoDate.nullable(),
});

const termsFields = {
  startDate: isoDate,
  endDate: isoDate,
  monthlyRentMinor: minor.positive(),
  cycle: z.enum(RENT_CYCLES),
  initialAdvanceMonths: z.number().int().min(1).max(600).nullable().optional(),
  depositMinor: minor.min(0).nullable().optional(),
  serviceChargeMonthlyMinor: minor.positive().nullable().optional(),
  steps: z.array(stepSchema).max(60).optional(),
  breakClause: breakClauseSchema.nullable().optional(),
  noticeDays: z.number().int().min(0).max(3650),
  use: z.enum(LEASE_USES).optional(),
};

const draftFields = {
  templateId: uuid.nullable().optional(),
  servicePhones: z.array(phone).max(5).optional(),
  serviceEmails: z.array(email).max(5).optional(),
  witnessRequired: z.boolean().optional(),
  parties: z.array(partyInputSchema).max(20).optional(),
};

export const leaseLimitedSchema = z.object({
  access: z.literal('limited'),
  id: uuid,
  status: z.enum(LEASE_STATUSES),
  unit: z.object({ id: uuid, code: z.string() }),
  startDate: isoDate,
  endDate: isoDate,
});

export const leaseSchema = z.object({
  access: z.literal('full'),
  id: uuid,
  status: z.enum(LEASE_STATUSES),
  use: z.enum(LEASE_USES),
  unit: z.object({ id: uuid, code: z.string(), propertyId: uuid, propertyName: z.string() }),
  tenant: z.object({ id: uuid, displayName: z.string(), kind: z.enum(TENANT_KINDS) }),
  template: z
    .object({
      templateId: uuid,
      versionId: uuid,
      name: z.string(),
      version: z.number().int(),
      counselReviewed: z.boolean(),
    })
    .nullable(),
  terms: z.object({
    startDate: isoDate,
    endDate: isoDate,
    monthlyRentMinor: minor,
    currency: z.literal('GHS'),
    cycle: z.enum(RENT_CYCLES),
    initialAdvanceMonths: z.number().int().nullable(),
    depositMinor: minor.nullable(),
    serviceChargeMonthlyMinor: minor.nullable(),
    steps: z.array(stepSchema),
    breakClause: breakClauseSchema.nullable(),
    noticeDays: z.number().int(),
    periodCount: z.number().int(),
  }),
  servicePhones: z.array(z.string()),
  serviceEmails: z.array(z.string()),
  witnessRequired: z.boolean(),
  parties: z.array(partySchema),
  /** Only under advance_rent_policy `warn`, when the terms exceed the rule (AR-05). */
  advanceFlag: z
    .object({
      monthsDemanded: z.number().int(),
      limitMonths: z.number().int(),
      rule: ruleRefSchema.nullable(),
    })
    .nullable(),
  signing: z.object({
    signedAt: iso.nullable(),
    method: z.enum(['esign', 'paper']).nullable(),
    signedOnPaper: z.boolean(),
    signedDocument: z.boolean(),
  }),
  lifecycle: z.object({
    activatedOn: isoDate.nullable(),
    holdingOverSince: isoDate.nullable(),
    endingReason: z.enum(['non_renewal', 'notice']).nullable(),
    endingNote: z.string().nullable(),
    moveOutDate: isoDate.nullable(),
    endedOn: isoDate.nullable(),
    endReason: z.enum(LEASE_END_REASONS).nullable(),
    cancelledAt: iso.nullable(),
    cancelReason: z.string().nullable(),
  }),
  renewsLeaseId: uuid.nullable(),
  renewal: z.object({ id: uuid, status: z.enum(LEASE_STATUSES), startDate: isoDate }).nullable(),
  trackers: z.object({
    rentControl: z.object({
      applies: z.boolean(),
      deadline: isoDate.nullable(),
      registrationNumber: z.string().nullable(),
      registeredOn: isoDate.nullable(),
      done: z.boolean(),
      rule: ruleRefSchema.nullable(),
    }),
    stamping: z.object({
      deadline: isoDate.nullable(),
      stampedOn: isoDate.nullable(),
      stampedCopy: z.boolean(),
      done: z.boolean(),
      rule: ruleRefSchema.nullable(),
    }),
    formalLease: z.object({
      required: z.boolean(),
      practitioner: z.string().nullable(),
      wetSignedCopy: z.boolean(),
      registeredOn: isoDate.nullable(),
      registrationNumber: z.string().nullable(),
      done: z.boolean(),
      rule: ruleRefSchema.nullable(),
    }),
  }),
  counselReviewWarning: z.boolean(),
  createdAt: iso,
});
export type LeaseDetailView = z.infer<typeof leaseSchema>;

export const leaseListRowSchema = z.object({
  access: z.literal('full'),
  id: uuid,
  status: z.enum(LEASE_STATUSES),
  unit: z.object({ id: uuid, code: z.string() }),
  propertyName: z.string(),
  tenant: z.object({ id: uuid, displayName: z.string() }),
  startDate: isoDate,
  endDate: isoDate,
  monthlyRentMinor: minor,
  cycle: z.enum(RENT_CYCLES),
  signedOnPaper: z.boolean(),
  advanceFlagged: z.boolean(),
});

const leaseAnySchema = z.discriminatedUnion('access', [leaseSchema, leaseLimitedSchema]);

export const chargePeriodSchema = z.object({
  sequence: z.number().int(),
  chargeType: z.enum(['rent', 'service_charge']),
  periodStart: isoDate,
  periodEnd: isoDate,
  amountMinor: minor,
  currency: z.literal('GHS'),
  prorated: z.boolean(),
  source: z.enum(['schedule', 'holding_over']),
});

export const expiringLeaseSchema = z.object({
  id: uuid,
  status: z.enum(LEASE_STATUSES),
  unitCode: z.string(),
  propertyName: z.string(),
  tenantName: z.string(),
  endDate: isoDate,
  daysLeft: z.number().int(),
  renewal: z.object({ id: uuid, status: z.enum(LEASE_STATUSES) }).nullable(),
});

const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});

// E-signing (TL-07) ------------------------------------------------------------------------------

const SIGNER_STATUSES = ['pending', 'signed', 'declined'] as const;

export const signingProgressSchema = z.object({
  requestId: uuid,
  /** preparing (the PDF is rendering), pending (out for signature), completed, declined or cancelled. */
  status: z.enum(['preparing', 'pending', 'completed', 'declined', 'cancelled']),
  createdAt: iso,
  openedAt: iso.nullable(),
  completedAt: iso.nullable(),
  declinedAt: iso.nullable(),
  declineReason: z.string().nullable(),
  cancelledAt: iso.nullable(),
  cancelReason: z.string().nullable(),
  /** SHA-256 of the frozen PDF the signers sign, once it exists. */
  documentSha256: z.string().nullable(),
  /** SHA-256 of the signed copy with its certificate, once everyone has signed. */
  finalSha256: z.string().nullable(),
  frozenDocument: z.boolean(),
  signedDocument: z.boolean(),
  signers: z.array(
    z.object({
      id: uuid,
      role: z.enum(SIGNER_ROLES),
      roleLabel: z.string(),
      name: z.string(),
      phoneMasked: z.string().nullable(),
      emailMasked: z.string().nullable(),
      /** Where their code goes: the phone, or the email for a signatory with only an email. */
      codeChannel: z.enum(['sms', 'email']),
      required: z.boolean(),
      position: z.number().int(),
      status: z.enum(SIGNER_STATUSES),
      firstOpenedAt: iso.nullable(),
      lastOpenedAt: iso.nullable(),
      signedAt: iso.nullable(),
      declinedAt: iso.nullable(),
      declineReason: z.string().nullable(),
      /** Set while five wrong codes keep signing locked. */
      lockedUntil: iso.nullable(),
      /** The newest signing link: sent by message, handed over by staff, or opened from the app. Null: none yet (no consented channel: hand one over). */
      lastLink: z
        .object({
          createdAt: iso,
          expiresAt: iso,
          via: z.enum(['message', 'handover', 'tenant_app']),
          openedAt: iso.nullable(),
        })
        .nullable(),
      copySent: z.boolean(),
    }),
  ),
});
export type SigningProgress = z.infer<typeof signingProgressSchema>;

export const issuedLinkSchema = z.object({ url: z.string().url(), expiresAt: iso });

export const signingRequestsContract = {
  handoverLink: oc
    .route({
      method: 'POST',
      path: '/signing-requests/{signingRequestId}/signers/{signerId}/link',
      summary:
        'A single-use signing link to show as a QR code or copy, for a signer with no consented channel (decision 2); it replaces the signer’s earlier link',
    })
    .input(z.object({ signingRequestId: uuid, signerId: uuid }))
    .output(issuedLinkSchema),
};

export const leasesContract = {
  list: oc
    .route({ method: 'GET', path: '/leases' })
    .input(
      z.object({
        status: z.enum(LEASE_STATUSES).optional(),
        unitId: uuid.optional(),
        tenantId: uuid.optional(),
        propertyId: uuid.optional(),
        search: z.string().max(80).optional(),
      }),
    )
    .output(z.array(z.discriminatedUnion('access', [leaseListRowSchema, leaseLimitedSchema]))),
  /**
   * M11 review: the lease search by POST, so a tenant's name or a unit code typed into the search
   * never sits in a URL; the same filters and answer as `list`.
   */
  search: oc
    .route({ method: 'POST', path: '/leases/search', summary: 'Search leases (TL-06)' })
    .input(
      z.object({
        status: z.enum(LEASE_STATUSES).optional(),
        unitId: uuid.optional(),
        tenantId: uuid.optional(),
        propertyId: uuid.optional(),
        search: z.string().max(80).optional(),
      }),
    )
    .output(z.array(z.discriminatedUnion('access', [leaseListRowSchema, leaseLimitedSchema]))),
  expiring: oc
    .route({
      method: 'GET',
      path: '/leases/expiring',
      summary: 'Leases ending in the next days, 90 by default (TL-09)',
    })
    .input(z.object({ days: z.coerce.number().int().min(1).max(366).default(90) }))
    .output(z.array(expiringLeaseSchema)),
  get: oc
    .route({ method: 'GET', path: '/leases/{leaseId}' })
    .input(z.object({ leaseId: uuid }))
    .output(leaseAnySchema),
  schedule: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/schedule',
      summary: 'The rent schedule (TL-06)',
    })
    .input(z.object({ leaseId: uuid }))
    .output(z.array(chargePeriodSchema)),
  preview: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/preview',
      summary: 'The lease document as HTML, exactly as its PDF would read (TL-05)',
    })
    .input(z.object({ leaseId: uuid }))
    .output(z.object({ html: z.string(), warnings: z.array(z.string()) })),
  create: oc
    .route({ method: 'POST', path: '/leases', summary: 'A draft lease (TL-06)' })
    .input(z.object({ unitId: uuid, tenantId: uuid, ...termsFields, ...draftFields }))
    .output(leaseSchema),
  update: oc
    .route({ method: 'PATCH', path: '/leases/{leaseId}', summary: 'Change a draft' })
    .input(
      z.object({
        leaseId: uuid,
        ...draftFields,
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        monthlyRentMinor: minor.positive().optional(),
        cycle: z.enum(RENT_CYCLES).optional(),
        initialAdvanceMonths: termsFields.initialAdvanceMonths,
        depositMinor: termsFields.depositMinor,
        serviceChargeMonthlyMinor: termsFields.serviceChargeMonthlyMinor,
        steps: termsFields.steps,
        breakClause: termsFields.breakClause,
        noticeDays: z.number().int().min(0).max(3650).optional(),
        use: termsFields.use,
      }),
    )
    .output(leaseSchema),
  cancel: oc
    .route({ method: 'POST', path: '/leases/{leaseId}/cancel', summary: 'Cancel a draft' })
    .input(z.object({ leaseId: uuid, reason: z.string().trim().min(3).max(500) }))
    .output(leaseSchema),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/lease-uploads',
      summary: 'Upload a paper lease scan, stamped copy or formal lease (PDF, JPEG or PNG)',
    })
    .input(
      z.object({
        leaseId: uuid.nullable().optional(),
        contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
        sizeBytes: z.number().int().min(1).max(20_000_000),
      }),
    )
    .output(presignedUpload),
  recordPaper: oc
    .route({
      method: 'POST',
      path: '/leases/paper',
      summary: 'Record a lease already signed on paper, with the scan (decision 7)',
    })
    .input(
      z.object({
        unitId: uuid,
        tenantId: uuid,
        ...termsFields,
        ...draftFields,
        parties: z.array(partyInputSchema).min(1).max(20),
        scanUploadId: uuid,
        signedOn: isoDate,
        /**
         * The first rent period to bill (M4a decision 1): by default the first that starts on or
         * after today. An earlier period start brings recent arrears in; a later one leaves out
         * months the tenant paid before the platform.
         */
        billingStartDate: isoDate.optional(),
      }),
    )
    .output(leaseSchema),
  renewal: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/renewal',
      summary: 'Offer a renewal: a draft that starts the day after this lease ends (TL-09)',
    })
    .input(z.object({ leaseId: uuid }))
    .output(leaseSchema),
  ending: oc
    .route({ method: 'POST', path: '/leases/{leaseId}/ending', summary: 'Non-renewal or a notice' })
    .input(
      z.object({
        leaseId: uuid,
        reason: z.enum(['non_renewal', 'notice']),
        note: optionalText(500),
      }),
    )
    .output(leaseSchema),
  moveOut: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/move-out',
      summary: 'Record a move-out: the lease ends and the unit is freed',
    })
    .input(z.object({ leaseId: uuid, moveOutDate: isoDate, note: optionalText(300) }))
    .output(leaseSchema),
  rentControl: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/trackers/rent-control',
      summary: 'Record the Rent Control registration (TX-05)',
    })
    .input(
      z.object({
        leaseId: uuid,
        registrationNumber: z.string().trim().min(2).max(40),
        registeredOn: isoDate,
      }),
    )
    .output(leaseSchema),
  stamping: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/trackers/stamping',
      summary: 'Record the stamped copy and its date (OQ-45)',
    })
    .input(z.object({ leaseId: uuid, stampedOn: isoDate, uploadId: uuid }))
    .output(leaseSchema),
  formalLease: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/trackers/formal-lease',
      summary: 'Record the formal lease: practitioner, wet-signed copy, registration (OQ-44)',
    })
    .input(
      z.object({
        leaseId: uuid,
        practitioner: optionalText(160),
        wetSignedUploadId: uuid.nullable().optional(),
        registeredOn: isoDate.nullable().optional(),
        registrationNumber: optionalText(60),
      }),
    )
    .output(leaseSchema),
  download: oc
    .route({ method: 'GET', path: '/leases/{leaseId}/files/{which}/download' })
    .input(z.object({ leaseId: uuid, which: z.enum(['signed', 'stamped', 'formal']) }))
    .output(z.object({ url: z.string() })),
  issue: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/issue',
      summary:
        'Send a draft for e-signature (TL-07): terms frozen, document rendered, links sent to each signer once the PDF exists',
    })
    .input(z.object({ leaseId: uuid }))
    .output(leaseSchema),
  recall: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/recall',
      summary: 'Recall a lease from signature: links revoked, the lease back to draft',
    })
    .input(z.object({ leaseId: uuid, reason: optionalText(500) }))
    .output(leaseSchema),
  signing: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/signing',
      summary: 'The latest signing request and each signer’s progress; null if never issued',
    })
    .input(z.object({ leaseId: uuid }))
    .output(signingProgressSchema.nullable()),
  signingDocument: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/signing/document',
      summary: 'A 5-minute link to the frozen PDF the signers sign, or the signed copy',
    })
    .input(z.object({ leaseId: uuid, which: z.enum(['frozen', 'signed']).default('frozen') }))
    .output(z.object({ url: z.string() })),
  cancelSigned: oc
    .route({
      method: 'POST',
      path: '/leases/{leaseId}/cancel-signed',
      summary: 'Ask a second person to approve cancelling a signed lease before it starts (AD-05)',
    })
    .input(z.object({ leaseId: uuid, reason: z.string().trim().min(10).max(500) }))
    .output(approvalSchema),
};

// The tenant app (TL-01) -----------------------------------------------------------------------

const tenancyCardSchema = z.object({
  leaseId: uuid,
  status: z.enum(LEASE_STATUSES),
  unitCode: z.string(),
  propertyName: z.string(),
  address: z.string(),
  startDate: isoDate,
  endDate: isoDate,
  monthlyRentMinor: minor,
  currency: z.literal('GHS'),
  cycle: z.enum(RENT_CYCLES),
  signedOnPaper: z.boolean(),
  documentId: uuid.nullable(),
});

const landlordSchema = z.object({
  companyId: uuid,
  name: z.string(),
  /** The landlord company's time zone (IANA), for showing its times; always sent. */
  timeZone: z.string().optional(),
});

export const tenancyGroupSchema = z.object({
  landlord: landlordSchema,
  tenancies: z.array(tenancyCardSchema),
});
export type TenancyGroupView = z.infer<typeof tenancyGroupSchema>;

export const tenancyDetailSchema = tenancyCardSchema.extend({
  landlord: landlordSchema,
  depositMinor: minor.nullable(),
  serviceChargeMonthlyMinor: minor.nullable(),
  noticeDays: z.number().int(),
  steps: z.array(stepSchema),
});
export type TenancyDetailView = z.infer<typeof tenancyDetailSchema>;

export const tenantSigningSchema = z.object({
  signingRequestId: uuid,
  leaseId: uuid,
  status: z.enum(['preparing', 'pending', 'completed', 'declined', 'cancelled']),
  title: z.string(),
  sentAt: iso.nullable(),
  landlord: landlordSchema,
  /** The lease as the tenant app shows it elsewhere; null only if it cannot be read. */
  tenancy: tenancyCardSchema.nullable(),
  /** The tenant's own signer: sign through POST /me/signing/{signer.id}/link. */
  signer: z.object({
    id: uuid,
    name: z.string(),
    status: z.enum(SIGNER_STATUSES),
    signedAt: iso.nullable(),
  }),
  signers: z.array(
    z.object({ roleLabel: z.string(), name: z.string(), status: z.enum(SIGNER_STATUSES) }),
  ),
  /**
   * M7 (plan 4.5): a lease to sign, or a notice to acknowledge; M8 (plan 4.7) adds the move-in
   * report to sign. Always sent; optional before M7.
   */
  subject: z.enum(['lease', 'notice', 'move_in_report']).optional(),
  /** The notice, for a notice to acknowledge; null for a lease. */
  notice: z
    .object({
      noticeId: uuid,
      number: z.string(),
      typeLabel: z.string(),
      issuedAt: iso,
      effectiveDate: isoDate.nullable(),
      /** Signing acknowledges receipt, not agreement. */
      statement: z.string(),
    })
    .nullable()
    .optional(),
});
export type TenantSigningView = z.infer<typeof tenantSigningSchema>;

/** A notice the tenant received from a landlord, for the tenancy's documents (M7 plan 4.10). */
export const tenantNoticeSchema = z.object({
  noticeId: uuid,
  number: z.string(),
  typeLabel: z.string(),
  issuedAt: iso,
  effectiveDate: isoDate.nullable(),
  leaseId: uuid.nullable(),
  unitCode: z.string().nullable(),
  /** Whether this tenant (or, for a company, one of its signatories) acknowledged it. */
  acknowledged: z.boolean(),
  acknowledgedAt: iso.nullable(),
  /** The notice was corrected by a later one, or closed. */
  superseded: z.boolean(),
  closed: z.boolean(),
  /** The tenant's own signer, while it can still be acknowledged in the app. */
  signerId: uuid.nullable(),
});
export type TenantNoticeView = z.infer<typeof tenantNoticeSchema>;

/**
 * A document of a tenancy in the app (M8 plan 4.11): the signed lease, the move-in report (signed
 * by every party, TL-08) and the final statement at move-out (TL-11). Download each through
 * GET /me/documents/{documentId}/download.
 */
export const tenantTenancyDocumentSchema = z.object({
  kind: z.enum(['lease', 'move_in_report', 'final_statement']),
  title: z.string(),
  documentId: uuid,
  /** Signed by everyone (the lease, the move-in report); a statement is never signed. */
  signed: z.boolean(),
  createdAt: iso,
});
export type TenantTenancyDocumentView = z.infer<typeof tenantTenancyDocumentSchema>;

export const tenantAppContract = {
  tenancies: oc
    .route({
      method: 'GET',
      path: '/me/tenancies',
      summary: 'The signed-in tenant’s tenancies, by landlord (TL-01)',
    })
    .output(z.array(tenancyGroupSchema)),
  tenancy: oc
    .route({ method: 'GET', path: '/me/tenancies/{leaseId}' })
    .input(z.object({ leaseId: uuid }))
    .output(tenancyDetailSchema),
  documents: oc
    .route({
      method: 'GET',
      path: '/me/tenancies/{leaseId}/documents',
      summary:
        'The tenancy’s documents: the signed lease, the move-in report and the final statement (M8)',
    })
    .input(z.object({ leaseId: uuid }))
    .output(z.array(tenantTenancyDocumentSchema)),
  documentDownload: oc
    .route({
      method: 'GET',
      path: '/me/documents/{documentId}/download',
      summary:
        'A short-lived link to one of the tenant’s documents: the signed lease, the move-in report or the final statement',
    })
    .input(z.object({ documentId: uuid }))
    .output(z.object({ url: z.string() })),
  signing: oc
    .route({
      method: 'GET',
      path: '/me/signing',
      summary: 'Leases out for the signed-in tenant’s own signature, by landlord (TL-07)',
    })
    .output(z.array(tenantSigningSchema)),
  notices: oc
    .route({
      method: 'GET',
      path: '/me/notices',
      summary: 'Notices the signed-in tenant received, by landlord (M7 plan 4.10)',
    })
    .output(z.array(z.object({ landlord: landlordSchema, notices: z.array(tenantNoticeSchema) }))),
  noticeDocument: oc
    .route({
      method: 'GET',
      path: '/me/notices/{noticeId}/document',
      summary: 'A short-lived link to the notice, or to the signed acknowledgement once signed',
    })
    .input(z.object({ noticeId: uuid }))
    .output(z.object({ url: z.string() })),
  signingLink: oc
    .route({
      method: 'POST',
      path: '/me/signing/{signerId}/link',
      summary:
        'A fresh signing link for the tenant’s own signer, to open in the app’s browser. For a lease it replaces the link sent by message; for a notice, earlier links keep working (M7 decision 6)',
    })
    .input(z.object({ signerId: uuid }))
    .output(issuedLinkSchema),
};
