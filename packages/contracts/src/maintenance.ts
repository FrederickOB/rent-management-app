import { oc } from '@orpc/contract';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_PAID_BY,
  EXPENSE_STATUSES,
  INSPECTION_CONDITIONS,
  INSPECTION_KINDS,
  INSPECTION_STATUSES,
  MAINTENANCE_ATTACHMENT_KINDS,
  MAINTENANCE_ATTACHMENT_STAGES,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_JOB_STATUSES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_SLA_STAGES,
  MAINTENANCE_SOURCES,
  MAINTENANCE_TARGET_KINDS,
} from '@rent/domain/maintenance';
import { UNIT_TYPES } from '@rent/domain/portfolio';
import { TASK_KINDS, TASK_STATUSES } from '@rent/domain/tasks';
import { z } from 'zod';

/**
 * Maintenance, inspections and expenses (MI-01 to MI-04, MI-06, MI-10, CM-04, AC-03; M8 plan 4.1
 * to 4.12). The board, artisans and their job sheets, routine inspections and emergency alerts are
 * Growth only (decision 1): a Starter company is refused with 403 `NOT_ON_PLAN`, and a repair from
 * its tenants' app is logged on the timeline and forwarded. Move-in and move-out inspections, the
 * move-in report and expenses are on every plan. Amounts are integer pesewas in `*Minor` fields;
 * business dates are `YYYY-MM-DD`, company time; instants are UTC. Writes that create records
 * accept an `Idempotency-Key`; money writes (expenses) require one.
 */
const SIGNER_STATUSES = ['pending', 'signed', 'declined'] as const;
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const minor = z.number().int();
const positiveMinor = z.number().int().positive().max(100_000_000_000);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const named = z.object({ id: uuid, name: z.string() });
const download = z.object({ url: z.string(), expiresAt: iso });
const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});

/**
 * An upload asked for (decision 2): the type and size as the file says, and the length of a video
 * or voice note in seconds. The bytes are checked again from their first bytes when the upload is
 * used: a renamed file is refused (400 `MEDIA_TYPE_MISMATCH`).
 */
export const mediaUploadInputSchema = z.object({
  contentType: z.string().max(100),
  sizeBytes: z.number().int().min(1).max(50_000_000),
  /** Video and audio only: at most 90 s and 180 s. */
  durationSeconds: z.number().positive().max(3600).nullable().optional(),
});

// Jobs ----------------------------------------------------------------------------------------

export const maintenanceAssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('staff'), personId: uuid, name: z.string() }),
  z.object({
    kind: z.literal('artisan'),
    artisanId: uuid,
    name: z.string(),
    /** Accepted or declined on the job sheet; null while waiting. */
    response: z.enum(['accepted', 'declined']).nullable(),
  }),
]);

export const maintenanceTargetsViewSchema = z.object({
  respondBy: iso,
  completeBy: iso,
  /** First assigned or attended. */
  respondedAt: iso.nullable(),
  workDoneAt: iso.nullable(),
  /** The first target now missed, if any. */
  overdue: z.enum(MAINTENANCE_TARGET_KINDS).nullable(),
});

export const maintenanceJobSchema = z.object({
  id: uuid,
  /** `MT-0042`: per company, from 1. */
  ticket: z.string(),
  ticketNumber: z.number().int(),
  status: z.enum(MAINTENANCE_JOB_STATUSES),
  statusLabel: z.string(),
  source: z.enum(MAINTENANCE_SOURCES),
  description: z.string(),
  property: named,
  unit: z.object({ id: uuid, code: z.string() }).nullable(),
  tenant: named.nullable(),
  leaseId: uuid.nullable(),
  /** The conversation it came from, to open the thread. */
  conversationId: uuid.nullable(),
  attachmentCount: z.number().int(),
  createdAt: iso,
  // M8 -------------------------------------------------------------------------------------
  /** Null until triaged; an emergency the tenant flagged is `emergency` at once (decision 5). */
  priority: z.enum(MAINTENANCE_PRIORITIES).nullable(),
  category: z.enum(MAINTENANCE_CATEGORIES).nullable(),
  /** The tenant said it is an emergency (decision 5). */
  emergencyFlag: z.boolean(),
  assignee: maintenanceAssigneeSchema.nullable(),
  /** Null until triaged. */
  targets: maintenanceTargetsViewSchema.nullable(),
  /** A visit planned with the tenant. */
  visitAt: iso.nullable(),
  /** The sum of the job's expenses (decision 8), net of reversals. */
  costMinor: minor,
  closedAt: iso.nullable(),
  updatedAt: iso,
});
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;

export const MAINTENANCE_EVENT_KINDS = [
  'reported',
  'triaged',
  'priority_changed',
  'assigned',
  'unassigned',
  'accepted',
  'declined',
  'visit_planned',
  'started',
  'work_done',
  'confirmed',
  'disputed',
  'closed',
  'auto_closed',
  'cancelled',
  'note',
  'media_added',
  'alerted',
  'sla_warned',
  'tenant_updated',
  'expense_linked',
] as const;

