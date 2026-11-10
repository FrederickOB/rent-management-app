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

const minor = z.number().int();
const named = z.object({ id: z.string().uuid(), name: z.string() });
const roleState = z.object({
  role: z.string(),
  nominatedApprover: z.boolean(),
  scope: z.object({
    owners: z.array(z.string().uuid()).optional(),
    properties: z.array(z.string().uuid()).optional(),
  }),
});

/**
 * M11 review C2: the payload of an `opening_balances` request, so the second person sees what
 * they approve: the batch, its money per owner and in total, and where to check it (`link`).
 */
export const openingBalancesApprovalSchema = z.object({
  batchId: z.string().uuid(),
  kind: z.enum(['balances', 'adjustment']),
  cutOverDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fileName: z.string().nullable(),
  /** The screen to check it on: the onboarding page's balances step. */
  link: z.literal('/onboarding'),
  leases: minor,
  owners: z.array(
    z.object({
      owner: named,
      arrearsMinor: minor,
      advancesMinor: minor,
      depositsMinor: minor,
      withholdingMinor: minor,
      agentCashMinor: minor,
      rentTaxOutstandingMinor: minor,
    }),
  ),
  totals: z.object({
    arrearsMinor: minor,
    advancesMinor: minor,
    depositsMinor: minor,
    withholdingMinor: minor,
    agentCashMinor: minor,
    rentTaxOutstandingMinor: minor,
  }),
});
export type OpeningBalancesApproval = z.infer<typeof openingBalancesApprovalSchema>;

/**
 * M11 review C2 (founder D1): the payload of a `membership.approver_change` request: whose
 * membership (the name as the inviter typed it), and the role or nomination from and to.
 */
export const membershipApproverChangeSchema = z.object({
  membershipId: z.string().uuid(),
  personName: z.string(),
  change: z.enum(['invite', 'update']),
  from: roleState.extend({ status: z.enum(['invited', 'active']) }),
  to: roleState,
  needsAcceptance: z.boolean(),
});
export type MembershipApproverChange = z.infer<typeof membershipApproverChangeSchema>;

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
