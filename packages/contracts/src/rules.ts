import { oc } from '@orpc/contract';
import { z } from 'zod';

export const ruleSchema = z.object({
  id: z.string().uuid(),
  country: z.string(),
  key: z.string(),
  value: z.unknown(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  source: z.string(),
  verificationStatus: z.enum(['verified', 'from_prd', 'unverified']),
  /** Staff must see a warning where this value affects a legal outcome (CLAUDE.md section 7). */
  warning: z.boolean(),
});

export const rulesContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/rules',
      summary: 'Rules in force on a date, with their verification status (TX-08)',
    })
    .input(
      z.object({
        country: z.string().length(2).default('GH'),
        asOf: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .output(z.array(ruleSchema)),
};
