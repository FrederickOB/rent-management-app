import { oc } from '@orpc/contract';
import { z } from 'zod';

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
