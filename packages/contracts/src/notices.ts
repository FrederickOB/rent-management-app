import { oc } from '@orpc/contract';
import {
  LADDER_NOTICE_TYPES,
  NOTICE_CHANNEL_MODES,
  NOTICE_CHANNELS,
  NOTICE_LADDER_ACTIONS,
  NOTICE_OUTCOMES,
  NOTICE_RECIPIENT_KINDS,
  NOTICE_RECORD_KINDS,
  NOTICE_STATUSES,
  NOTICE_TYPES,
  NOTICE_WARNING_CODES,
  NOTICE_WITHHELD_REASONS,
  RECEIVED_VIA,
  SERVICE_METHODS,
  STAFF_NOTICE_OUTCOMES,
  type NoticeSubtype,
  NOTICE_SUBTYPES,
} from '@rent/domain/notices';
import { LEASE_USES } from '@rent/domain/tenancy';
import { TASK_KINDS, TASK_RELATED_TYPES, TASK_STATUSES } from '@rent/domain/tasks';
import { z } from 'zod';
import { approvalSchema } from './approvals';

/**
 * Legal notices (LN-01 to LN-05, LN-07, LN-09), Rent Officer assessments (decision 3), the OQ-16
 * acknowledgement (decision 9) and staff tasks (CF-06); M7 plan 4.10 and 4.11. Growth only
 * (decision 14): a Starter company is refused with 403 `not_on_plan`. Amounts are integer pesewas
 * in `*Minor` fields; business dates are `YYYY-MM-DD` in the company's time zone; instants are UTC.
 * Writes that create records accept an `Idempotency-Key` header: a retry with the same key and
 * body returns the first answer, the same key with another body is refused with 422. The
 * append-only creates require one (400 `IDEMPOTENCY_KEY_REQUIRED` without it): service records,
 * received notices, and Rent Officer assessments with their corrections and voids. Starting a
 * notice's correction takes one optionally: one live correction per notice already stops a second.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const flag = z.stringbool().optional();
const download = z.object({ url: z.string() });
const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});

const ALL_SUBTYPES = [...new Set(Object.values(NOTICE_SUBTYPES).flat())] as unknown as readonly [
  NoticeSubtype,
  ...NoticeSubtype[],
];

const named = z.object({ id: uuid, name: z.string() });
const ruleStatus = z.enum(['verified', 'from_prd', 'unverified']);

export const noticeWarningSchema = z.object({
  code: z.enum(NOTICE_WARNING_CODES),
  message: z.string(),
  /** The rule the warning names, where it is about one. */
  ruleKey: z.string().nullable(),
});

/** Why issue is refused now (plan 4.3): a domain code such as `notice.quit_barred`, and why. */
export const noticeBlockerSchema = z.object({ code: z.string(), message: z.string() });

export const noticeRuleUsedSchema = z.object({
  key: z.string(),
  ruleId: uuid,
  value: z.unknown(),
  verificationStatus: ruleStatus,
});

/** The earliest lawful effective date and how it was reached (plan 4.3). */
export const earliestDateSchema = z.object({
  earliestDate: isoDate,
  serviceDate: isoDate,
  /** electronic_issue, physical_service, planned_issue (physical service still to come) or issue. */
  serviceDateBasis: z.enum(['electronic_issue', 'physical_service', 'planned_issue', 'issue']),
  periodDays: z.number().int(),
  periodSource: z.enum(['none', 'contractual', 'statutory']),
  contractualDays: z.number().int().nullable(),
  statutoryDays: z.number().int().nullable(),
  leaseEndApplied: z.boolean(),
});

export const quitBarSchema = z.object({
  barred: z.boolean(),
  /** The last barred day (inclusive), from the latest assessment on the unit. */
  barredUntil: isoDate.nullable(),
  latestAssessment: isoDate.nullable(),
});

/** One recipient's channels as planned at issue (decisions 4 and 5). */
export const noticeChannelPlanSchema = z.object({
  channel: z.enum(NOTICE_CHANNELS),
  /** service (named in the e-service clause), courtesy (ordinary consent), or withheld. */
  mode: z.enum(NOTICE_CHANNEL_MODES),
  reason: z.enum(NOTICE_WITHHELD_REASONS).nullable(),
});

