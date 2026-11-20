import { oc } from '@orpc/contract';
import {
  DATA_PROTECTION_REQUEST_KINDS,
  DATA_PROTECTION_REQUEST_STATUSES,
  RETENTION_CATEGORIES,
} from '@rent/domain/data-protection';
import { z } from 'zod';

/**
 * Data protection requests under Act 843 (M11 decision 5; prd-issues 30). The landlord is the
 * controller, so the register lives in its app, for company admins (`data_protection.manage`,
 * `data_protection.export`). Every change is audited.
 *
 * - **Access:** a per-tenant export (Excel plus the tenant's leases, receipts, notices and
 *   messages), made by a job, stored write-once, downloaded through a short-lived link.
 * - **Erasure:** a tenant's personal fields are anonymised only where the record's retention rule
 *   is verified and its period has passed. Until then the request is recorded, messaging to the
 *   tenant stops on every channel, and the outcome lists what is held and until when.
 * - **Due date:** from the rules row `data_protection.request_response_days`, null and unverified
 *   until counsel (OQ-65): `dueOn` is null while it has no value.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const minor = z.number().int();
const named = z.object({ id: uuid, name: z.string() });

/** A record held under its retention rule rather than anonymised. */
const heldSchema = z.object({
  category: z.enum(RETENTION_CATEGORIES),
  records: minor,
  /** Until when, from a verified rule; null while the rule has no verified value. */
  until: isoDate.nullable(),
  reason: z.string(),
});

export const dataProtectionExportSchema = z.object({
  id: uuid,
  status: z.enum(['preparing', 'ready', 'failed']),
  url: z.string().nullable(),
  expiresAt: iso.nullable(),
  /**
   * M11 review round: one export holds at most 100 MB of files. Over it, the largest photos and
   * recordings (then the largest other files) are left out, largest first, and listed in the
   * workbook's About sheet with the record each belongs to, where staff can download them.
   * `split` once ready and something was left out; `leftOut` counts them (0 when nothing was).
   */
  split: z.boolean().optional(),
  leftOut: minor.optional(),
});

export const dataProtectionRequestSchema = z.object({
  id: uuid,
  tenant: named,
  kind: z.enum(DATA_PROTECTION_REQUEST_KINDS),
  receivedOn: isoDate,
  /** From the rules row; null while it is unverified and empty (OQ-65). */
  dueOn: isoDate.nullable(),
  dueRuleUnverified: z.boolean(),
  status: z.enum(DATA_PROTECTION_REQUEST_STATUSES),
  notes: z.string().nullable(),
  outcome: z.string().nullable(),
  /** Erasure: messaging to the tenant has stopped on every channel. */
  messagingStopped: z.boolean(),
  /** Erasure: what was anonymised, by category. */
  anonymised: z.array(z.object({ category: z.enum(RETENTION_CATEGORIES), records: minor })),
  /** Erasure: what is held under retention, and until when. */
  held: z.array(heldSchema),
  /** Access: the latest export. */
  export: dataProtectionExportSchema.nullable(),
  createdBy: named.nullable(),
  createdAt: iso,
  completedAt: iso.nullable(),
});
export type DataProtectionRequestView = z.infer<typeof dataProtectionRequestSchema>;

export const dataProtectionContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/data-protection/requests',
      summary: 'The request register, newest first',
    })
    .input(
      z.object({
        tenantId: uuid.optional(),
        status: z.enum(DATA_PROTECTION_REQUEST_STATUSES).optional(),
      }),
    )
    .output(z.array(dataProtectionRequestSchema)),
  create: oc
    .route({
      method: 'POST',
      path: '/data-protection/requests',
      summary:
        'Record a request. An erasure request stops messaging to the tenant on every channel at once',
    })
    .input(
      z.object({
        tenantId: uuid,
        kind: z.enum(DATA_PROTECTION_REQUEST_KINDS),
        receivedOn: isoDate,
        notes: z.string().trim().max(2000).optional(),
      }),
    )
    .output(dataProtectionRequestSchema),
  get: oc
    .route({ method: 'GET', path: '/data-protection/requests/{requestId}' })
    .input(z.object({ requestId: uuid }))
    .output(dataProtectionRequestSchema),
  update: oc
    .route({
      method: 'POST',
      path: '/data-protection/requests/{requestId}',
      summary: 'Move a request on, with its outcome. 409 REQUEST_CLOSED once completed or refused',
    })
    .input(
      z.object({
        requestId: uuid,
        status: z.enum(DATA_PROTECTION_REQUEST_STATUSES),
        outcome: z.string().trim().max(2000).optional(),
      }),
    )
    .output(dataProtectionRequestSchema),
  exportCreate: oc
    .route({
      method: 'POST',
      path: '/data-protection/requests/{requestId}/export',
      summary:
        'Access: prepare the tenant’s export (only that tenant’s records). 409 NOT_ACCESS_REQUEST',
    })
    .input(z.object({ requestId: uuid }))
    .output(dataProtectionExportSchema),
  exportGet: oc
    .route({ method: 'GET', path: '/data-protection/exports/{exportId}' })
    .input(z.object({ exportId: uuid }))
    .output(dataProtectionExportSchema),
  erase: oc
    .route({
      method: 'POST',
      path: '/data-protection/requests/{requestId}/erase',
      summary:
        'Erasure: anonymise what retention allows; the rest is held, listed with its rule. 409 NOT_ERASURE_REQUEST. Requires an Idempotency-Key',
    })
    .input(z.object({ requestId: uuid }))
    .output(dataProtectionRequestSchema),
};

/** The nightly retention review (decision 5), for platform admins: counts only, nothing deleted. */
export const retentionReviewSchema = z.object({
  checkedAt: iso.nullable(),
  categories: z.array(
    z.object({
      category: z.enum(RETENTION_CATEGORIES),
      ruleKey: z.string(),
      verified: z.boolean(),
      /** The retention period, when the rule has a value. */
      years: z.number().nullable(),
      /** Records past it (only counted when the rule is verified). */
      pastRetention: minor,
    }),
  ),
});

export const platformRetentionContract = {
  review: oc
    .route({
      method: 'GET',
      path: '/platform/retention',
      summary: 'Records past each verified retention period, from the nightly review',
    })
    .output(retentionReviewSchema),
};
