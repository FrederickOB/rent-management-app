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
    // M3 tenancy settings (plan 4.11 and decision 4). Optional here, so stored settings and the
    // M1 defaults are unchanged; tenancySettingsOf() applies their defaults.
    /** Decision 4: a witness signs every lease unless the company turns this off. */
    witnessRequired: z.boolean().optional(),
    /** TX-05 and OQ-52: track Rent Control registration for commercial leases too. */
    rentControlCommercial: z.boolean().optional(),
    /** TX-05: days before the registration deadline; then weekly until registered. */
    rentControlReminderDaysBefore: z
      .array(z.number().int().min(0).max(366))
      .min(1)
      .max(12)
      .optional(),
    /** OQ-45: days before the stamping deadline; then weekly until stamped. */
    stampingReminderDaysBefore: z.array(z.number().int().min(0).max(366)).min(1).max(12).optional(),
  })
  .strict();

export type CompanySettings = z.infer<typeof companySettingsSchema>;

/** The M3 settings with their defaults applied: product choices, not law (CLAUDE.md section 7). */
export interface TenancySettings {
  readonly witnessRequired: boolean;
  readonly rentControlCommercial: boolean;
  readonly renewalReminderDays: readonly number[];
  readonly rentControlReminderDaysBefore: readonly number[];
  readonly stampingReminderDaysBefore: readonly number[];
  readonly advanceRentPolicy: CompanySettings['advanceRentPolicy'];
}

/**
 * Reminder defaults from the M3 plan (4.11): Rent Control at 7, 12 and 14 days after signing,
 * which with the 14-day rule is 7, 2 and 0 days before the deadline; stamping 30, 14 and 7 days
 * before. Both then weekly.
 */
export function tenancySettingsOf(settings: CompanySettings): TenancySettings {
  return {
    witnessRequired: settings.witnessRequired ?? true,
    rentControlCommercial: settings.rentControlCommercial ?? false,
    renewalReminderDays: settings.renewalReminderDays,
    rentControlReminderDaysBefore: settings.rentControlReminderDaysBefore ?? [7, 2, 0],
    stampingReminderDaysBefore: settings.stampingReminderDaysBefore ?? [30, 14, 7],
    advanceRentPolicy: settings.advanceRentPolicy,
  };
}

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