const recipientStatus = z.enum(NOTICE_STATUSES);

export const noticeRecipientSchema = z.object({
  id: uuid,
  /**
   * `tenant`, `co_tenant` (another tenant party on a residential lease, served and acknowledging
   * for themself, with a ladder of their own) or `signatory` (acknowledges for a company tenant;
   * one signatory's acknowledgement stops every signatory's ladder, LN-07). Decision 7.
   */
  kind: z.enum(NOTICE_RECIPIENT_KINDS),
  name: z.string(),
  /** The tenant record the recipient is served under: the lease's tenant, for all three kinds. */
  partyTenantId: uuid,
  leaseId: uuid.nullable(),
  unitCode: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  emailMasked: z.string().nullable(),
  /** The furthest point this recipient reached (plan 4.4); null before issue. */
  status: recipientStatus.nullable(),
  /** Their party has acknowledged, so their ladder has stopped (LN-07). */
  acknowledged: z.boolean(),
  channels: z.array(noticeChannelPlanSchema),
  /** No channel can serve them electronically, so physical service is planned (decisions 4, 5). */
  physicalServicePlanned: z.boolean(),
  firstOpenedAt: iso.nullable(),
  signedAt: iso.nullable(),
  /** The channel whose delivery report confirmed delivery first (prd-issues 7). */
  deliveredVia: z.enum(NOTICE_CHANNELS).nullable(),
  deliveredAt: iso.nullable(),
});
export type NoticeRecipientView = z.infer<typeof noticeRecipientSchema>;

export const noticeEventSchema = z.object({
  id: uuid,
  kind: z.enum(NOTICE_RECORD_KINDS),
  recipientId: uuid.nullable(),
  channel: z.enum(NOTICE_CHANNELS).nullable(),
  /** Server time (LN-03). */
  at: iso,
  actorName: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
});

export const serviceRecordSchema = z.object({
  id: uuid,
  method: z.enum(SERVICE_METHODS),
  methodLabel: z.string(),
  servedAt: iso,
  servedByName: z.string(),
  witnessName: z.string().nullable(),
  recipientId: uuid.nullable(),
  notes: z.string().nullable(),
  hasPhoto: z.boolean(),
  hasAffidavit: z.boolean(),
  /** The record this one corrects; records are never edited (plan 4.7). */
  correctsRecordId: uuid.nullable(),
  correctedByRecordId: uuid.nullable(),
  recordedByName: z.string().nullable(),
  recordedAt: iso,
});

export const taskSchema = z.object({
  id: uuid,
  kind: z.enum(TASK_KINDS),
  kindLabel: z.string(),
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  property: named,
  unitCode: z.string().nullable(),
  tenantName: z.string().nullable(),
  relatedType: z.enum(TASK_RELATED_TYPES),
  relatedId: uuid,
  notice: z.object({ id: uuid, number: z.string().nullable(), typeLabel: z.string() }).nullable(),
  /** M8: the maintenance job an attend task is for (`MT-0042`). Always sent; optional before M8. */
  job: z.object({ id: uuid, ticket: z.string() }).nullable().optional(),
  assignee: z.object({ personId: uuid, name: z.string() }).nullable(),
  dueAt: iso,
  note: z.string().nullable(),
  createdAt: iso,
  completedAt: iso.nullable(),
  completedByName: z.string().nullable(),
  cancelledAt: iso.nullable(),
  /** Whether the reader may complete it now (caretakers: only their own). */
  mayComplete: z.boolean(),
  /** Whether the reader may cancel it (`tasks.manage`: managers, admins and landlords). */
  mayCancel: z.boolean(),
});
export type TaskView = z.infer<typeof taskSchema>;

const ladderStepSchema = z.object({
  key: z.string(),
  action: z.enum(NOTICE_LADDER_ACTIONS),
  afterHours: z.number().int(),
  channels: z.array(z.enum(NOTICE_CHANNELS)),
  statesRemainsInForce: z.boolean(),
  /** Held for the sending window (decision 11). */
  toTenant: z.boolean(),
});