export const maintenanceEventSchema = z.object({
  id: uuid,
  kind: z.enum(MAINTENANCE_EVENT_KINDS),
  /** Server time. */
  at: iso,
  /** Staff, the artisan (on the job sheet), the tenant, or the system. */
  actorKind: z.enum(['staff', 'artisan', 'tenant', 'system']),
  actorName: z.string().nullable(),
  /** The note, reason, priority change, assignee or SLA target, as the kind needs. */
  data: z.record(z.string(), z.unknown()).nullable(),
});

export const maintenanceAttachmentSchema = z.object({
  id: uuid,
  kind: z.enum(MAINTENANCE_ATTACHMENT_KINDS),
  stage: z.enum(MAINTENANCE_ATTACHMENT_STAGES),
  contentType: z.string(),
  sizeBytes: z.number().int().nullable(),
  durationSeconds: z.number().nullable(),
  /** Server time it was added. */
  createdAt: iso,
  addedByKind: z.enum(['staff', 'artisan', 'tenant', 'message']),
});

const jobTaskSchema = z.object({
  id: uuid,
  kind: z.enum(TASK_KINDS),
  status: z.enum(TASK_STATUSES),
  assignee: z.object({ personId: uuid, name: z.string() }).nullable(),
  dueAt: iso,
});

export const maintenanceJobDetailSchema = maintenanceJobSchema.extend({
  attachments: z.array(maintenanceAttachmentSchema),
  events: z.array(maintenanceEventSchema),
  tasks: z.array(jobTaskSchema),
  beforePhotoReason: z.string().nullable(),
  completionNote: z.string().nullable(),
  /** The tenant's answer to "work done": confirmed, disputed (with the reason), or none yet. */
  tenantResponse: z
    .object({
      kind: z.enum(['confirmed', 'disputed']),
      reason: z.string().nullable(),
      at: iso,
      via: z.enum(['app', 'whatsapp', 'sms', 'staff']),
    })
    .nullable(),
  /** The job's expenses (decision 8). */
  expenses: z.array(z.lazy(() => expenseRowSchema)),
  /** What the reader may do now; the API checks each again. */
  actions: z.object({
    triage: z.boolean(),
    changePriority: z.boolean(),
    assign: z.boolean(),
    unassign: z.boolean(),
    planVisit: z.boolean(),
    start: z.boolean(),
    complete: z.boolean(),
    /** Record the tenant's confirmation or dispute for them (a job with a tenant). */
    recordResponse: z.boolean(),
    /** Close a job with no tenant once the work is done (staff check it themselves). */
    close: z.boolean(),
    cancel: z.boolean(),
    addMedia: z.boolean(),
    addNote: z.boolean(),
    recordExpense: z.boolean(),
  }),
});
export type MaintenanceJobDetail = z.infer<typeof maintenanceJobDetailSchema>;

const reportInput = z.object({
  propertyId: uuid,
  /** A unit, or none for a common area. */
  unitId: uuid.nullable().optional(),
  description: z.string().trim().min(3).max(2000),
  category: z.enum(MAINTENANCE_CATEGORIES).nullable().optional(),
  priority: z.enum(MAINTENANCE_PRIORITIES).nullable().optional(),
  /** Uploads from POST /maintenance-uploads; at most 10 files (decision 2). */
  uploadIds: z.array(uuid).max(10).default([]),
  /** Logged from an inbox conversation (SMS or email, decision 14). */
  conversationId: uuid.nullable().optional(),
  messageIds: z.array(uuid).max(20).default([]),
});

