import { oc } from '@orpc/contract';
import {
  AMENITIES,
  AVAILABILITY,
  BILLING_BANDS,
  DISPLAY_STATUSES,
  MAX_UNITS_PER_REQUEST,
  METER_TYPES,
  OWNER_KINDS,
  PROPERTY_PAPER_MAX_BYTES,
  PROPERTY_PHOTO_MAX_BYTES,
  PROPERTY_TYPES,
  PROPERTY_USES,
  REGISTER_IMPORT_MAX_BYTES,
  UNIT_TYPES,
  UTILITIES,
} from '@rent/domain/portfolio';
import { z } from 'zod';

/** The property register (PR-01 to PR-09, AD-02, PB-01; M2 plan section 4.10). */

const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const flag = z.stringbool().optional();

export const ownerSchema = z.object({
  id: uuid,
  reference: z.string(),
  kind: z.enum(OWNER_KINDS),
  displayName: z.string(),
  legalName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  residenceCountry: z.string().nullable(),
  timeZone: z.string(),
  notes: z.string().nullable(),
  /** M3 tax fields (plan 4.13). Always sent; optional so M2 clients keep their types. */
  lettingBusiness: z.boolean().optional(),
  vatRegistered: z.boolean().optional(),
  /** Masked; reveal it with a reason (owner.manage). */
  tinMasked: z.string().nullable().optional(),
  archived: z.boolean(),
  createdAt: iso,
});
export type OwnerRow = z.infer<typeof ownerSchema>;

const ownerFields = {
  reference: z.string().trim().max(20).nullable().optional(),
  legalName: optionalText(160),
  phone: z.string().trim().max(20).nullable().optional(),
  email: z.string().trim().email().nullable().optional(),
  residenceCountry: z.string().trim().length(2).nullable().optional(),
  timeZone: z.string().trim().max(64).optional(),
  notes: optionalText(1000),
  lettingBusiness: z.boolean().optional(),
  vatRegistered: z.boolean().optional(),
  /** Stored encrypted; send null to remove it. Never returned except through reveal. */
  tin: z.string().trim().max(20).nullable().optional(),
};

export const statusCountsSchema = z.object(
  Object.fromEntries(DISPLAY_STATUSES.map((s) => [s, z.number().int()])) as Record<
    (typeof DISPLAY_STATUSES)[number],
    z.ZodNumber
  >,
);

const ownerRefSchema = z.object({ id: uuid, reference: z.string(), displayName: z.string() });

export const unitRowSchema = z.object({
  id: uuid,
  code: z.string(),
  label: z.string(),
  propertyId: uuid,
  propertyCode: z.string(),
  propertyName: z.string(),
  blockId: uuid,
  blockCode: z.string(),
  unitType: z.enum(UNIT_TYPES),
  bedrooms: z.number().int().nullable(),
  billingBand: z.enum(BILLING_BANDS),
  bandOverridden: z.boolean(),
  availability: z.enum(AVAILABILITY),
  status: z.enum(DISPLAY_STATUSES),
  /** From leases (PB-09): reserved between signature and start. */
  occupancy: z.enum(['occupied', 'reserved', 'vacant']),
  underRepair: z.boolean(),
  owner: ownerRefSchema.nullable(),
  region: z.string(),
  district: z.string().nullable(),
  archived: z.boolean(),
});
export type UnitRowView = z.infer<typeof unitRowSchema>;

export const propertyRowSchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  propertyType: z.enum(PROPERTY_TYPES),
  use: z.enum(PROPERTY_USES),
  region: z.string(),
  district: z.string().nullable(),
  town: z.string().nullable(),
  owner: ownerRefSchema.nullable(),
  unitCount: z.number().int(),
  counts: statusCountsSchema,
  archived: z.boolean(),
});
export type PropertyRowView = z.infer<typeof propertyRowSchema>;

const pinSchema = z.object({ latitude: z.string(), longitude: z.string() });

export const meterSchema = z.object({
  id: uuid,
  utility: z.enum(UTILITIES),
  supplier: z.string(),
  meterNumber: z.string(),
  meterType: z.enum(METER_TYPES),
  notes: z.string().nullable(),
  unitIds: z.array(uuid),
  archived: z.boolean(),
});
export type MeterRow = z.infer<typeof meterSchema>;