export const noticeListRowSchema = z.object({
  id: uuid,
  /** N-000001 once issued (decision 15). */
  number: z.string().nullable(),
  type: z.enum(NOTICE_TYPES),
  typeLabel: z.string(),
  subtype: z.enum(ALL_SUBTYPES).nullable(),
  subtypeLabel: z.string().nullable(),
  status: z.enum(NOTICE_STATUSES),
  statusLabel: z.string(),
  outcome: z.enum(NOTICE_OUTCOMES).nullable(),
  tenant: named.nullable(),
  property: named,
  unitCode: z.string().nullable(),
  leaseId: uuid.nullable(),
  issuedAt: iso.nullable(),
  effectiveDate: isoDate.nullable(),
  /** Days since issue, by company dates (LN-09); null before issue. */
  daysOutstanding: z.number().int().nullable(),
  recipientCount: z.number().int(),
  signedRecipients: z.number().int(),
  ladderPaused: z.boolean(),
  ladderCancelled: z.boolean(),
  /** Plan 4.3: physical service recorded too late for the stated date. */
  servedTooLate: z.boolean(),
  correctsNumber: z.string().nullable(),
  correctedByNumber: z.string().nullable(),
  createdAt: iso,
});
export type NoticeListRow = z.infer<typeof noticeListRowSchema>;

/** What the reader may do now, for the screens; the API checks each again. */
const noticeActionsSchema = z.object({
  edit: z.boolean(),
  discard: z.boolean(),
  submit: z.boolean(),
  returnToDraft: z.boolean(),
  issue: z.boolean(),
  controlLadder: z.boolean(),
  recordService: z.boolean(),
  close: z.boolean(),
  correct: z.boolean(),
  /**
   * Show a recipient's handover link (QR or copy): anyone who may record service, caretakers
   * included, while the notice is live and its PDF is frozen (decision 6).
   */
  handover: z.boolean(),
});

/**
 * The latest approval request the notice had, kept once it closes and after the notice returns to
 * draft. `decidedAt` is when it closed (approved, rejected, cancelled or expired), and
 * `decidedByName` who decided it: null while it is open, and for an expiry or a cancellation.
 */
export const noticeLastApprovalSchema = z.object({
  id: uuid,
  actionType: z.enum(['notice.issue', 'notice.issue_quit']),
  status: z.enum(['pending', 'cooling_off', 'approved', 'rejected', 'cancelled', 'expired']),
  decidedAt: iso.nullable(),
  decidedByName: z.string().nullable(),
});

/**
 * Why a draft is a draft again. `code` is a blocker's domain code (`notice.effective_date_too_early`,
 * `notice.quit_barred`, …) when an approved notice could not be issued, or `approval.rejected`,
 * `approval.expired`, `approval.cancelled` or `notice.taken_back` (staff returned it). Null unless the
 * notice is a draft that was returned.
 */
export const noticeReturnedReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
  at: iso,
});