export const maintenanceContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/maintenance-jobs',
      summary:
        'The maintenance board: jobs newest first, with filters (MI-01 to MI-06). Read-only for accountants, an agency’s client owners and advisers (decision 9)',
    })
    .input(
      z.object({
        propertyId: uuid.optional(),
        tenantId: uuid.optional(),
        status: z.enum(MAINTENANCE_JOB_STATUSES).optional(),
        /** Open jobs only (reported to work done). */
        open: z.stringbool().optional(),
        priority: z.enum(MAINTENANCE_PRIORITIES).optional(),
        category: z.enum(MAINTENANCE_CATEGORIES).optional(),
        /** A target missed and not yet met. */
        overdue: z.stringbool().optional(),
        assigneePersonId: uuid.optional(),
        artisanId: uuid.optional(),
        search: z.string().trim().max(100).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
    )
    .output(z.object({ items: z.array(maintenanceJobSchema), nextCursor: z.string().nullable() })),
  get: oc
    .route({ method: 'GET', path: '/maintenance-jobs/{jobId}' })
    .input(z.object({ jobId: uuid }))
    .output(maintenanceJobDetailSchema),
  attachmentDownload: oc
    .route({
      method: 'GET',
      path: '/maintenance-jobs/{jobId}/attachments/{attachmentId}/download',
      summary: 'A short-lived link to a repair photo, video or voice note, after a policy check',
    })
    .input(z.object({ jobId: uuid, attachmentId: uuid }))
    .output(download),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/maintenance-uploads',
      summary:
        'Upload a photo (JPEG, PNG, WebP; 10 MB), a video (MP4, MOV, 3GP; 50 MB, 90 s) or a voice note (M4A, AAC, MP3, OGG, AMR; 10 MB, 3 min) for a job (decision 2)',
    })
    .input(mediaUploadInputSchema)
    .output(presignedUpload),
  report: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs',
      summary:
        'Log a repair for a unit or a common area (staff and caretakers; CM-04). An emergency alerts the property’s managers and caretakers at once (decision 5). Send an Idempotency-Key: a retry with it returns the first job, never a second job or a second alert. `messageIds` must be messages of `conversationId` (400 MESSAGES_NOT_IN_CONVERSATION); the job’s tenant is the conversation’s',
    })
    .input(reportInput)
    .output(maintenanceJobDetailSchema),
  triage: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/triage',
      summary: 'Set the priority and category (Reported → Triaged)',
    })
    .input(
      z.object({
        jobId: uuid,
        priority: z.enum(MAINTENANCE_PRIORITIES),
        category: z.enum(MAINTENANCE_CATEGORIES),
        note: optionalText(2000),
      }),
    )
    .output(maintenanceJobDetailSchema),
  changePriority: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/priority',
      summary:
        'Change an open job’s priority, with a reason (audited). Raising it to emergency alerts at once',
    })
    .input(
      z.object({
        jobId: uuid,
        priority: z.enum(MAINTENANCE_PRIORITIES),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .output(maintenanceJobDetailSchema),
  assign: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/assign',
      summary:
        'Assign to a staff member (a task) or an artisan (a job sheet by WhatsApp or SMS link); Triaged → Assigned, or a reassignment (MI-04)',
    })
    .input(
      z.object({
        jobId: uuid,
        assignee: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('staff'), personId: uuid }),
          z.object({ kind: z.literal('artisan'), artisanId: uuid }),
        ]),
        dueAt: iso.nullable().optional(),
        note: optionalText(2000),
      }),
    )
    .output(maintenanceJobDetailSchema),
  unassign: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/unassign',
      summary: 'Take the job back (Assigned → Triaged); the artisan’s job sheet stops working',
    })
    .input(z.object({ jobId: uuid, reason: z.string().trim().min(3).max(500) }))
    .output(maintenanceJobDetailSchema),
  planVisit: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/visit',
      summary: 'Plan a visit with the tenant; the tenant is told on their channel (CM-04)',
    })
    .input(z.object({ jobId: uuid, visitAt: iso, note: optionalText(500) }))
    .output(maintenanceJobDetailSchema),
  start: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/start',
      summary:
        'Work started (Assigned → In progress): a before photo, or a reason for none (MI-06, decision 7)',
    })
    .input(
      z.object({
        jobId: uuid,
        uploadIds: z.array(uuid).max(10).default([]),
        beforePhotoReason: optionalText(500),
      }),
    )
    .output(maintenanceJobDetailSchema),
  complete: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/complete',
      summary:
        'Work done (In progress → Work done): at least one after photo and a completion note, enforced by the API and the database (MI-06). The tenant is asked to confirm',
    })
    .input(
      z.object({
        jobId: uuid,
        uploadIds: z.array(uuid).max(10).default([]),
        completionNote: z.string().trim().min(3).max(2000),
      }),
    )
    .output(maintenanceJobDetailSchema),
  recordResponse: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/tenant-response',
      summary:
        'Record the tenant’s answer for them: confirmed (Work done → Closed) or disputed with the reason (→ In progress). A job with no tenant has nobody to confirm: 409 NO_TENANT (close it instead)',
    })
    .input(
      z.object({
        jobId: uuid,
        response: z.enum(['confirmed', 'disputed']),
        reason: optionalText(1000),
      }),
    )
    .output(maintenanceJobDetailSchema),
  close: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/close',
      summary:
        'Close a job with no tenant (a common area or an empty unit) once the work is done (Work done → Closed, by staff). A job with a tenant closes on their answer or after the auto-close days: 409 TENANT_CONFIRMS',
    })
    .input(z.object({ jobId: uuid, note: optionalText(1000) }))
    .output(maintenanceJobDetailSchema),
  cancel: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/cancel',
      summary: 'Cancel a reported or triaged job (a duplicate, or not needed), with the reason',
    })
    .input(z.object({ jobId: uuid, reason: z.string().trim().min(3).max(500) }))
    .output(maintenanceJobDetailSchema),
  addMedia: oc
    .route({
      method: 'POST',
      path: '/maintenance-jobs/{jobId}/media',
      summary: 'Add photos, videos or voice notes to a job, marked before, after or other',
    })
    .input(
      z.object({
        jobId: uuid,
        stage: z.enum(MAINTENANCE_ATTACHMENT_STAGES),
        uploadIds: z.array(uuid).min(1).max(10),
      }),
    )
    .output(maintenanceJobDetailSchema),
  addNote: oc
    .route({ method: 'POST', path: '/maintenance-jobs/{jobId}/notes', summary: 'Add a note' })
    .input(z.object({ jobId: uuid, note: z.string().trim().min(2).max(2000) }))
    .output(maintenanceJobDetailSchema),
};

