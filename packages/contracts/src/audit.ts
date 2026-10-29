import { oc } from '@orpc/contract';
import { z } from 'zod';

export const auditEventSchema = z.object({
  seq: z.number().int(),
  occurredAt: z.string().datetime(),
  actorPersonId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  actorKind: z.string(),
  action: z.string(),
  recordType: z.string().nullable(),
  recordId: z.string().nullable(),
  data: z.unknown(),
});

export type AuditEventRow = z.infer<typeof auditEventSchema>;

export const auditContract = {
  search: oc
    .route({
      method: 'GET',
      path: '/audit-events',
      summary: 'Search the audit log by user, record and date (AD-07)',
    })
    .input(
      z.object({
        actorPersonId: z.string().uuid().optional(),
        recordType: z.string().max(60).optional(),
        recordId: z.string().max(80).optional(),
        action: z.string().max(80).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        /** Keyset paging: events with a lower sequence number than this. */
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    )
    .output(
      z.object({ events: z.array(auditEventSchema), nextBefore: z.number().int().nullable() }),
    ),
};