export const noticeDetailSchema = noticeListRowSchema.extend({
  /** The type's fields (NOTICE_FIELD_SCHEMAS in packages/domain/notices), frozen at issue. */
  fields: z.record(z.string(), z.unknown()),
  blockIds: z.array(uuid),
  issueDate: isoDate.nullable(),
  earliestLawfulDate: isoDate.nullable(),
  earliest: earliestDateSchema.nullable(),
  /** The lease had the electronic-service clause and a channel served on it. */
  electronicService: z.boolean().nullable(),
  ruleVersions: z.array(noticeRuleUsedSchema),
  warnings: z.array(noticeWarningSchema),
  /** For a draft: why issue would be refused today. Empty once issued. */
  blockers: z.array(noticeBlockerSchema),
  quitBar: quitBarSchema.nullable(),
  servedTooLateDetail: z
    .object({ earliestFromService: isoDate, shortByDays: z.number().int(), reason: z.string() })
    .nullable(),
  template: z.object({
    key: z.string(),
    version: z.number().int(),
    /** Decision 1: whether counsel has reviewed this version's wording. */
    counselReviewed: z.boolean(),
  }),
  document: z.object({
    /** SHA-256 of the frozen PDF, once rendered. */
    sha256: z.string().nullable(),
    /** SHA-256 of the signed acknowledgement with its certificate page (LN-04). */
    signedSha256: z.string().nullable(),
    servicePackReady: z.boolean(),
  }),
  ladder: z.object({
    paused: z.boolean(),
    cancelled: z.boolean(),
    reason: z.string().nullable(),
    changedAt: iso.nullable(),
    changedByName: z.string().nullable(),
    steps: z.array(ladderStepSchema.extend({ dueAt: iso.nullable(), runsAt: iso.nullable() })),
  }),
  linkExpiresAt: iso.nullable(),
  completion: z.enum(['any_one', 'each']),
  /**
   * The approval request the notice waits on, or was issued under, in full. Null for a draft,
   * including one returned to draft: `lastApproval` keeps the last request's outcome.
   */
  approval: approvalSchema.nullable(),
  lastApproval: noticeLastApprovalSchema.nullable(),
  returnedReason: noticeReturnedReasonSchema.nullable(),
  corrects: z.object({ id: uuid, number: z.string().nullable() }).nullable(),
  correctedBy: z.object({ id: uuid, number: z.string().nullable() }).nullable(),
  closeNote: z.string().nullable(),
  closedAt: iso.nullable(),
  closedByName: z.string().nullable(),
  createdByName: z.string().nullable(),
  recipients: z.array(noticeRecipientSchema),
  events: z.array(noticeEventSchema),
  serviceRecords: z.array(serviceRecordSchema),
  tasks: z.array(taskSchema),
  actions: noticeActionsSchema,
});
export type NoticeDetail = z.infer<typeof noticeDetailSchema>;

/** A type as the composer offers it (plan 4.2), with the company's ladder for it. */
export const noticeTypeInfoSchema = z.object({
  type: z.enum(NOTICE_TYPES),
  label: z.string(),
  subtypes: z.array(z.object({ value: z.enum(ALL_SUBTYPES), label: z.string() })),
  subtypeFieldLabel: z.string().nullable(),
  requiredFields: z.array(z.string()),
  fieldLabels: z.record(z.string(), z.string()),
  period: z.enum([
    'none',
    'contractual',
    'contractual_or_statutory',
    'contractual_before_lease_end',
    'not_recorded',
    'recorded_only',
  ]),
  hasPeriod: z.boolean(),
  ladderKind: z.enum(['full', 'reminders_only', 'none']),
  ladder: z.array(ladderStepSchema),
  postOnPremises: z.boolean(),
  twoPersonApproval: z.boolean(),
  needsLease: z.boolean(),
  issuable: z.boolean(),
  template: z.object({ key: z.string(), version: z.number().int(), counselReviewed: z.boolean() }),
});

export const noticeTypesSchema = z.object({
  types: z.array(noticeTypeInfoSchema),
  /** OQ-16: notices to quit are enabled for the company. */
  quitEnabled: z.boolean(),
  /** Decision 14: whether the company's plan includes notices. */
  onPlan: z.boolean(),
  timeZone: z.string(),
  sendWindow: z.object({ from: z.string(), to: z.string() }),
  linkExpiryDays: z.number().int(),
});

const composeTarget = {
  type: z.enum(NOTICE_TYPES),
  subtype: z.enum(ALL_SUBTYPES).nullable().optional(),
  /** Every type but building-wide is served under a lease. */
  leaseId: uuid.nullable().optional(),
  /** Building-wide: the property, and optionally some of its blocks. */
  propertyId: uuid.nullable().optional(),
  blockIds: z.array(uuid).max(100).optional(),
};

