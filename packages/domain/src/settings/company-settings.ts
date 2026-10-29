import { z } from 'zod';

/**
 * Company settings: product choices, not law (CLAUDE.md section 7). Defaults are the PRD's.
 * New keys get defaults, so stored settings from earlier milestones stay valid.
 */
const offsets = (fallback: number[]) => z.array(z.number().int()).min(1).max(12).default(fallback);

export const companySettingsSchema = z
  .object({
    /** BC-09: days relative to the due date. */
    rentReminderOffsetsDays: offsets([-7, 0, 3, 7, 14]),
    /** PRD section 8: hours after a notice is issued. */
    noticeReminderOffsetsHours: offsets([24, 72, 120, 168]),
    /** TL-09: days before a lease ends. */
    renewalReminderDays: offsets([90, 60, 30]),
    /** OQ-28 and D6: `off` by default; `warn` flags, `block` refuses. */
    advanceRentPolicy: z.enum(['off', 'warn', 'block']).default('off'),
    /** Approval requests close unanswered after this many days (M1 plan 4.7). */
    approvalExpiryDays: z.number().int().min(1).max(90).default(7),
    /** AD-05 and OQ-29: a single-user landlord confirms after this cooling-off; never shorter than 24 hours. */
    approvalCoolingOffHours: z
      .number()
      .int()
      .min(24)
      .max(24 * 7)
      .default(24),
  })
  .strict();

export type CompanySettings = z.infer<typeof companySettingsSchema>;

export const parseCompanySettings = (value: unknown): CompanySettings =>
  companySettingsSchema.parse(value ?? {});

export const defaultCompanySettings = (): CompanySettings => companySettingsSchema.parse({});

/** Partial update: unknown keys are refused, given keys are validated, the rest kept. */
export function mergeCompanySettings(current: CompanySettings, patch: unknown): CompanySettings {
  const partial = companySettingsSchema.partial().strict().parse(patch);
  return companySettingsSchema.parse({ ...current, ...partial });
}

export const brandingSchema = z
  .object({
    primaryColour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #0F766E'),
    accentColour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #F59E0B'),
    senderName: z.string().trim().min(2).max(40),
  })
  .strict();

export type Branding = z.infer<typeof brandingSchema>;