export const propertyDetailSchema = propertyRowSchema.extend({
  portfolio: z.object({ id: uuid, name: z.string() }),
  address: z.object({
    ghanapostGps: z.string().nullable(),
    region: z.string(),
    district: z.string().nullable(),
    mmda: z.string().nullable(),
    town: z.string().nullable(),
    street: z.string().nullable(),
    pin: pinSchema.nullable(),
    mapsLink: z.string().url().nullable(),
    source: z.enum(['lookup', 'manual']),
  }),
  ownership: z.array(
    z.object({
      ownerId: uuid,
      reference: z.string(),
      displayName: z.string(),
      shareBps: z.number().int(),
      effectiveFrom: isoDate,
      current: z.boolean(),
    }),
  ),
  blocks: z.array(
    z.object({
      id: uuid,
      code: z.string(),
      name: z.string().nullable(),
      isDefault: z.boolean(),
      archived: z.boolean(),
      units: z.array(unitRowSchema),
    }),
  ),
  meters: z.array(meterSchema),
  createdAt: iso,
});
export type PropertyDetailView = z.infer<typeof propertyDetailSchema>;

export const statusEventSchema = z.object({
  id: uuid,
  kind: z.enum(['availability', 'occupancy']),
  fromValue: z.string().nullable(),
  toValue: z.string(),
  reason: z.string().nullable(),
  source: z.enum(['created', 'manual', 'import', 'lease']),
  actorName: z.string().nullable(),
  occurredAt: iso,
});

export const unitDetailSchema = unitRowSchema.extend({
  floor: z.string().nullable(),
  description: z.string().nullable(),
  amenities: z.array(z.enum(AMENITIES)),
  bandOverrideReason: z.string().nullable(),
  meters: z.array(meterSchema),
  history: z.array(statusEventSchema),
});
export type UnitDetailView = z.infer<typeof unitDetailSchema>;

const unitBatchSchema = z.object({
  unitType: z.enum(UNIT_TYPES),
  count: z.number().int().min(1).max(200),
  bedrooms: z.number().int().min(1).max(20).nullable().optional(),
  amenities: z.array(z.enum(AMENITIES)).optional(),
});

/** Units one request creates, across its blocks and batches; capped (MAX_UNITS_PER_REQUEST). */
const unitsIn = (batches: readonly { count: number }[] | undefined) =>
  (batches ?? []).reduce((sum, batch) => sum + batch.count, 0);
const withinUnitCap = (total: number) => total <= MAX_UNITS_PER_REQUEST;
const unitCapMessage = {
  message: `Add at most ${MAX_UNITS_PER_REQUEST.toLocaleString('en-GB')} units at a time`,
};

const addressSchema = z.object({
  ghanapostGps: optionalText(20),
  region: z.string().trim().min(2).max(60),
  district: optionalText(80),
  mmda: optionalText(80),
  town: optionalText(80),
  street: optionalText(160),
  latitude: z.string().trim().max(12).nullable().optional(),
  longitude: z.string().trim().max(12).nullable().optional(),
  source: z.enum(['lookup', 'manual']).optional(),
});

const blockCode = z.string().trim().min(1).max(3);

export const propertyFileSchema = z.object({
  id: uuid,
  propertyId: uuid,
  category: z.enum(['photo', 'title_or_indenture', 'site_plan', 'building_permit', 'other']),
  status: z.enum(['processing', 'ready', 'failed']),
  caption: z.string().nullable(),
  originalFilename: z.string().nullable(),
  contentType: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: iso,
});
export type PropertyFileRow = z.infer<typeof propertyFileSchema>;

const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});

const importIssueSchema = z.object({
  sheet: z.string(),
  row: z.number().int().nullable(),
  column: z.string().nullable(),
  message: z.string(),
});
const importCounts = z.object({
  create: z.number().int(),
  update: z.number().int(),
  unchanged: z.number().int(),
});
export const registerImportSchema = z.object({
  id: uuid,
  status: z.enum([
    'uploaded',
    'validating',
    'validated',
    'invalid',
    'committing',
    'committed',
    'failed',
  ]),
  fileName: z.string().nullable(),
  report: z
    .object({
      fileName: z.string().nullable(),
      sha256: z.string(),
      counts: z.object({
        properties: importCounts,
        units: importCounts,
        blocks: z.number().int(),
        meters: z.number().int(),
      }),
      issues: z.array(importIssueSchema),
      issueCount: z.number().int(),
    })
    .nullable(),
  error: z.string().nullable(),
  createdAt: iso,
  validatedAt: iso.nullable(),
  committedAt: iso.nullable(),
});
export type RegisterImportRow = z.infer<typeof registerImportSchema>;