/** What the composer shows for a draft or a planned notice (LN-01; plan 4.3). */
export const noticeComposeSchema = z.object({
  /** Facts the composer fills from the lease and the ledger. */
  prefill: z.object({
    tenant: named.nullable(),
    property: named,
    unit: z.object({ id: uuid, code: z.string() }).nullable(),
    lease: z
      .object({
        id: uuid,
        use: z.enum(LEASE_USES),
        status: z.string(),
        startDate: isoDate,
        endDate: isoDate,
        noticeDays: z.number().int(),
        monthlyRentMinor: z.number().int(),
        /** The lease names at least one phone or email for electronic service. */
        electronicServiceClause: z.boolean(),
      })
      .nullable(),
    /** From the ledger (LN-01): what is overdue today, and the invoices it covers. */
    arrears: z
      .object({
        amountMinor: z.number().int(),
        asOf: isoDate,
        invoices: z.array(
          z.object({
            id: uuid,
            number: z.string().nullable(),
            dueDate: isoDate,
            outstandingMinor: z.number().int(),
          }),
        ),
      })
      .nullable(),
    /** Fields the composer suggests for this type, from the facts above. */
    suggestedFields: z.record(z.string(), z.unknown()),
  }),
  recipients: z.array(
    z.object({
      kind: z.enum(NOTICE_RECIPIENT_KINDS),
      name: z.string(),
      partyTenantId: uuid,
      unitCode: z.string().nullable(),
      channels: z.array(noticeChannelPlanSchema),
      physicalServicePlanned: z.boolean(),
    }),
  ),
  plannedIssueDate: isoDate,
  earliest: earliestDateSchema.nullable(),
  effectiveCheck: z
    .object({ ok: z.boolean(), shortByDays: z.number().int(), reason: z.string().nullable() })
    .nullable(),
  warnings: z.array(noticeWarningSchema),
  blockers: z.array(noticeBlockerSchema),
  quitBar: quitBarSchema.nullable(),
  /** Field problems, field by field; empty when the fields are complete and valid. */
  fieldErrors: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })),
  template: z.object({ key: z.string(), version: z.number().int(), counselReviewed: z.boolean() }),
});
export type NoticeCompose = z.infer<typeof noticeComposeSchema>;

const NOTICE_FILES = [
  'notice',
  'signed',
  'service_pack',
  'service_photo',
  'affidavit',
  'received',
] as const;