// Artisans (decision 6) -------------------------------------------------------------------------

export const artisanSchema = z.object({
  id: uuid,
  name: z.string(),
  /** E.164, masked for every reader but the people who manage artisans. */
  phoneMasked: z.string(),
  trades: z.array(z.enum(MAINTENANCE_CATEGORIES)),
  consent: z.object({ whatsapp: z.boolean(), sms: z.boolean() }),
  archivedAt: iso.nullable(),
  openJobs: z.number().int(),
  createdAt: iso,
});
export type ArtisanView = z.infer<typeof artisanSchema>;

export const artisansContract = {
  list: oc
    .route({ method: 'GET', path: '/artisans', summary: 'Artisans the company sends work to' })
    .input(
      z.object({
        archived: z.stringbool().optional(),
        trade: z.enum(MAINTENANCE_CATEGORIES).optional(),
      }),
    )
    .output(z.array(artisanSchema)),
  create: oc
    .route({
      method: 'POST',
      path: '/artisans',
      summary:
        'Add an artisan: name, phone, trades and the channels they agreed to be contacted on. No rates, ratings or payment details (MI-09)',
    })
    .input(
      z.object({
        name: z.string().trim().min(2).max(120),
        phone: z.string().trim().min(7).max(20),
        trades: z.array(z.enum(MAINTENANCE_CATEGORIES)).min(1).max(11),
        consent: z.object({ whatsapp: z.boolean(), sms: z.boolean() }),
      }),
    )
    .output(artisanSchema),
  update: oc
    .route({ method: 'PATCH', path: '/artisans/{artisanId}' })
    .input(
      z.object({
        artisanId: uuid,
        name: z.string().trim().min(2).max(120).optional(),
        trades: z.array(z.enum(MAINTENANCE_CATEGORIES)).min(1).max(11).optional(),
        /** Each change is a new consent record. */
        consent: z.object({ whatsapp: z.boolean(), sms: z.boolean() }).optional(),
      }),
    )
    .output(artisanSchema),
  archive: oc
    .route({
      method: 'POST',
      path: '/artisans/{artisanId}/archive',
      summary:
        'Archive an artisan; never deleted. Open job sheets keep working until the job closes',
    })
    .input(z.object({ artisanId: uuid }))
    .output(artisanSchema),
};

// The artisan's job sheet (decision 6; apps/links /j/[token]) ----------------------------------

const sheetInput = z.object({
  token: z.string().max(64),
  client: z
    .object({ ip: z.string().trim().min(1).max(64), userAgent: z.string().max(500) })
    .strict(),
});

/**
 * What the job sheet shows (decision 6, widened by F1): the unit, the description, the tenant's
 * photos and videos from the report, and the property contact's phone. Never a voice note, a before
 * or after file, a staff file, the tenant's own phone number or anything else about them.
 *
 * A dead link (`closed`, `expired` or `revoked`) shows only the closed screen's facts: the ticket,
 * status, property name, unit and artisan. Its `description`, `property.address`, `contact` and
 * `visitAt` are null, `attachments` is empty, `code` is null and no action is offered. Its files
 * are refused (404).
 */
export const jobSheetSchema = z.object({
  /** `sheet` accepts actions; the rest explain. */
  screen: z.enum(['sheet', 'done', 'closed', 'expired', 'revoked']),
  ticket: z.string(),
  status: z.enum(MAINTENANCE_JOB_STATUSES),
  /** Null on a dead link. */
  description: z.string().nullable(),
  category: z.enum(MAINTENANCE_CATEGORIES).nullable(),
  priority: z.enum(MAINTENANCE_PRIORITIES).nullable(),
  /** `address` is null on a dead link. */
  property: z.object({ name: z.string(), address: z.string().nullable() }),
  unitCode: z.string().nullable(),
  /** Who to call about the job: the property's contact, never the tenant. Null on a dead link. */
  contact: z.object({ name: z.string(), phone: z.string().nullable() }).nullable(),
  artisan: z.object({ name: z.string(), response: z.enum(['accepted', 'declined']).nullable() }),
  visitAt: iso.nullable(),
  /**
   * F1: the report's photos and videos only. Empty on a dead link. M11 decision 6: `pending` until
   * the malware scan is done (opening it answers 409 DOCUMENT_SCAN_PENDING); an infected file is
   * never listed.
   */
  attachments: z.array(
    z.object({
      id: uuid,
      kind: z.enum(['image', 'video']),
      stage: z.literal('report'),
      contentType: z.string(),
      /** Always sent by the API; optional so a page built before M11 still parses. */
      scan: z.enum(['pending', 'clean']).optional(),
    }),
  ),
  timeZone: z.string(),
  linkExpiresAt: iso,
  /** What the artisan may do now. */
  actions: z.object({
    accept: z.boolean(),
    decline: z.boolean(),
    start: z.boolean(),
    complete: z.boolean(),
  }),
  /** The one-time code for completion (decision 6), as M3's: masked, with its limits. */
  code: z
    .object({
      destinationMasked: z.string(),
      sentAt: iso.nullable(),
      expiresAt: iso.nullable(),
      attemptsLeft: z.number().int(),
      sendsLeft: z.number().int(),
      lockedUntil: iso.nullable(),
    })
    .nullable(),
});
export type JobSheetView = z.infer<typeof jobSheetSchema>;

