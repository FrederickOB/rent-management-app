import { oc } from '@orpc/contract';
import { z } from 'zod';
import { scopeSchema, STAFF_ROLES } from './memberships';

export const membershipSummarySchema = z.object({
  membershipId: z.string().uuid(),
  companyId: z.string().uuid(),
  companyName: z.string(),
  companyKind: z.enum(['landlord', 'agency', 'platform']),
  role: z.string(),
  nominatedApprover: z.boolean(),
  /**
   * The owners and properties this membership is limited to (AD-02), so screens ask the policy
   * the same question the API does. Always sent; optional so older clients keep their types.
   */
  scope: scopeSchema.optional(),
});

export const meSchema = z.object({
  personId: z.string().uuid(),
  name: z.string(),
  /** `enrolment_required`: set up TOTP first. `company_required`: choose a company. */
  state: z.enum(['enrolment_required', 'company_required', 'ready']),
  authMethod: z.enum(['password', 'password_totp', 'phone_otp']),
  sessionExpiresAt: z.string().datetime(),
  actorKind: z.enum(['staff', 'platform_admin', 'tenant']).nullable(),
  activeCompanyId: z.string().uuid().nullable(),
  role: z.string().nullable(),
  memberships: z.array(membershipSummarySchema),
});

export type Me = z.infer<typeof meSchema>;

/** Founder D2 (M11): an invitation to a company, waiting for the invited person to accept it. */
export const invitationSchema = z.object({
  membershipId: z.string().uuid(),
  companyId: z.string().uuid(),
  companyName: z.string(),
  /** A platform admin invited as an existing person waits too (platform:bootstrap, D2). */
  role: z.enum([...STAFF_ROLES, 'platform_admin']),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const meContract = {
  get: oc
    .route({
      method: 'GET',
      path: '/me',
      summary: 'The signed-in person, their session and memberships',
    })
    .output(meSchema),
  setActiveCompany: oc
    .route({
      method: 'POST',
      path: '/me/active-company',
      summary: 'Choose the company this session works in',
    })
    .input(z.object({ companyId: z.string().uuid() }))
    .output(meSchema),
  /** M8 (decision 5): the signed-in staff member's own WhatsApp opt-in, from their profile. */
  whatsappConsent: oc
    .route({ method: 'GET', path: '/me/whatsapp-consent' })
    .output(z.object({ granted: z.boolean(), phoneMasked: z.string().nullable() })),
  setWhatsappConsent: oc
    .route({
      method: 'POST',
      path: '/me/whatsapp-consent',
      summary:
        'Agree to, or withdraw from, emergency alerts on WhatsApp in this company (a consent record)',
    })
    .input(z.object({ granted: z.boolean() }))
    .output(z.object({ granted: z.boolean(), phoneMasked: z.string().nullable() })),
  /** Founder D2 (M11): a membership for an existing person waits until that person accepts it. */
  invitations: oc
    .route({
      method: 'GET',
      path: '/me/invitations',
      summary: 'Invitations waiting for the signed-in person (D2)',
    })
    .output(z.array(invitationSchema)),
  acceptInvitation: oc
    .route({
      method: 'POST',
      path: '/me/invitations/{membershipId}/accept',
      summary:
        'Accept an invitation; needs the sign-in method of its role, and its approval if it needed one',
    })
    .input(z.object({ membershipId: z.string().uuid() }))
    .output(meSchema),
  declineInvitation: oc
    .route({
      method: 'POST',
      path: '/me/invitations/{membershipId}/decline',
      summary: 'Decline an invitation',
    })
    .input(z.object({ membershipId: z.string().uuid() }))
    .output(z.object({ declined: z.literal(true) })),
};
