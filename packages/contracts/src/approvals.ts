import { oc } from '@orpc/contract';
import { z } from 'zod';

export const approvalSchema = z.object({
  id: z.string().uuid(),
  actionType: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  payload: z.unknown(),
  initiatedBy: z.string().uuid(),
  mode: z.enum(['two_person', 'single_user']),
  status: z.enum(['pending', 'cooling_off', 'approved', 'rejected', 'cancelled', 'expired']),
  coolingOffUntil: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  closeReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  decisions: z.array(
    z.object({
      decidedBy: z.string().uuid(),
      kind: z.enum(['approve', 'reject', 'self_confirm']),
      reason: z.string().nullable(),
      decidedAt: z.string().datetime(),
    }),
  ),
  /**
   * Whether you may approve or reject it now: it waits for a second person, you did not raise it
   * or decide it yet, and your role may decide this kind of request. The API always sends it and
   * checks again on a decision; a client that does not have it leaves the API to decide.
   */
  mayDecide: z.boolean().optional(),
});

export const approvalsContract = {
  list: oc
    .route({ method: 'GET', path: '/approvals' })
    .input(z.object({ status: z.enum(['open', 'closed']).default('open') }))
    .output(z.array(approvalSchema)),
  get: oc
    .route({ method: 'GET', path: '/approvals/{id}' })
    .input(z.object({ id: z.string().uuid() }))
    .output(approvalSchema),
  decide: oc
    .route({
      method: 'POST',
      path: '/approvals/{id}/decisions',
      summary:
        'Approve or reject; a single-user initiator self-confirms with a TOTP code after cooling off (AD-05)',
    })
    .input(
      z.object({
        id: z.string().uuid(),
        decision: z.enum(['approve', 'reject', 'self_confirm']),
        reason: z.string().max(500).optional(),
        code: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      }),
    )
    .output(approvalSchema),
  cancel: oc
    .route({ method: 'POST', path: '/approvals/{id}/cancel' })
    .input(z.object({ id: z.string().uuid() }))
    .output(approvalSchema),
};