export const jobSheetContract = {
  open: oc
    .route({
      method: 'POST',
      path: '/job-sheets/open',
      summary: 'Open an artisan’s job sheet by its token (decision 6); records the open',
    })
    .input(sheetInput)
    .output(jobSheetSchema),
  respond: oc
    .route({ method: 'POST', path: '/job-sheets/respond', summary: 'Accept or decline the job' })
    .input(
      sheetInput.extend({
        response: z.enum(['accepted', 'declined']),
        reason: optionalText(500),
      }),
    )
    .output(jobSheetSchema),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/job-sheets/uploads',
      summary: 'Upload a before or after photo, video or voice note, with the job-media limits',
    })
    .input(sheetInput.extend(mediaUploadInputSchema.shape))
    .output(presignedUpload),
  start: oc
    .route({
      method: 'POST',
      path: '/job-sheets/start',
      summary: 'Record the start, with a before photo or a reason for none',
    })
    .input(
      sheetInput.extend({
        uploadIds: z.array(uuid).max(10).default([]),
        beforePhotoReason: optionalText(500),
      }),
    )
    .output(jobSheetSchema),
  sendCode: oc
    .route({
      method: 'POST',
      path: '/job-sheets/code',
      summary: 'Send the artisan a one-time code, to the phone on record only (M3’s rules)',
    })
    .input(sheetInput)
    .output(
      z.object({ destinationMasked: z.string(), expiresAt: iso, sendsLeft: z.number().int() }),
    ),
  complete: oc
    .route({
      method: 'POST',
      path: '/job-sheets/complete',
      summary:
        'Send the completion: after photos, a note and the one-time code (Work done). The link then shows the job as done',
    })
    .input(
      sheetInput.extend({
        code: z.string().max(12),
        uploadIds: z.array(uuid).min(1).max(10),
        completionNote: z.string().trim().min(3).max(2000),
      }),
    )
    .output(jobSheetSchema),
  attachment: oc
    .route({
      method: 'POST',
      path: '/job-sheets/attachment',
      summary:
        'A 5-minute link to one of the photos or videos the sheet lists (F1), from a live link only: a dead link’s files, and any other file, answer 404',
    })
    .input(sheetInput.extend({ attachmentId: uuid }))
    .output(z.object({ url: z.string() })),
};

// Inspections and the move-in report (MI-10, TL-08) ----------------------------------------------

export const inspectionRoomSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(80),
  items: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]{1,40}$/),
        label: z.string().trim().min(1).max(80),
      }),
    )
    .min(1)
    .max(40),
});

export const inspectionTemplateSchema = z.object({
  unitType: z.enum(UNIT_TYPES),
  rooms: z.array(inspectionRoomSchema),
  /** False while the company uses the built-in default (decision 10). */
  customised: z.boolean(),
  updatedAt: iso.nullable(),
});

export const inspectionPhotoSchema = z.object({
  id: uuid,
  contentType: z.string(),
  /** The server's time; the photo's own date is never trusted (decision 10). */
  takenAt: iso,
});

export const inspectionItemSchema = z.object({
  id: uuid,
  roomKey: z.string(),
  roomLabel: z.string(),
  itemKey: z.string(),
  itemLabel: z.string(),
  condition: z.enum(INSPECTION_CONDITIONS).nullable(),
  note: z.string().nullable(),
  photos: z.array(inspectionPhotoSchema),
  /** On a move-out inspection: the move-in result for the same item (plan 4.6). */
  moveIn: z
    .object({
      itemId: uuid,
      condition: z.enum(INSPECTION_CONDITIONS).nullable(),
      note: z.string().nullable(),
      photos: z.array(inspectionPhotoSchema),
    })
    .nullable(),
  /** A move-out item worse than at move-in. */
  worsened: z.boolean(),
});

export const inspectionSchema = z.object({
  id: uuid,
  kind: z.enum(INSPECTION_KINDS),
  status: z.enum(INSPECTION_STATUSES),
  property: named,
  unit: z.object({ id: uuid, code: z.string() }),
  leaseId: uuid.nullable(),
  tenant: named.nullable(),
  performedByName: z.string().nullable(),
  startedAt: iso,
  submittedAt: iso.nullable(),
  /** The inspection this one corrects; a submitted one is never edited (decision 10). */
  corrects: z.object({ id: uuid }).nullable(),
  correctedBy: z.object({ id: uuid }).nullable(),
  /** The move-in inspection a move-out one compares with. */
  moveInInspectionId: uuid.nullable(),
  itemCount: z.number().int(),
  itemsDone: z.number().int(),
});

