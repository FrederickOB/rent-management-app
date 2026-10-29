import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { company } from './company';
import { person } from './identity';
import { document } from './platform';

const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);

/**
 * Owners (AD-02): an agency's clients, or the landlord in their own company. Scoped sessions see
 * only their own owners (a second, restrictive RLS policy on `id`).
 */
export const owner = pgTable(
  'owner',
  {
    id: id(),
    companyId: companyId(),
    reference: text().notNull(),
    kind: text().notNull(),
    displayName: text().notNull(),
    legalName: text(),
    phone: text(),
    email: text(),
    residenceCountry: char({ length: 2 }),
    timeZone: text().notNull().default('Africa/Accra'),
    notes: text(),
    isTestContact: boolean().notNull().default(false),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('owner_company_id_id_key').on(t.companyId, t.id),
    unique('owner_reference_key').on(t.companyId, t.reference),
    check('owner_kind_check', sql`${t.kind} in ('individual', 'company')`),
  ],
);

/** A named group of properties (PR-01). Each company has one default portfolio. */
export const portfolio = pgTable(
  'portfolio',
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    isDefault: boolean().notNull().default(false),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('portfolio_company_id_id_key').on(t.companyId, t.id),
    unique('portfolio_name_key').on(t.companyId, t.name),
    uniqueIndex('portfolio_one_default')
      .on(t.companyId)
      .where(sql`${t.isDefault}`),
  ],
);

/** A property (PR-01, PR-03). Its code is fixed when it is created and never reused. */
export const property = pgTable(
  'property',
  {
    id: id(),
    companyId: companyId(),
    portfolioId: uuid().notNull(),
    code: text().notNull(),
    areaCode: text().notNull(),
    name: text().notNull(),
    propertyType: text().notNull(),
    use: text().notNull(),
    ghanapostGps: text(),
    region: text().notNull(),
    district: text(),
    mmda: text(),
    town: text(),
    street: text(),
    latitude: numeric({ precision: 9, scale: 6 }),
    longitude: numeric({ precision: 9, scale: 6 }),
    addressSource: text().notNull().default('manual'),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('property_company_id_id_key').on(t.companyId, t.id),
    unique('property_code_key').on(t.companyId, t.code),
    foreignKey({
      columns: [t.companyId, t.portfolioId],
      foreignColumns: [portfolio.companyId, portfolio.id],
    }),
    index('property_location_idx').on(t.companyId, t.region, t.district),
    check('property_code_check', sql`${t.code} ~ '^[A-Z]{2,4}-[A-Z0-9]{2,4}$'`),
    check(
      'property_type_check',
      sql`${t.propertyType} in ('apartment_block', 'house', 'compound_house', 'shop', 'office', 'warehouse', 'mixed_use', 'gated_estate')`,
    ),
    check('property_use_check', sql`${t.use} in ('residential', 'commercial', 'mixed')`),
    check('property_address_source_check', sql`${t.addressSource} in ('lookup', 'manual')`),
    check('property_pin_check', sql`(${t.latitude} is null) = (${t.longitude} is null)`),
  ],
);

/**
 * Who owns a property, from when (AD-02). Append-only: a change adds rows with a new date. The
 * shares on each date add up to 10,000 basis points (checked at commit), so joint ownership
 * (PR-07) is more rows, not a migration.
 */
