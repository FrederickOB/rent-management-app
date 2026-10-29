import { oc } from '@orpc/contract';
import { z } from 'zod';

export const membershipSummarySchema = z.object({
  membershipId: z.string().uuid(),
  companyId: z.string().uuid(),
  companyName: z.string(),
  companyKind: z.enum(['landlord', 'agency', 'platform']),
  role: z.string(),
  nominatedApprover: z.boolean(),
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
};