export const inspectionDetailSchema = inspectionSchema.extend({
  items: z.array(inspectionItemSchema),
  /** On a submitted move-in inspection: its report and signing (TL-08). */
  moveInReport: z.lazy(() => moveInReportSchema).nullable(),
  actions: z.object({
    edit: z.boolean(),
    submit: z.boolean(),
    correct: z.boolean(),
  }),
});

export const moveInReportSchema = z.object({
  inspectionId: uuid,
  leaseId: uuid,
  /** Rendering, out for signature, signed by everyone, or the request was withdrawn. */
  status: z.enum(['rendering', 'pending', 'completed', 'cancelled']),
  /** SHA-256 of the frozen PDF every party signs. */
  sha256: z.string().nullable(),
  /** SHA-256 of the signed PDF with its certificate page. */
  signedSha256: z.string().nullable(),
  signers: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      roleLabel: z.string(),
      status: z.enum(SIGNER_STATUSES),
      signedAt: iso.nullable(),
    }),
  ),
  /** Offered from lease signing until `lateAfterDays` after the start; later it warns (decision 11). */
  late: z.boolean(),
  /** The days after the lease's start within which the report is on time (decision 11: 14). */
  lateAfterDays: z.number().int(),
});
export type MoveInReportView = z.infer<typeof moveInReportSchema>;

export const inspectionsContract = {
  templates: oc
    .route({
      method: 'GET',
      path: '/inspection-templates',
      summary: 'The checklist for each unit type: the company’s own copy, or the default',
    })
    .output(z.array(inspectionTemplateSchema)),
  updateTemplate: oc
    .route({
      method: 'PUT',
      path: '/inspection-templates/{unitType}',
      summary: 'Change the company’s checklist for a unit type (rooms and items)',
    })
    .input(
      z.object({
        unitType: z.enum(UNIT_TYPES),
        rooms: z.array(inspectionRoomSchema).min(1).max(30),
      }),
    )
    .output(inspectionTemplateSchema),
  resetTemplate: oc
    .route({
      method: 'POST',
      path: '/inspection-templates/{unitType}/reset',
      summary: 'Go back to the default checklist for a unit type',
    })
    .input(z.object({ unitType: z.enum(UNIT_TYPES) }))
    .output(inspectionTemplateSchema),
  list: oc
    .route({ method: 'GET', path: '/inspections', summary: 'Inspections, newest first' })
    .input(
      z.object({
        unitId: uuid.optional(),
        leaseId: uuid.optional(),
        propertyId: uuid.optional(),
        kind: z.enum(INSPECTION_KINDS).optional(),
        status: z.enum(INSPECTION_STATUSES).optional(),
      }),
    )
    .output(z.array(inspectionSchema)),
  get: oc
    .route({ method: 'GET', path: '/inspections/{inspectionId}' })
    .input(z.object({ inspectionId: uuid }))
    .output(inspectionDetailSchema),
  start: oc
    .route({
      method: 'POST',
      path: '/inspections',
      summary:
        'Start an inspection from the unit type’s checklist. Move-in and move-out need the lease; a move-out one shows the move-in result beside each item. Routine ones are Growth only (decision 1)',
    })
    .input(
      z.object({
        unitId: uuid,
        kind: z.enum(INSPECTION_KINDS),
        leaseId: uuid.nullable().optional(),
        /** A correction of a submitted inspection: a new one that references it. */
        correctsInspectionId: uuid.nullable().optional(),
      }),
    )
    .output(inspectionDetailSchema),
  updateItem: oc
    .route({
      method: 'PATCH',
      path: '/inspections/{inspectionId}/items/{itemId}',
      summary: 'Record an item’s condition and note (until submitted)',
    })
    .input(
      z.object({
        inspectionId: uuid,
        itemId: uuid,
        condition: z.enum(INSPECTION_CONDITIONS).nullable().optional(),
        note: optionalText(1000),
      }),
    )
    .output(inspectionItemSchema),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/inspection-uploads',
      summary: 'Upload an inspection photo (JPEG, PNG or WebP; 10 MB)',
    })
    .input(mediaUploadInputSchema)
    .output(presignedUpload),
  addPhotos: oc
    .route({
      method: 'POST',
      path: '/inspections/{inspectionId}/items/{itemId}/photos',
      summary: 'Add photos to an item; stamped with the server’s time (until submitted)',
    })
    .input(z.object({ inspectionId: uuid, itemId: uuid, uploadIds: z.array(uuid).min(1).max(10) }))
    .output(inspectionItemSchema),
  submit: oc
    .route({
      method: 'POST',
      path: '/inspections/{inspectionId}/submit',
      summary:
        'Submit: every item needs a condition; the inspection is then frozen. A move-in inspection becomes the move-in report, rendered and sent for signature by every party (TL-08)',
    })
    .input(z.object({ inspectionId: uuid }))
    .output(inspectionDetailSchema),
  photoDownload: oc
    .route({ method: 'GET', path: '/inspections/{inspectionId}/photos/{photoId}/download' })
    .input(z.object({ inspectionId: uuid, photoId: uuid }))
    .output(download),
  moveInReport: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/move-in-report',
      summary: 'The lease’s move-in report and its signing, or 404 when there is none yet',
    })
    .input(z.object({ leaseId: uuid }))
    .output(moveInReportSchema),
  moveInReportDownload: oc
    .route({
      method: 'GET',
      path: '/leases/{leaseId}/move-in-report/download',
      summary: 'A short-lived link to the move-in report: the signed copy once everyone signed',
    })
    .input(z.object({ leaseId: uuid }))
    .output(download),
};

