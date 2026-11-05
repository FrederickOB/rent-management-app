import { oc } from '@orpc/contract';
import {
  LADDER_ESCALATION_REQUIRED_MESSAGE,
  LADDER_NOTICE_TYPES,
  laddersMissingEscalation,
} from '@rent/domain/notices';
import { maintenanceTargetsSchema } from '@rent/domain/maintenance';
import { inboxTag, INTERIM_PLANS, PLAN_FEATURES } from '@rent/domain/settings';
import { z } from 'zod';

const ladderHours = z
  .number()
  .int()
  .min(1)
  .max(24 * 60);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 07:00');
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #0F766E');

/** The bounds the domain's company settings use (packages/domain/src/settings). */
const daysBefore = z.array(z.number().int().min(0).max(366)).min(1).max(12);

export const companySettingsSchema = z.object({
  rentReminderOffsetsDays: z.array(z.number().int()),
  noticeReminderOffsetsHours: z.array(z.number().int()),
  renewalReminderDays: z.array(z.number().int()),
  advanceRentPolicy: z.enum(['off', 'warn', 'block']),
  approvalExpiryDays: z.number().int(),
  approvalCoolingOffHours: z.number().int(),
  // M3 (decision 4; plan 4.8 and 4.11). GET always returns the values in force, defaults
  // applied; they are optional here so clients written before M3 keep their types.
  /** A witness signs every lease (decision 4); new drafts take this. */
  witnessRequired: z.boolean().optional(),
  /** Track Rent Control registration for commercial leases too (TX-05, OQ-52). */
  rentControlCommercial: z.boolean().optional(),
  /** Days before the Rent Control deadline to remind staff; then weekly. */
  rentControlReminderDaysBefore: daysBefore.optional(),
  /** Days before the stamping deadline to remind staff; then weekly (OQ-45). */
  stampingReminderDaysBefore: daysBefore.optional(),
  /** Hours after the signing links go out that unsigned signers are reminded (TL-07). */
  signingReminderHours: z
    .array(
      z
        .number()
        .int()
        .min(1)
        .max(24 * 30),
    )
    .min(1)
    .max(12)
    .optional(),
  // M4b (plan 4.3 and 4.9), optional so clients written before M4b keep their types.
  /** The landlord's own payment instructions, shown on the pay page when online payment is unavailable. */
  manualPaymentInstructions: z.string().trim().max(500).nullable().optional(),
  /** The payment providers to try for a charge, in order; the deployment's own when unset. */
  paymentProviderOrder: z
    .array(z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/))
    .min(1)
    .max(5)
    .optional(),
  // M5 (plan 5.5), optional so clients written before M5 keep their types.
  /** AR-06: days before paid-until that the renewal prompt goes; GET returns 90 when unset. */
  paidUntilPromptDays: z.number().int().min(7).max(366).optional(),
  // M6 (CM-06, decision 10), optional so clients written before M6 keep their types.
  /** Clock minutes from a tenant's message to the first staff reply; GET returns 240 when unset. */
  inboxFirstResponseMinutes: z
    .number()
    .int()
    .min(15)
    .max(7 * 24 * 60)
    .optional(),
  /** The tags staff may put on conversations. */
  inboxTags: z.array(inboxTag).min(1).max(30).optional(),
  // M7 (plan 4.9), optional so clients written before M7 keep their types. GET returns the values
  // in force, defaults applied.
  /** LN-05: the ladder per notice type; a type left out uses its default. */
  noticeLadders: z
    .partialRecord(
      z.enum(LADDER_NOTICE_TYPES),
      z
        .object({
          reminderHours: z.array(ladderHours).max(6),
          inPersonHours: ladderHours.nullable(),
          /** Required (not null) for full-ladder types (review D-F). */
          escalationHours: ladderHours.nullable(),
        })
        .strict(),
    )
    .superRefine((ladders, ctx) => {
      for (const type of laddersMissingEscalation(ladders))
        ctx.addIssue({
          code: 'custom',
          path: [type, 'escalationHours'],
          message: LADDER_ESCALATION_REQUIRED_MESSAGE,
        });
    })
    .optional(),
  /** Decision 11: tenant ladder messages go only inside this window, company time (07:00-20:00). */
  noticeSendWindow: z.object({ from: timeOfDay, to: timeOfDay }).strict().optional(),
  /** LN-02 (prd-issues 27): days a notice link works for a type without a notice period (90). */
  noticeLinkExpiryDays: z.number().int().min(30).max(366).optional(),
  // M8 (decisions 4 and 7), optional so clients written before M8 keep their types. GET returns
  // the values in force, defaults applied.
  /** MI-02: respond and complete targets per priority, calendar hours (emergency 2 h and 24 h, urgent 24 h and 3 days, routine 3 and 14 days). */
  maintenanceTargets: maintenanceTargetsSchema.optional(),
  /** MI-06: days after work done that a job closes without the tenant's reply (7). */
  maintenanceAutoCloseDays: z.number().int().min(1).max(60).optional(),
});

export const companyProfileSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['landlord', 'agency', 'platform']),
  legalName: z.string(),
  displayName: z.string(),
  countryCode: z.string(),
  timeZone: z.string(),
  currency: z.string(),
  branding: z.object({
    primaryColour: hex,
    accentColour: hex,
    senderName: z.string(),
    /** Short-lived download link, issued after a policy check. */
    logoUrl: z.string().url().nullable(),
  }),
  settings: companySettingsSchema,
  /**
   * M6 decision 9: the interim plan (set by a platform admin) and what it includes. Starter has no
   * inbox, broadcasts, tenant groups or maintenance. Always sent; optional for older clients.
   */
  plan: z.enum(INTERIM_PLANS).optional(),
  features: z.array(z.enum(PLAN_FEATURES)).optional(),
});

export type CompanyProfile = z.infer<typeof companyProfileSchema>;

export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 1_000_000;

export const companyContract = {
  get: oc
    .route({
      method: 'GET',
      path: '/company',
      summary: 'The current company and its branding (AD-01)',
    })
    .output(companyProfileSchema),
  updateBranding: oc
    .route({ method: 'PATCH', path: '/company/branding' })
    .input(
      z.object({
        displayName: z.string().trim().min(2).max(80).optional(),
        primaryColour: hex.optional(),
        accentColour: hex.optional(),
        senderName: z.string().trim().min(2).max(40).optional(),
      }),
    )
    .output(companyProfileSchema),
  updateSettings: oc
    .route({ method: 'PATCH', path: '/company/settings' })
    .input(companySettingsSchema.partial())
    .output(companyProfileSchema),
  createLogoUpload: oc
    .route({
      method: 'POST',
      path: '/company/logo/uploads',
      summary: 'A presigned upload for a new logo',
    })
    .input(
      z.object({
        contentType: z.enum(LOGO_CONTENT_TYPES),
        sizeBytes: z.number().int().positive().max(LOGO_MAX_BYTES),
      }),
    )
    .output(
      z.object({
        uploadId: z.string().uuid(),
        url: z.string().url(),
        fields: z.record(z.string(), z.string()),
        expiresAt: z.string().datetime(),
      }),
    ),
  confirmLogoUpload: oc
    .route({
      method: 'POST',
      path: '/company/logo/uploads/{uploadId}/confirm',
      summary: 'Check, re-encode and apply an uploaded logo',
    })
    .input(z.object({ uploadId: z.string().uuid() }))
    .output(companyProfileSchema),
};
