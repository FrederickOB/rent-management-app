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

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');

/** A rules row as stored, with who verified it and who added it (M10 decision 16). */
export const ruleRowSchema = ruleSchema.extend({
  verifiedBy: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  /** Whether the row is in force today, superseded, or from a future date. */
  state: z.enum(['in_force', 'superseded', 'future']),
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
  // M10 decision 16: the console's rules screen.
  history: oc
    .route({
      method: 'GET',
      path: '/rules/history',
      summary:
        'Every rules row, past, in force and future, newest first, for platform admins (`rules.view`)',
    })
    .input(z.object({ country: z.string().length(2).default('GH'), key: z.string().optional() }))
    .output(z.array(ruleRowSchema)),
  add: oc
    .route({
      method: 'POST',
      path: '/rules',
      summary:
        'Add a rules row (append-only), as `pnpm rules:add` does, for platform admins (`rules.add`). 400 RULE_VALUE',
    })
    .input(
      z.object({
        country: z.string().length(2).default('GH'),
        key: z
          .string()
          .trim()
          .regex(/^[a-z0-9_]+(\.[a-z0-9_*]+)+$/, 'A dotted key such as vat.platform_subscription'),
        value: z.unknown(),
        effectiveFrom: isoDate,
        effectiveTo: isoDate.optional(),
        source: z.string().trim().min(3).max(500),
        verificationStatus: z.enum(['verified', 'from_prd', 'unverified']),
        verifiedBy: z.string().trim().max(200).optional(),
        notes: z.string().trim().max(1000).optional(),
      }),
    )
    .output(ruleRowSchema),
};
