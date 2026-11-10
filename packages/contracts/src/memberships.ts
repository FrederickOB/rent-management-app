import { oc } from '@orpc/contract';
import { requiresPasswordAndTotp } from '@rent/domain/policy';
import { z } from 'zod';

export const STAFF_ROLES = [
  'owner',
  'agency_admin',
  'property_manager',
  'accountant',
  'caretaker',
  'adviser',
] as const;

export const scopeSchema = z.object({
  owners: z.array(z.string().uuid()).optional(),
  properties: z.array(z.string().uuid()).optional(),
});

export const membershipSchema = z.object({
  membershipId: z.string().uuid(),
  personId: z.string().uuid(),
  name: z.string(),
  /** Null for people who sign in by phone only. */
  email: z.string().nullable(),
  /** Masked, for example +233 ** *** 4567. */
  phoneMasked: z.string().nullable(),
  role: z.enum(STAFF_ROLES),
  status: z.enum(['invited', 'active', 'revoked']),
  nominatedApprover: z.boolean(),
  scope: scopeSchema,
  /**
   * M8 (decision 5): the person agreed to emergency alerts on WhatsApp. SMS alerts go to staff
   * phones anyway. Always sent; optional for clients written before M8.
   */
  whatsappConsent: z.boolean().optional(),
  createdAt: z.string().datetime(),
  /**
   * Founder D1 (M11): the approval request this change waits for. Set when an invite, promotion or
   * nomination adds someone to the people who can approve two-person actions; the membership is
   * unchanged (or `invited`) until a second person approves it.
   */
  approvalRequestId: z.string().uuid().optional(),
});

export type MembershipRow = z.infer<typeof membershipSchema>;

export const membershipsContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/memberships',
      summary: 'People in this company and their roles (AD-03)',
    })
    .output(z.array(membershipSchema)),
  invite: oc
    .route({
      method: 'POST',
      path: '/memberships',
      summary: 'Add someone; staff get a set-password email, caretakers sign in by phone',
    })
    .input(
      z
        .object({
          name: z.string().trim().min(2).max(120),
          email: z.string().trim().email().optional(),
          phone: z.string().trim().min(7).max(20).optional(),
          role: z.enum(STAFF_ROLES),
          nominatedApprover: z.boolean().optional(),
          /** M8 (decision 5): they agreed to emergency alerts on WhatsApp (recorded as consent). */
          whatsappConsent: z.boolean().optional(),
        })
        .refine((v) => (requiresPasswordAndTotp(v.role) ? Boolean(v.email) : Boolean(v.phone)), {
          message: 'Caretakers need a phone number; everyone else needs an email address',
        }),
    )
    .output(membershipSchema),
  update: oc
    .route({
      method: 'PATCH',
      path: '/memberships/{membershipId}',
      summary: 'Change a role, scope or nominated-approver flag (audited)',
    })
    .input(
      z.object({
        membershipId: z.string().uuid(),
        role: z.enum(STAFF_ROLES).optional(),
        scope: scopeSchema.optional(),
        nominatedApprover: z.boolean().optional(),
      }),
    )
    .output(membershipSchema),
  whatsappConsent: oc
    .route({
      method: 'POST',
      path: '/memberships/{membershipId}/whatsapp-consent',
      summary:
        'Record that a staff member agreed to, or withdrew from, emergency alerts on WhatsApp (decision 5; a consent record, as tenants have)',
    })
    .input(z.object({ membershipId: z.string().uuid(), granted: z.boolean() }))
    .output(membershipSchema),
  revoke: oc
    .route({
      method: 'POST',
      path: '/memberships/{membershipId}/revoke',
      summary: 'Remove someone from this company',
    })
    .input(z.object({ membershipId: z.string().uuid() }))
    .output(membershipSchema),
};