export const ownersContract = {
  list: oc
    .route({ method: 'GET', path: '/owners', summary: 'Owners this person may see (AD-02)' })
    .input(z.object({ includeArchived: flag }))
    .output(z.array(ownerSchema)),
  get: oc
    .route({ method: 'GET', path: '/owners/{ownerId}' })
    .input(z.object({ ownerId: uuid }))
    .output(ownerSchema),
  create: oc
    .route({ method: 'POST', path: '/owners' })
    .input(
      z.object({
        kind: z.enum(OWNER_KINDS),
        displayName: z.string().trim().min(2).max(120),
        ...ownerFields,
      }),
    )
    .output(ownerSchema),
  update: oc
    .route({ method: 'PATCH', path: '/owners/{ownerId}' })
    .input(
      z.object({
        ownerId: uuid,
        kind: z.enum(OWNER_KINDS).optional(),
        displayName: z.string().trim().min(2).max(120).optional(),
        ...ownerFields,
      }),
    )
    .output(ownerSchema),
  archive: oc
    .route({ method: 'POST', path: '/owners/{ownerId}/archive' })
    .input(z.object({ ownerId: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  revealTin: oc
    .route({
      method: 'POST',
      path: '/owners/{ownerId}/tin/reveal',
      summary: 'Show an owner’s TIN, with a reason; audited (plan 4.13)',
    })
    .input(z.object({ ownerId: uuid, reason: z.string().trim().min(10).max(300) }))
    .output(z.object({ tin: z.string() })),
};

export const registerContract = {
  options: oc
    .route({
      method: 'GET',
      path: '/register/options',
      summary: 'Lists for the register forms: regions, meter suppliers and portfolios',
    })
    .output(
      z.object({
        regions: z.array(z.string()),
        meterSuppliers: z.object({ electricity: z.array(z.string()), water: z.array(z.string()) }),
        portfolios: z.array(z.object({ id: uuid, name: z.string(), isDefault: z.boolean() })),
        addressLookup: z.boolean(),
      }),
    ),
  createPortfolio: oc
    .route({ method: 'POST', path: '/portfolios' })
    .input(z.object({ name: z.string().trim().min(2).max(120) }))
    .output(z.object({ id: uuid })),
  renamePortfolio: oc
    .route({ method: 'PATCH', path: '/portfolios/{portfolioId}' })
    .input(z.object({ portfolioId: uuid, name: z.string().trim().min(2).max(120) }))
    .output(z.object({ ok: z.literal(true) })),
  listProperties: oc
    .route({ method: 'GET', path: '/properties', summary: 'Properties with unit counts by status' })
    .input(
      z.object({
        ownerId: uuid.optional(),
        region: z.string().max(60).optional(),
        district: z.string().max(80).optional(),
        propertyType: z.enum(PROPERTY_TYPES).optional(),
        search: z.string().max(80).optional(),
        includeArchived: flag,
      }),
    )
    .output(z.object({ rows: z.array(propertyRowSchema), counts: statusCountsSchema })),
  getProperty: oc
    .route({ method: 'GET', path: '/properties/{propertyId}' })
    .input(z.object({ propertyId: uuid }))
    .output(propertyDetailSchema),
  createProperty: oc
    .route({
      method: 'POST',
      path: '/properties',
      summary: 'A property with its blocks and units in bulk (PR-01)',
    })
    .input(
      z
        .object({
          portfolioId: uuid.nullable().optional(),
          areaCode: z.string().trim().min(2).max(4),
          propertyPart: z.string().trim().min(2).max(4),
          name: z.string().trim().min(2).max(120),
          propertyType: z.enum(PROPERTY_TYPES),
          use: z.enum(PROPERTY_USES),
          ownerId: uuid.nullable().optional(),
          address: addressSchema,
          blocks: z
            .array(
              z.object({
                code: blockCode,
                name: optionalText(60),
                units: z.array(unitBatchSchema).max(20).optional(),
              }),
            )
            .max(50)
            .optional(),
          units: z.array(unitBatchSchema).max(20).optional(),
        })
        .refine(
          // Units go into the blocks given, or into the default block when there are none.
          (v) =>
            withinUnitCap(
              v.blocks?.length
                ? v.blocks.reduce((sum, b) => sum + unitsIn(b.units), 0)
                : unitsIn(v.units),
            ),
          unitCapMessage,
        ),
    )
    .output(propertyDetailSchema),
  updateProperty: oc
    .route({ method: 'PATCH', path: '/properties/{propertyId}' })
    .input(
      z.object({
        propertyId: uuid,
        name: z.string().trim().min(2).max(120).optional(),
        propertyType: z.enum(PROPERTY_TYPES).optional(),
        use: z.enum(PROPERTY_USES).optional(),
        portfolioId: uuid.optional(),
        address: addressSchema.optional(),
      }),
    )
    .output(propertyDetailSchema),
  archiveProperty: oc
    .route({ method: 'POST', path: '/properties/{propertyId}/archive' })
    .input(z.object({ propertyId: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  changeOwner: oc
    .route({ method: 'POST', path: '/properties/{propertyId}/ownership' })
    .input(z.object({ propertyId: uuid, ownerId: uuid, effectiveFrom: isoDate }))
    .output(propertyDetailSchema),
  addBlock: oc
    .route({ method: 'POST', path: '/properties/{propertyId}/blocks' })
    .input(
      z
        .object({
          propertyId: uuid,
          code: blockCode,
          name: optionalText(60),
          units: z.array(unitBatchSchema).max(20).optional(),
        })
        .refine((v) => withinUnitCap(unitsIn(v.units)), unitCapMessage),
    )
    .output(propertyDetailSchema),
  renameBlock: oc
    .route({ method: 'PATCH', path: '/blocks/{blockId}' })
    .input(z.object({ blockId: uuid, name: optionalText(60) }))
    .output(z.object({ ok: z.literal(true) })),
  addUnits: oc
    .route({
      method: 'POST',
      path: '/blocks/{blockId}/units',
      summary: 'Units in bulk by type and count',
    })
    .input(
      z
        .object({ blockId: uuid, batches: z.array(unitBatchSchema).min(1).max(20) })
        .refine((v) => withinUnitCap(unitsIn(v.batches)), unitCapMessage),
    )
    .output(z.object({ unitIds: z.array(uuid) })),
  listUnits: oc
    .route({
      method: 'GET',
      path: '/units',
      summary: 'Every unit this person may see, with counts by status (PRD section 5)',
    })
    .input(
      z.object({
        ownerId: uuid.optional(),
        region: z.string().max(60).optional(),
        district: z.string().max(80).optional(),
        propertyId: uuid.optional(),
        unitType: z.enum(UNIT_TYPES).optional(),
        status: z.enum(DISPLAY_STATUSES).optional(),
        search: z.string().max(80).optional(),
        includeArchived: flag,
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    )
    .output(
      z.object({
        rows: z.array(unitRowSchema),
        total: z.number().int(),
        counts: statusCountsSchema,
      }),
    ),
  getUnit: oc
    .route({ method: 'GET', path: '/units/{unitId}' })
    .input(z.object({ unitId: uuid }))
    .output(unitDetailSchema),
  updateUnit: oc
    .route({ method: 'PATCH', path: '/units/{unitId}' })
    .input(
      z.object({
        unitId: uuid,
        unitType: z.enum(UNIT_TYPES).optional(),
        bedrooms: z.number().int().min(1).max(20).nullable().optional(),
        floor: optionalText(20),
        description: optionalText(500),
        amenities: z.array(z.enum(AMENITIES)).optional(),
      }),
    )
    .output(unitDetailSchema),
  setAvailability: oc
    .route({
      method: 'POST',
      path: '/units/{unitId}/availability',
      summary: 'Change availability by hand, with a reason (PR-06)',
    })
    .input(
      z.object({
        unitId: uuid,
        availability: z.enum(AVAILABILITY),
        reason: z.string().trim().min(3).max(300),
      }),
    )
    .output(unitDetailSchema),
  setBand: oc
    .route({
      method: 'POST',
      path: '/units/{unitId}/band',
      summary: 'Override or restore the billing band, with a reason (PB-01)',
    })
    .input(
      z.object({
        unitId: uuid,
        band: z.enum(BILLING_BANDS),
        reason: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .output(unitDetailSchema),
  archiveUnit: oc
    .route({ method: 'POST', path: '/units/{unitId}/archive' })
    .input(z.object({ unitId: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  addMeter: oc
    .route({ method: 'POST', path: '/properties/{propertyId}/meters' })
    .input(
      z.object({
        propertyId: uuid,
        utility: z.enum(UTILITIES),
        supplier: z.string().trim().min(2).max(40),
        meterNumber: z.string().trim().min(3).max(40),
        meterType: z.enum(METER_TYPES),
        notes: optionalText(300),
        unitIds: z.array(uuid).max(500).optional(),
      }),
    )
    .output(z.object({ id: uuid })),
  updateMeter: oc
    .route({ method: 'PATCH', path: '/meters/{meterId}' })
    .input(
      z.object({
        meterId: uuid,
        supplier: z.string().trim().min(2).max(40).optional(),
        meterNumber: z.string().trim().min(3).max(40).optional(),
        meterType: z.enum(METER_TYPES).optional(),
        notes: optionalText(300),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  setMeterUnits: oc
    .route({ method: 'PUT', path: '/meters/{meterId}/units' })
    .input(z.object({ meterId: uuid, unitIds: z.array(uuid).max(500) }))
    .output(z.object({ ok: z.literal(true) })),
  archiveMeter: oc
    .route({ method: 'POST', path: '/meters/{meterId}/archive' })
    .input(z.object({ meterId: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  lookupAddress: oc
    .route({
      method: 'GET',
      path: '/address-lookup',
      summary: 'GhanaPost GPS lookup; unavailable means type the address (PR-03)',
    })
    .input(z.object({ code: z.string().trim().min(6).max(20) }))
    .output(
      z.object({
        available: z.boolean(),
        address: z
          .object({
            code: z.string(),
            region: z.string(),
            district: z.string(),
            latitude: z.number(),
            longitude: z.number(),
          })
          .nullable(),
      }),
    ),
};

export const propertyFilesContract = {
  createUpload: oc
    .route({ method: 'POST', path: '/properties/{propertyId}/files/uploads' })
    .input(
      z.object({
        propertyId: uuid,
        category: propertyFileSchema.shape.category,
        contentType: z.string().max(100),
        // The larger of the photo and paper limits; the API checks the one for the category.
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(Math.max(PROPERTY_PHOTO_MAX_BYTES, PROPERTY_PAPER_MAX_BYTES)),
      }),
    )
    .output(presignedUpload),
  confirmUpload: oc
    .route({ method: 'POST', path: '/properties/{propertyId}/files' })
    .input(
      z.object({
        propertyId: uuid,
        uploadId: uuid,
        category: propertyFileSchema.shape.category,
        caption: optionalText(200),
        fileName: optionalText(200),
      }),
    )
    .output(propertyFileSchema),
  list: oc
    .route({ method: 'GET', path: '/properties/{propertyId}/files' })
    .input(z.object({ propertyId: uuid }))
    .output(z.array(propertyFileSchema)),
  download: oc
    .route({
      method: 'GET',
      path: '/property-files/{fileId}/download',
      summary: 'A 5-minute link to the file, after the policy check',
    })
    .input(z.object({ fileId: uuid, variant: z.enum(['main', 'thumbnail']).default('main') }))
    .output(z.object({ url: z.string() })),
  archive: oc
    .route({ method: 'POST', path: '/property-files/{fileId}/archive' })
    .input(z.object({ fileId: uuid }))
    .output(z.object({ ok: z.literal(true) })),
};

export const registerImportsContract = {
  template: oc
    .route({
      method: 'GET',
      path: '/register-imports/template',
      summary: 'The import template (PR-08)',
    })
    .output(z.file()),
  createUpload: oc
    .route({ method: 'POST', path: '/register-imports/uploads' })
    .input(
      z.object({
        sizeBytes: z.number().int().positive().max(REGISTER_IMPORT_MAX_BYTES),
        fileName: optionalText(200),
      }),
    )
    .output(z.object({ importId: uuid, upload: presignedUpload })),
  validate: oc
    .route({
      method: 'POST',
      path: '/register-imports/{importId}/validate',
      summary: 'The dry run: every problem by sheet, row and column; nothing is written',
    })
    .input(z.object({ importId: uuid }))
    .output(registerImportSchema),
  get: oc
    .route({ method: 'GET', path: '/register-imports/{importId}' })
    .input(z.object({ importId: uuid }))
    .output(registerImportSchema),
  commit: oc
    .route({ method: 'POST', path: '/register-imports/{importId}/commit' })
    .input(z.object({ importId: uuid }))
    .output(registerImportSchema),
};