// Expenses (AC-03; decision 8) --------------------------------------------------------------------

export const expenseRowSchema = z.object({
  id: uuid,
  category: z.enum(EXPENSE_CATEGORIES),
  categoryLabel: z.string(),
  supplierName: z.string(),
  amountMinor: minor,
  currency: z.literal('GHS'),
  expenseDate: isoDate,
  paidBy: z.enum(EXPENSE_PAID_BY),
  status: z.enum(EXPENSE_STATUSES),
  property: named,
  unit: z.object({ id: uuid, code: z.string() }).nullable(),
  owner: named,
  job: z.object({ id: uuid, ticket: z.string() }).nullable(),
  hasReceipt: z.boolean(),
  /**
   * F3: receipts are optional. True when the expense has no receipt; the list shows it as
   * "No receipt", and M9 carries it onto the owner statement.
   */
  noReceipt: z.boolean(),
  note: z.string().nullable(),
  paidOn: isoDate.nullable(),
  /** The reversal that cancelled it, if any (P21a). */
  reversal: z.object({ reason: z.string(), at: iso, byName: z.string().nullable() }).nullable(),
  createdAt: iso,
});
export type ExpenseRow = z.infer<typeof expenseRowSchema>;

export const expensesContract = {
  list: oc
    .route({ method: 'GET', path: '/expenses', summary: 'Expenses, newest first (AC-03)' })
    .input(
      z.object({
        propertyId: uuid.optional(),
        ownerId: uuid.optional(),
        jobId: uuid.optional(),
        status: z.enum(EXPENSE_STATUSES).optional(),
        category: z.enum(EXPENSE_CATEGORIES).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
      }),
    )
    .output(z.array(expenseRowSchema)),
  get: oc
    .route({ method: 'GET', path: '/expenses/{expenseId}' })
    .input(z.object({ expenseId: uuid }))
    .output(expenseRowSchema),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/expense-uploads',
      summary: 'Upload a receipt (PDF, JPEG, PNG or WebP; 10 MB)',
    })
    .input(mediaUploadInputSchema)
    .output(presignedUpload),
  record: oc
    .route({
      method: 'POST',
      path: '/expenses',
      summary:
        'Record an expense on a property or unit, optionally for a job, with its receipt if there is one (F3: optional; without one it is flagged `noReceipt`). Posts P15: Dr 5000 or 5400; Cr 2500 if unpaid, 1070 if the agent paid, 1010 if the owner paid. Only an agency pays as the agent (400 EXPENSE_PAID_BY). 409 INSUFFICIENT_AGENT_CASH when the agent pays beyond what it holds for the owner (record the owner’s funding first). Requires an Idempotency-Key',
    })
    .input(
      z.object({
        propertyId: uuid,
        unitId: uuid.nullable().optional(),
        category: z.enum(EXPENSE_CATEGORIES),
        supplierName: z.string().trim().min(2).max(120),
        amountMinor: positiveMinor,
        expenseDate: isoDate,
        paidBy: z.enum(EXPENSE_PAID_BY),
        receiptUploadId: uuid.nullable().optional(),
        jobId: uuid.nullable().optional(),
        note: optionalText(500),
      }),
    )
    .output(expenseRowSchema),
  pay: oc
    .route({
      method: 'POST',
      path: '/expenses/{expenseId}/payment',
      summary:
        'Record an unpaid expense as paid (P15: Dr 2500, Cr 1010 or 1070). A self-managing landlord has no agency account (400 AGENCY_ACCOUNT_NOT_AVAILABLE). 409 INSUFFICIENT_AGENT_CASH when paid from the agency’s account beyond what it holds for the owner (record the owner’s funding first). Requires an Idempotency-Key',
    })
    .input(
      z.object({
        expenseId: uuid,
        paidOn: isoDate,
        paidFrom: z.enum(['owner_account', 'agency_account']),
        reference: optionalText(120),
      }),
    )
    .output(expenseRowSchema),
  reverse: oc
    .route({
      method: 'POST',
      path: '/expenses/{expenseId}/reverse',
      summary:
        'Reverse an expense recorded in error (P21a), with the reason; record the right one as a new expense. Requires an Idempotency-Key',
    })
    .input(z.object({ expenseId: uuid, reason: z.string().trim().min(3).max(500) }))
    .output(expenseRowSchema),
  receiptDownload: oc
    .route({ method: 'GET', path: '/expenses/{expenseId}/receipt' })
    .input(z.object({ expenseId: uuid }))
    .output(download),
};