export const noticesContract = {
  types: oc
    .route({
      method: 'GET',
      path: '/notices/types',
      summary: 'Notice types with their fields, periods and the company’s ladder (LN-01)',
    })
    .output(noticeTypesSchema),
  list: oc
    .route({ method: 'GET', path: '/notices', summary: 'The notices dashboard (LN-09)' })
    .input(
      z.object({
        status: z.enum(NOTICE_STATUSES).optional(),
        /** Open: issued and not closed. */
        open: flag,
        type: z.enum(NOTICE_TYPES).optional(),
        propertyId: uuid.optional(),
        tenantId: uuid.optional(),
        leaseId: uuid.optional(),
        outcome: z.enum(NOTICE_OUTCOMES).optional(),
        servedTooLate: flag,
        search: z.string().max(80).optional(),
      }),
    )
    .output(z.array(noticeListRowSchema)),
  summary: oc
    .route({
      method: 'GET',
      path: '/notices/summary',
      summary: 'Open notices by status and by days outstanding (LN-09)',
    })
    .output(
      z.object({
        byStatus: z.array(z.object({ status: z.enum(NOTICE_STATUSES), count: z.number().int() })),
        /** Open notices by days since issue: 0-7, 8-14, 15-30, over 30. */
        byAge: z.array(
          z.object({
            bucket: z.enum(['0_7', '8_14', '15_30', 'over_30']),
            count: z.number().int(),
          }),
        ),
        servedTooLate: z.number().int(),
        drafts: z.number().int(),
        awaitingApproval: z.number().int(),
      }),
    ),
  get: oc
    .route({ method: 'GET', path: '/notices/{noticeId}' })
    .input(z.object({ noticeId: uuid }))
    .output(noticeDetailSchema),
  compose: oc
    .route({
      method: 'POST',
      path: '/notices/compose',
      summary:
        'Check a planned notice without saving it: prefilled facts, recipients and channels, the earliest lawful date, warnings and blockers (LN-01)',
    })
    .input(
      z.object({
        ...composeTarget,
        fields: z.record(z.string(), z.unknown()).optional(),
        /** Defaults to today, company time. */
        plannedIssueDate: isoDate.optional(),
      }),
    )
    .output(noticeComposeSchema),
  create: oc
    .route({ method: 'POST', path: '/notices', summary: 'A draft notice (LN-01)' })
    .input(
      z.object({
        ...composeTarget,
        fields: z.record(z.string(), z.unknown()),
        /** Plan 4.8: start this draft as the correction of an issued notice (see `correct`). */
        correctsNoticeId: uuid.nullable().optional(),
      }),
    )
    .output(noticeDetailSchema),
  update: oc
    .route({ method: 'PATCH', path: '/notices/{noticeId}', summary: 'Change a draft' })
    .input(
      z.object({
        noticeId: uuid,
        subtype: z.enum(ALL_SUBTYPES).nullable().optional(),
        blockIds: z.array(uuid).max(100).optional(),
        fields: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .output(noticeDetailSchema),
  preview: oc
    .route({
      method: 'GET',
      path: '/notices/{noticeId}/preview',
      summary: 'The notice as its PDF will read, as HTML (no scripts, no styles)',
    })
    .input(z.object({ noticeId: uuid }))
    .output(z.object({ html: z.string(), counselReviewed: z.boolean() })),
  discard: oc
    .route({ method: 'POST', path: '/notices/{noticeId}/discard', summary: 'Discard a draft' })
    .input(z.object({ noticeId: uuid }))
    .output(noticeDetailSchema),
  submit: oc
    .route({
      method: 'POST',
      path: '/notices/{noticeId}/submit',
      summary:
        'Send a draft for approval: one person with notice authority, or two for a notice to quit (decision 8)',
    })
    .input(z.object({ noticeId: uuid }))
    .output(noticeDetailSchema),
  returnToDraft: oc
    .route({
      method: 'POST',
      path: '/notices/{noticeId}/return-to-draft',
      summary: 'Take a notice back from approval to change it; its approval request is cancelled',
    })
    .input(z.object({ noticeId: uuid }))
    .output(noticeDetailSchema),
  issue: oc
    .route({
      method: 'POST',
      path: '/notices/{noticeId}/issue',
      summary:
        'Issue a draft (or an approved notice) now: the date and the s.23 bar are checked again, the number taken and the PDF frozen. Not for a notice to quit, which issues on its approval',
    })
    .input(z.object({ noticeId: uuid }))
    .output(noticeDetailSchema),
  ladder: oc
    .route({
      method: 'POST',
      path: '/notices/{noticeId}/ladder',
      summary: 'Pause, resume or cancel the reminder ladder, with a reason (LN-05)',
    })
    .input(
      z.object({
        noticeId: uuid,
        action: z.enum(['pause', 'resume', 'cancel']),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .output(noticeDetailSchema),
  recordService: oc
    .route({
      method: 'POST',
      path: '/notices/{noticeId}/service-records',
      summary:
        'Record physical service: how, when and by whom; a correction is a new record that references the old one (LN-05). Requires an Idempotency-Key',
    })
    .input(
      z.object({
        noticeId: uuid,
        method: z.enum(SERVICE_METHODS),
        servedAt: iso,
        /** Who served it: a staff member, or a name typed for someone else. */
        servedByPersonId: uuid.nullable().optional(),
        servedByName: z.string().trim().min(2).max(120).nullable().optional(),
        witnessName: optionalText(120),
        /** The recipient served, or none for the premises as a whole. */
        recipientId: uuid.nullable().optional(),
        notes: optionalText(2000),
        photoUploadId: uuid.nullable().optional(),
        affidavitUploadId: uuid.nullable().optional(),
        correctsRecordId: uuid.nullable().optional(),
      }),
    )
    .output(noticeDetailSchema),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/notice-uploads',
      summary:
        'Upload a photo of a posted notice, a sworn affidavit, a tenant’s own notice or a Rent Officer assessment',
    })
    .input(
      z.object({
        purpose: z.enum(['service_photo', 'affidavit', 'received_notice', 'rent_assessment']),
        contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
        sizeBytes: z.number().int().min(1).max(20_000_000),
      }),
    )
    .output(presignedUpload),
  close: oc
    .route({
      method: 'POST',
      path: '/notices/{noticeId}/close',
      summary:
        'Close with an outcome and a note (decision 12). Nothing ends the lease or touches the unit',
    })
    .input(
      z.object({
        noticeId: uuid,
        outcome: z.enum(STAFF_NOTICE_OUTCOMES),
        note: z.string().trim().min(3).max(2000),
      }),
    )
    .output(noticeDetailSchema),
  correct: oc
    .route({
      method: 'POST',
      path: '/notices/{noticeId}/correct',
      summary:
        'Start a correction: a new draft that references this notice. Issuing it closes this one as superseded (plan 4.8). One open correction per notice: another is refused with 409 NOTICE_CORRECTION_OPEN, so a retry never makes two. An Idempotency-Key is optional; with one, a retry gets the first answer back',
    })
    .input(z.object({ noticeId: uuid }))
    .output(noticeDetailSchema),
  handoverLink: oc
    .route({
      method: 'POST',
      path: '/notices/{noticeId}/recipients/{recipientId}/link',
      summary:
        'A signing link to show as a QR code or copy; earlier links keep working (decision 6)',
    })
    .input(z.object({ noticeId: uuid, recipientId: uuid }))
    .output(z.object({ url: z.string().url(), expiresAt: iso })),
  download: oc
    .route({
      method: 'GET',
      path: '/notices/{noticeId}/files/{which}',
      summary:
        'A short-lived link to the frozen notice, the signed acknowledgement, the service pack, or a service record’s photo or affidavit',
    })
    .input(z.object({ noticeId: uuid, which: z.enum(NOTICE_FILES), recordId: uuid.optional() }))
    .output(download),
  recordReceived: oc
    .route({
      method: 'POST',
      path: '/notices/received',
      summary:
        'Record a notice the tenant gave: an intention to vacate or a formal complaint (decision 13). Requires an Idempotency-Key',
    })
    .input(
      z.object({
        leaseId: uuid,
        subtype: z.enum(['intention_to_vacate', 'complaint']),
        receivedOn: isoDate,
        receivedVia: z.enum(RECEIVED_VIA),
        uploadId: uuid,
        details: optionalText(2000),
      }),
    )
    .output(noticeDetailSchema),
};

// OQ-16 (decision 9) ------------------------------------------------------------------------------

export const quitAcknowledgementSchema = z.object({
  /** Notices to quit are enabled for the company. */
  enabled: z.boolean(),
  /** The statement to accept now. */
  statement: z.object({ version: z.string(), text: z.string(), sha256: z.string() }),
  current: z
    .object({
      byName: z.string(),
      typedName: z.string(),
      at: iso,
      statementVersion: z.string(),
    })
    .nullable(),
  history: z.array(
    z.object({
      action: z.enum(['grant', 'withdraw']),
      byName: z.string(),
      at: iso,
      statementVersion: z.string(),
      reason: z.string().nullable(),
    }),
  ),
  /** Whether the reader may accept or withdraw it (agency admins and landlords). */
  mayChange: z.boolean(),
});

export const quitAcknowledgementContract = {
  get: oc
    .route({ method: 'GET', path: '/company/quit-acknowledgement' })
    .output(quitAcknowledgementSchema),
  grant: oc
    .route({
      method: 'POST',
      path: '/company/quit-acknowledgement',
      summary: 'Accept the risk statement by typing your name; enables notices to quit (OQ-16)',
    })
    .input(
      z.object({
        statementVersion: z.string().max(40),
        typedName: z.string().trim().min(2).max(120),
      }),
    )
    .output(quitAcknowledgementSchema),
  withdraw: oc
    .route({
      method: 'POST',
      path: '/company/quit-acknowledgement/withdraw',
      summary: 'Turn notices to quit off again; notices already issued carry on',
    })
    .input(z.object({ reason: z.string().trim().min(3).max(500) }))
    .output(quitAcknowledgementSchema),
};

// Rent Officer assessments (decision 3) -----------------------------------------------------------

/**
 * One Rent Officer assessment record. Records are append-only: a correction is a new record that
 * replaces an earlier one, with a reason, and a void cancels one, with a reason. Only `active`
 * records count towards the s.23 bar.
 */
export const rentAssessmentSchema = z.object({
  id: uuid,
  unitId: uuid,
  assessedOn: isoDate,
  reference: z.string(),
  hasDocument: z.boolean(),
  recordedByName: z.string().nullable(),
  recordedAt: iso,
  /** `active`, `corrected` (a later record replaces it) or `voided`. */
  status: z.enum(['active', 'corrected', 'voided']),
  /** The record this one corrects, and why. */
  replacesId: uuid.nullable(),
  reason: z.string().nullable(),
  /** The record that corrects this one. */
  replacedById: uuid.nullable(),
  voided: z.object({ at: iso, byName: z.string().nullable(), reason: z.string() }).nullable(),
});

const assessmentRecordInput = {
  unitId: uuid,
  /** Never in the future (company date). */
  assessedOn: isoDate,
  reference: z.string().trim().min(1).max(120),
  uploadId: uuid.nullable().optional(),
};

export const rentAssessmentsContract = {
  list: oc
    .route({ method: 'GET', path: '/units/{unitId}/rent-assessments' })
    .input(z.object({ unitId: uuid }))
    .output(
      z.object({
        assessments: z.array(rentAssessmentSchema),
        /**
         * The s.23 bar from the latest active assessment, with its rule's status (shown as a
         * warning). `barredUntil` is the last barred day; `active` is true while today (company
         * date) is on or before it. Null with no active assessment, or with no bar rule in force
         * (`ruleMissing`).
         */
        bar: z
          .object({
            barredUntil: isoDate,
            months: z.number().int(),
            ruleStatus,
            active: z.boolean(),
          })
          .nullable(),
        /** An active assessment is on record but no bar rule is in force: shown as a warning. */
        ruleMissing: z.boolean(),
      }),
    ),
  record: oc
    .route({
      method: 'POST',
      path: '/units/{unitId}/rent-assessments',
      summary:
        'Record a Rent Officer assessment of the unit; records are never edited. Requires an Idempotency-Key',
    })
    .input(z.object(assessmentRecordInput))
    .output(rentAssessmentSchema),
  correct: oc
    .route({
      method: 'POST',
      path: '/units/{unitId}/rent-assessments/{assessmentId}/correct',
      summary:
        'Correct an active assessment with a new record that replaces it, with a reason. Requires an Idempotency-Key',
    })
    .input(
      z.object({
        ...assessmentRecordInput,
        assessmentId: uuid,
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .output(rentAssessmentSchema),
  void: oc
    .route({
      method: 'POST',
      path: '/units/{unitId}/rent-assessments/{assessmentId}/void',
      summary:
        'Void an active assessment recorded in error, with a reason; it stays listed. Requires an Idempotency-Key',
    })
    .input(
      z.object({ unitId: uuid, assessmentId: uuid, reason: z.string().trim().min(3).max(500) }),
    )
    .output(rentAssessmentSchema),
  download: oc
    .route({ method: 'GET', path: '/units/{unitId}/rent-assessments/{assessmentId}/document' })
    .input(z.object({ unitId: uuid, assessmentId: uuid }))
    .output(download),
};

// Tasks (CF-06) -----------------------------------------------------------------------------------

export const tasksContract = {
  list: oc
    .route({ method: 'GET', path: '/tasks', summary: 'Tasks: mine, or all in my scope (CF-06)' })
    .input(
      z.object({
        mine: flag,
        status: z.enum(TASK_STATUSES).optional(),
        kind: z.enum(TASK_KINDS).optional(),
        propertyId: uuid.optional(),
      }),
    )
    .output(z.array(taskSchema)),
  get: oc
    .route({ method: 'GET', path: '/tasks/{taskId}' })
    .input(z.object({ taskId: uuid }))
    .output(taskSchema),
  complete: oc
    .route({ method: 'POST', path: '/tasks/{taskId}/complete', summary: 'Mark a task done' })
    .input(z.object({ taskId: uuid, note: optionalText(2000) }))
    .output(taskSchema),
  note: oc
    .route({ method: 'POST', path: '/tasks/{taskId}/note', summary: 'Add or change a task’s note' })
    .input(z.object({ taskId: uuid, note: z.string().trim().min(2).max(2000) }))
    .output(taskSchema),
  cancel: oc
    .route({ method: 'POST', path: '/tasks/{taskId}/cancel', summary: 'Cancel an open task' })
    .input(z.object({ taskId: uuid, note: z.string().trim().min(2).max(2000) }))
    .output(taskSchema),
};

// Notice settings are company settings (company.ts): `noticeLadders`, `noticeSendWindow` and
// `noticeLinkExpiryDays`. The ladder types they may name:
export const NOTICE_LADDER_TYPES = LADDER_NOTICE_TYPES;