export const propertyOwnership = pgTable(
  'property_ownership',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    ownerId: uuid().notNull(),
    shareBps: integer().notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    recordedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('property_ownership_company_id_id_key').on(t.companyId, t.id),
    unique('property_ownership_owner_date_key').on(
      t.companyId,
      t.propertyId,
      t.effectiveFrom,
      t.ownerId,
    ),
    foreignKey({
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    index('property_ownership_owner_idx').on(t.companyId, t.ownerId),
    check('property_ownership_share_check', sql`${t.shareBps} > 0 and ${t.shareBps} <= 10000`),
  ],
);

/** A block within a property (PR-01). A property without blocks has one default block, B1. */
export const block = pgTable(
  'block',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    code: text().notNull(),
    name: text(),
    isDefault: boolean().notNull().default(false),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('block_company_id_id_key').on(t.companyId, t.id),
    unique('block_company_property_id_key').on(t.companyId, t.propertyId, t.id),
    unique('block_code_key').on(t.companyId, t.propertyId, t.code),
    foreignKey({
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    check('block_code_check', sql`${t.code} ~ '^[A-Z0-9]{1,3}$'`),
  ],
);

/**
 * A unit (PR-01, PR-02, PR-09, PB-01). Its code is fixed and never reused. Availability is set by
 * hand; occupancy is derived from leases (PB-09) and is not stored here.
 */
export const unit = pgTable(
  'unit',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    blockId: uuid().notNull(),
    code: text().notNull(),
    label: text().notNull(),
    unitType: text().notNull(),
    bedrooms: smallint(),
    billingBand: text().notNull(),
    bandOverrideReason: text(),
    availability: text().notNull().default('available'),
    floor: text(),
    description: text(),
    amenities: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('unit_company_id_id_key').on(t.companyId, t.id),
    unique('unit_company_property_id_key').on(t.companyId, t.propertyId, t.id),
    unique('unit_code_key').on(t.companyId, t.code),
    unique('unit_label_key').on(t.companyId, t.blockId, t.label),
    foreignKey({
      columns: [t.companyId, t.propertyId, t.blockId],
      foreignColumns: [block.companyId, block.propertyId, block.id],
    }),
    index('unit_property_idx').on(t.companyId, t.propertyId),
    index('unit_filter_idx').on(t.companyId, t.unitType, t.availability),
    check(
      'unit_code_check',
      sql`${t.code} ~ '^[A-Z]{2,4}-[A-Z0-9]{2,4}-[A-Z0-9]{1,3}-[A-Z0-9]{1,4}$'`,
    ),
    check(
      'unit_type_check',
      sql`${t.unitType} in ('single_room', 'chamber_and_hall', 'single_room_self_contained', 'studio', 'apartment', 'detached_house', 'semi_detached_house', 'townhouse', 'shop', 'store', 'office', 'warehouse', 'kiosk')`,
    ),
    check(
      'unit_band_check',
      sql`${t.billingBand} in ('single_room', 'self_contained', 'commercial')`,
    ),
    check(
      'unit_availability_check',
      sql`${t.availability} in ('available', 'reserved', 'under_repair', 'not_lettable')`,
    ),
    check('unit_bedrooms_check', sql`${t.bedrooms} is null or ${t.bedrooms} between 1 and 20`),
  ],
);

/**
 * Unit status history (PR-06, PB-09). Append-only and written only by database triggers, so
 * every change is recorded and no history row can be forged.
 */
export const unitStatusEvent = pgTable(
  'unit_status_event',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    unitId: uuid().notNull(),
    kind: text().notNull(),
    fromValue: text(),
    toValue: text().notNull(),
    reason: text(),
    source: text().notNull(),
    leaseId: uuid(),
    actorPersonId: uuid(),
    occurredAt: tsNow(),
  },
  (t) => [
    unique('unit_status_event_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    index('unit_status_event_unit_idx').on(t.companyId, t.unitId, t.occurredAt),
    check('unit_status_event_kind_check', sql`${t.kind} in ('availability', 'occupancy')`),
    check(
      'unit_status_event_source_check',
      sql`${t.source} in ('created', 'manual', 'import', 'lease')`,
    ),
  ],
);

/** Electricity and water meters (PR-05). A shared meter can serve several units. */
export const meter = pgTable(
  'meter',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    utility: text().notNull(),
    supplier: text().notNull(),
    meterNumber: text().notNull(),
    meterType: text().notNull(),
    notes: text(),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('meter_company_id_id_key').on(t.companyId, t.id),
    unique('meter_company_property_id_key').on(t.companyId, t.propertyId, t.id),
    unique('meter_number_key').on(t.companyId, t.utility, t.supplier, t.meterNumber),
    foreignKey({
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    check('meter_utility_check', sql`${t.utility} in ('electricity', 'water')`),
    check('meter_type_check', sql`${t.meterType} in ('prepaid', 'postpaid', 'shared')`),
  ],
);

/** Which units a meter serves. Meter and units are always in the same property. */
export const unitMeter = pgTable(
  'unit_meter',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    meterId: uuid().notNull(),
    unitId: uuid().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('unit_meter_company_id_id_key').on(t.companyId, t.id),
    unique('unit_meter_link_key').on(t.companyId, t.meterId, t.unitId),
    foreignKey({
      columns: [t.companyId, t.propertyId, t.meterId],
      foreignColumns: [meter.companyId, meter.propertyId, meter.id],
    }),
    foreignKey({
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    index('unit_meter_unit_idx').on(t.companyId, t.unitId),
  ],
);

/**
 * Photos and papers for a property (PR-04). The stored files are `document` rows; photos get a
 * display version and a thumbnail once the worker has re-encoded them.
 */
export const propertyFile = pgTable(
  'property_file',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    category: text().notNull(),
    status: text().notNull().default('processing'),
    uploadIntentId: uuid().notNull(),
    documentId: uuid(),
    thumbnailDocumentId: uuid(),
    caption: text(),
    originalFilename: text(),
    error: text(),
    uploadedBy: uuid()
      .notNull()
      .references(() => person.id),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('property_file_company_id_id_key').on(t.companyId, t.id),
    unique('property_file_upload_key').on(t.companyId, t.uploadIntentId),
    foreignKey({
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      columns: [t.companyId, t.thumbnailDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('property_file_property_idx').on(t.companyId, t.propertyId),
    check(
      'property_file_category_check',
      sql`${t.category} in ('photo', 'title_or_indenture', 'site_plan', 'building_permit', 'other')`,
    ),
    check('property_file_status_check', sql`${t.status} in ('processing', 'ready', 'failed')`),
    check('property_file_ready_check', sql`${t.status} <> 'ready' or ${t.documentId} is not null`),
  ],
);

/** An Excel import of properties and units (PR-08): the file, its report and its outcome. */
export const registerImport = pgTable(
  'register_import',
  {
    id: id(),
    companyId: companyId(),
    status: text().notNull().default('uploaded'),
    uploadIntentId: uuid().notNull(),
    storageKey: text().notNull(),
    fileName: text(),
    fileSha256: text(),
    report: jsonb(),
    error: text(),
    createdBy: uuid()
      .notNull()
      .references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    validatedAt: timestamp({ withTimezone: true }),
    committedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('register_import_company_id_id_key').on(t.companyId, t.id),
    unique('register_import_upload_key').on(t.companyId, t.uploadIntentId),
    check(
      'register_import_status_check',
      sql`${t.status} in ('uploaded', 'validating', 'validated', 'invalid', 'committing', 'committed', 'failed')`,
    ),
  ],
);