// The tenant app's repairs (MI-01, CM-04; decision 3) --------------------------------------------

export const tenantRepairSchema = z.object({
  jobId: uuid,
  ticket: z.string(),
  status: z.enum(MAINTENANCE_JOB_STATUSES),
  statusLabel: z.string(),
  description: z.string(),
  category: z.enum(MAINTENANCE_CATEGORIES).nullable(),
  emergency: z.boolean(),
  leaseId: uuid.nullable(),
  unitCode: z.string().nullable(),
  visitAt: iso.nullable(),
  /** Work done and waiting for the tenant: confirm, or say what is wrong. */
  awaitingResponse: z.boolean(),
  completionNote: z.string().nullable(),
  /** The steps the tenant hears about, newest last. */
  steps: z.array(
    z.object({
      kind: z.enum([
        'reported',
        'assigned',
        'visit_planned',
        'started',
        'work_done',
        'confirmed',
        'disputed',
        'closed',
        'cancelled',
      ]),
      at: iso,
    }),
  ),
  attachments: z.array(
    z.object({
      id: uuid,
      kind: z.enum(MAINTENANCE_ATTACHMENT_KINDS),
      stage: z.enum(MAINTENANCE_ATTACHMENT_STAGES),
      contentType: z.string(),
    }),
  ),
  createdAt: iso,
  /** On Starter (decision 1): logged on the timeline and forwarded to the landlord, not a job. */
  forwarded: z.boolean(),
});
export type TenantRepairView = z.infer<typeof tenantRepairSchema>;

const landlordSchema = z.object({
  companyId: uuid,
  name: z.string(),
  /** The landlord company's time zone (IANA), for showing its times; always sent. */
  timeZone: z.string().optional(),
});

export const tenantRepairsContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/me/repairs',
      summary:
        'The signed-in tenant’s repairs, by landlord (TL-12: never another landlord’s). One group per landlord, with or without repairs',
    })
    .output(
      z.array(
        z.object({
          landlord: landlordSchema,
          /**
           * F2: false on Starter. The repair form then asks for a description only and says the
           * landlord will be in touch; uploads and `uploadIds` are refused (403 REPAIR_FILES_NOT_ON_PLAN).
           */
          filesAllowed: z.boolean(),
          repairs: z.array(tenantRepairSchema),
        }),
      ),
    ),
  createUpload: oc
    .route({
      method: 'POST',
      path: '/me/repair-uploads',
      summary:
        'Upload a photo, video or voice note for a repair request (decision 2 limits). Growth only: on Starter, 403 REPAIR_FILES_NOT_ON_PLAN (F2)',
    })
    .input(mediaUploadInputSchema.extend({ leaseId: uuid }))
    .output(presignedUpload),
  report: oc
    .route({
      method: 'POST',
      path: '/me/repairs',
      summary:
        'Report a repair from the app: category, description, the emergency flag and up to 10 files (Growth only; on Starter, any `uploadIds` answer 403 REPAIR_FILES_NOT_ON_PLAN before anything is stored, F2). Idempotent by the app’s client id, so a retry or an offline send makes one job. A lease that ended more than 30 days ago answers 409 LEASE_ENDED',
    })
    .input(
      z.object({
        leaseId: uuid,
        /** The app's own id for the request, made when it was written (offline too). */
        clientId: uuid,
        category: z.enum(MAINTENANCE_CATEGORIES),
        description: z.string().trim().min(3).max(2000),
        emergency: z.boolean(),
        uploadIds: z.array(uuid).max(10).default([]),
      }),
    )
    .output(tenantRepairSchema),
  respond: oc
    .route({
      method: 'POST',
      path: '/me/repairs/{jobId}/response',
      summary:
        'Confirm the work is done (the job closes), or say what is still wrong (it goes back to In progress)',
    })
    .input(
      z.object({
        jobId: uuid,
        response: z.enum(['confirmed', 'disputed']),
        reason: optionalText(1000),
      }),
    )
    .output(tenantRepairSchema),
  attachment: oc
    .route({ method: 'GET', path: '/me/repairs/{jobId}/attachments/{attachmentId}/download' })
    .input(z.object({ jobId: uuid, attachmentId: uuid }))
    .output(z.object({ url: z.string() })),
};

/** Re-exported for the move-out screens: the SLA stages, for the job's timeline. */
export const MAINTENANCE_SLA_STAGE_VALUES = MAINTENANCE_SLA_STAGES;
