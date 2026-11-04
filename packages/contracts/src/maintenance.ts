import { oc } from '@orpc/contract';
import {
  MAINTENANCE_ATTACHMENT_KINDS,
  MAINTENANCE_JOB_STATUSES,
  MAINTENANCE_SOURCES,
} from '@rent/domain/maintenance';
import { z } from 'zod';

/**
 * Reported repairs (CM-04 stub; M6 decision 12; MI-01). The bot creates them; staff read them
 * here until M8 builds the maintenance board on the same records. Read-only in M6.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();

export const maintenanceJobSchema = z.object({
  id: uuid,
  /** `MT-0042`: per company, from 1. */
  ticket: z.string(),
  ticketNumber: z.number().int(),
  status: z.enum(MAINTENANCE_JOB_STATUSES),
  source: z.enum(MAINTENANCE_SOURCES),
  description: z.string(),
  property: z.object({ id: uuid, name: z.string() }),
  unit: z.object({ id: uuid, code: z.string() }).nullable(),
  tenant: z.object({ id: uuid, name: z.string() }).nullable(),
  leaseId: uuid.nullable(),
  /** The conversation it came from, to open the thread. */
  conversationId: uuid.nullable(),
  attachmentCount: z.number().int(),
  createdAt: iso,
});
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;

export const maintenanceJobDetailSchema = maintenanceJobSchema.extend({
  attachments: z.array(
    z.object({
      id: uuid,
      kind: z.enum(MAINTENANCE_ATTACHMENT_KINDS),
      contentType: z.string(),
      createdAt: iso,
    }),
  ),
});
export type MaintenanceJobDetail = z.infer<typeof maintenanceJobDetailSchema>;

export const maintenanceContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/maintenance-jobs',
      summary: 'Reported repairs, newest first (CM-04; the board arrives in M8)',
    })
    .input(
      z.object({
        propertyId: uuid.optional(),
        tenantId: uuid.optional(),
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
    .output(z.object({ url: z.string(), expiresAt: iso })),
};
