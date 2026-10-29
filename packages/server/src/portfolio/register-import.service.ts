import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { DomainError } from '@rent/domain/errors';
import type { Actor } from '@rent/domain/policy';
import {
  AMENITY_LABELS,
  AVAILABILITY_LABELS,
  cellText,
  checkAvailabilityChange,
  checkOwnerReference,
  checkPropertyRows,
  checkUnitRows,
  defaultBandFor,
  IMPORT_SHEETS,
  METER_TYPE_LABELS,
  parsePropertyCode,
  PROPERTY_COLUMNS,
  PROPERTY_TYPE_LABELS,
  REGISTER_IMPORT_MAX_BYTES,
  UNIT_COLUMNS,
  UNIT_TYPE_LABELS,
  WHOLE_PROPERTY_BPS,
  XLSX_CONTENT_TYPE,
  type Availability,
  type ImportIssue,
  type PropertyImportRow,
  type UnitImportRow,
  type Utility,
} from '@rent/domain/portfolio';
import type { StoragePort } from '@rent/integrations';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { invalid, notFound } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, CONFIG, DATABASE, STORAGE_PORT } from '../core/tokens';
import { staffActor } from '../companies/companies.service';
import { OwnersService } from '../companies/owners.service';
import { DocumentsService, type UploadPurpose } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { MetersService } from './meters.service';
import { RegisterService } from './register.service';
import { declaredUncompressedSize } from './zip-guard';

export const REGISTER_IMPORT_UPLOAD: UploadPurpose = {
  purpose: 'register_import',
  contentTypes: [XLSX_CONTENT_TYPE],
  maxBytes: REGISTER_IMPORT_MAX_BYTES,
};
export const VALIDATE_IMPORT_JOB = 'portfolio.import-validate';
export const COMMIT_IMPORT_JOB = 'portfolio.import-commit';

/** An .xlsx is a zip; refuse one that would unpack to more than this (zip bombs). */
const MAX_UNCOMPRESSED_BYTES = 50_000_000;
const MAX_REPORTED_ISSUES = 500;

export interface ImportCounts {
  readonly create: number;
  readonly update: number;
  readonly unchanged: number;
}

export interface ImportReport {
  readonly fileName: string | null;
  readonly sha256: string;
  readonly counts: {
    readonly properties: ImportCounts;
    readonly units: ImportCounts;
    readonly blocks: number;
    readonly meters: number;
  };
  readonly issues: ImportIssue[];
  readonly issueCount: number;
}

export type ImportStatus =
  'uploaded' | 'validating' | 'validated' | 'invalid' | 'committing' | 'committed' | 'failed';

export interface RegisterImportView {
  readonly id: string;
  readonly status: ImportStatus;
  readonly fileName: string | null;
  readonly report: ImportReport | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly validatedAt: Date | null;
  readonly committedAt: Date | null;
}

type SheetRows = { row: number; values: Record<string, unknown> }[];

interface ExistingUnit {
  id: string;
  propertyId: string;
  unitType: string;
  bedrooms: number | null;
  amenities: string[];
  floor: string | null;
  description: string | null;
  availability: string;
}

interface Plan {
  readonly propertiesToCreate: PropertyImportRow[];
  readonly propertiesToUpdate: { id: string; row: PropertyImportRow }[];
  propertiesUnchanged: number;
  readonly ownerByProperty: Map<string, string | 'landlord'>;
  readonly blocksToCreate: Map<string, { propertyCode: string; code: string; name: string | null }>;
  readonly unitsToCreate: UnitImportRow[];
  readonly unitsToUpdate: { unit: ExistingUnit; row: UnitImportRow }[];
  unitsUnchanged: number;
  readonly metersToCreate: Map<
    string,
    { propertyCode: string; utility: Utility; number: string; type: string; supplier: string }
  >;
  /** Meter key to unit codes it should serve after the import. */
  readonly meterLinks: Map<string, Set<string>>;
}

const meterKey = (utility: string, supplier: string, number: string) =>
  `${utility}|${supplier.toLowerCase()}|${number}`;

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const samePin = (a: string | null, b: string | null) =>
  (a === null && b === null) || (a !== null && b !== null && Number(a) === Number(b));

/** Maps a sheet's header row to column keys and returns its non-empty rows. */
function mapSheet(
  name: string,
  data: readonly (readonly unknown[])[] | null,
  columns: readonly { key: string; header: string; required: boolean }[],
): { rows: SheetRows; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  if (!data) return { rows: [], issues };
  const header = (data[0] ?? []).map((c) => cellText(c)?.toLowerCase() ?? '');
  const index = new Map<string, number>();
  for (const column of columns) {
    const i = header.indexOf(column.header.toLowerCase());
    if (i >= 0) index.set(column.key, i);
    else if (column.required)
      issues.push({
        sheet: name,
        row: 1,
        column: column.header,
        message: 'This column is missing',
      });
  }
  const rows: SheetRows = [];
  for (let r = 1; r < data.length; r += 1) {
    const cells = data[r] ?? [];
    if (cells.every((c) => cellText(c) == null)) continue;
    const values: Record<string, unknown> = {};
    for (const [key, i] of index) values[key] = cells[i] ?? null;
    rows.push({ row: r + 1, values });
  }
  return { rows, issues };
}

/**
 * The Excel import of properties and units (PR-08; M2 plan 4.9): a template, a dry run that
 * lists every problem by sheet, row and column, and a commit that applies the whole file in one
 * transaction. Rows match existing records by code, so importing the same file again changes
 * nothing, and an import never changes a code or deletes anything.
 */
@Injectable()
export class RegisterImportService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(RegisterService) private readonly register: RegisterService,
    @Inject(MetersService) private readonly meters: MetersService,
    @Inject(OwnersService) private readonly owners: OwnersService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The template, with the company's owner references and every allowed value on a Lists sheet. */
  async template(actor: Actor | null): Promise<Buffer> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.import');
    const { regions, owners } = await withCompany(
      this.database,
      staffContext(staff),
      async (tx) => ({
        regions: await this.register.regions(tx, staff.companyId),
        owners: await tx
          .select({ reference: schema.owner.reference, name: schema.owner.displayName })
          .from(schema.owner)
          .where(isNull(schema.owner.archivedAt))
          .orderBy(schema.owner.reference),
      }),
    );
    const bold = (value: string) => ({ value, fontWeight: 'bold' as const });
    const lists: [string, string[]][] = [
      ['Property type', Object.values(PROPERTY_TYPE_LABELS)],
      ['Use', ['Residential', 'Commercial', 'Mixed']],
      ['Unit type', Object.values(UNIT_TYPE_LABELS)],
      ['Availability', Object.values(AVAILABILITY_LABELS)],
      ['Meter type', Object.values(METER_TYPE_LABELS)],
      ['Amenities', Object.values(AMENITY_LABELS)],
      ['Region', regions],
      ['Owner reference', owners.map((o) => `${o.reference}`)],
      ['Owner name', owners.map((o) => o.name)],
    ];
    const depth = Math.max(...lists.map(([, values]) => values.length));
    const listRows = [
      lists.map(([title]) => bold(title)),
      ...Array.from({ length: depth }, (_, i) =>
        lists.map(([, values]) => (values[i] === undefined ? null : { value: values[i]! })),
      ),
    ];
    const header = (columns: readonly { header: string }[]) => [columns.map((c) => bold(c.header))];
    return writeXlsxFile([
      { sheet: IMPORT_SHEETS.properties, data: header(PROPERTY_COLUMNS), stickyRowsCount: 1 },
      { sheet: IMPORT_SHEETS.units, data: header(UNIT_COLUMNS), stickyRowsCount: 1 },
      { sheet: IMPORT_SHEETS.lists, data: listRows, stickyRowsCount: 1 },
    ]).toBuffer();
  }

  async createUpload(actor: Actor | null, input: { sizeBytes: number; fileName?: string | null }) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.import');
    const upload = await this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      REGISTER_IMPORT_UPLOAD,
      XLSX_CONTENT_TYPE,
      input.sizeBytes,
    );
    const [row] = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [intent] = await tx
        .select({ storageKey: schema.uploadIntent.storageKey })
        .from(schema.uploadIntent)
        .where(eq(schema.uploadIntent.id, upload.uploadId));
      return tx
        .insert(schema.registerImport)
        .values({
          companyId: staff.companyId,
          uploadIntentId: upload.uploadId,
          storageKey: intent!.storageKey,
          fileName: input.fileName?.trim().slice(0, 200) || null,
          createdBy: staff.personId,
        })
        .returning({ id: schema.registerImport.id });
    });
    return { importId: row!.id, upload };
  }

  /** Starts the dry run (worker job); nothing in the register changes. */
  async startValidation(actor: Actor | null, importId: string): Promise<RegisterImportView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.import');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const found = await this.mine(tx, staff.personId, importId);
      if (!['uploaded', 'invalid', 'validated', 'failed'].includes(found.status))
        throw invalid('import_busy', 'This import is already being checked or committed');
      await tx
        .update(schema.registerImport)
        .set({ status: 'validating', error: null, updatedAt: new Date() })
        .where(eq(schema.registerImport.id, importId));
      await enqueueOutbox(tx, {
        companyId: staff.companyId,
        type: VALIDATE_IMPORT_JOB,
        payload: { importId },
        idempotencyKey: `${VALIDATE_IMPORT_JOB}:${importId}:${this.clock.now().getTime()}`,
      });
    });
    return this.get(staff, importId);
  }

  /** Commits a validated import (worker job). The same person who checked it commits it. */
  async startCommit(actor: Actor | null, importId: string): Promise<RegisterImportView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.import');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const found = await this.mine(tx, staff.personId, importId);
      if (found.status !== 'validated')
        throw invalid(
          'import_not_validated',
          'Check the file, and fix every problem, before importing it',
        );
      await tx
        .update(schema.registerImport)
        .set({ status: 'committing', updatedAt: new Date() })
        .where(eq(schema.registerImport.id, importId));
      await enqueueOutbox(tx, {
        companyId: staff.companyId,
        type: COMMIT_IMPORT_JOB,
        payload: { importId },
        idempotencyKey: `${COMMIT_IMPORT_JOB}:${importId}`,
      });
    });
    return this.get(staff, importId);
  }

  async get(actor: Actor | null, importId: string): Promise<RegisterImportView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.import');
    const [row] = await withCompany(this.database, staffContext(staff), (tx) =>
      tx.select().from(schema.registerImport).where(eq(schema.registerImport.id, importId)),
    );
    if (!row) throw notFound('Import');
    return {
      id: row.id,
      status: row.status as ImportStatus,
      fileName: row.fileName,
      report: (row.report as ImportReport | null) ?? null,
      error: row.error,
      createdAt: row.createdAt,
      validatedAt: row.validatedAt,
      committedAt: row.committedAt,
    };
  }

  private async mine(tx: Tx, personId: string, importId: string) {
    const [row] = await tx
      .select()
      .from(schema.registerImport)
      .where(eq(schema.registerImport.id, importId));
    if (!row || row.createdBy !== personId) throw notFound('Import');
    return row;
  }

  // Worker jobs -----------------------------------------------------------------------------

  /** The dry run: reads the file and checks every row; writes only the report. */
  async validate(companyId: string, importId: string): Promise<void> {
    const loaded = await this.load(companyId, importId, 'validating');
    if (!loaded) return;
    const { row, file, sha256 } = loaded;
    const report = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => (await this.check(tx, companyId, row.fileName, file, sha256)).report,
    );
    await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.registerImport)
        .set({
          status: report.issueCount === 0 ? 'validated' : 'invalid',
          fileSha256: sha256,
          report,
          validatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.registerImport.id, importId)),
    );
  }

  /**
   * Applies a validated import in one transaction, as the person who started it. The file is
   * checked again first: if its bytes or the register changed and a row no longer passes, nothing
   * is written and the import goes back to "invalid" with the new report.
   */
  async commit(companyId: string, importId: string): Promise<void> {
    const loaded = await this.load(companyId, importId, 'committing');
    if (!loaded) return;
    const { row, file, sha256 } = loaded;
    if (row.fileSha256 && row.fileSha256 !== sha256) {
      await this.finish(
        companyId,
        importId,
        'failed',
        null,
        'The file changed after it was checked',
      );
      return;
    }
    const ctx = { companyId, personId: row.createdBy, actorKind: 'system' as const };
    const outcome = await withCompany(this.database, ctx, async (tx) => {
      const { plan, report } = await this.check(tx, companyId, row.fileName, file, sha256);
      if (report.issueCount > 0) return { report, committed: false };
      await this.register.withStatusReason(
        tx,
        `Imported from ${row.fileName ?? 'a spreadsheet'}`,
        'import',
      );
      await this.apply(tx, companyId, row.createdBy, plan);
      await tx
        .update(schema.registerImport)
        .set({ status: 'committed', report, committedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.registerImport.id, importId));
      return { report, committed: true };
    });
    if (!outcome.committed) await this.finish(companyId, importId, 'invalid', outcome.report, null);
  }

  private async load(companyId: string, importId: string, status: ImportStatus) {
    const [row] = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx.select().from(schema.registerImport).where(eq(schema.registerImport.id, importId)),
    );
    if (!row || row.status !== status) return null;
    const bucket = this.config.S3_BUCKET_FILES;
    const head = await this.storage.head({ bucket, key: row.storageKey });
    if (!head) {
      await this.finish(companyId, importId, 'failed', null, 'The file was not uploaded');
      return null;
    }
    if (head.size > REGISTER_IMPORT_UPLOAD.maxBytes) {
      await this.finish(companyId, importId, 'failed', null, 'The file is larger than 5 MB');
      return null;
    }
    const file = await this.storage.get({
      bucket,
      key: row.storageKey,
      versionId: head.versionId ?? undefined,
    });
    return { row, file, sha256: createHash('sha256').update(file).digest('hex') };
  }

  private async finish(
    companyId: string,
    importId: string,
    status: ImportStatus,
    report: ImportReport | null,
    error: string | null,
  ): Promise<void> {
    await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.registerImport)
        .set({ status, ...(report ? { report } : {}), error, updatedAt: new Date() })
        .where(eq(schema.registerImport.id, importId)),
    );
  }

  /** Parses the workbook and checks every row against the domain rules and the register. */
  private async check(
    tx: Tx,
    companyId: string,
    fileName: string | null,
    file: Buffer,
    sha256: string,
  ): Promise<{ plan: Plan; report: ImportReport }> {
    const issues: ImportIssue[] = [];
    const sheets = await this.readSheets(file, issues);
    const regions = await this.register.regions(tx, companyId);
    const suppliers = await this.defaultSuppliers(tx, companyId);
    const properties = checkPropertyRows(sheets.properties.rows, { regions });
    const units = checkUnitRows(sheets.units.rows, { defaultSuppliers: suppliers });
    issues.push(
      ...sheets.properties.issues,
      ...sheets.units.issues,
      ...properties.issues,
      ...units.issues,
    );
    const plan = await this.plan(tx, companyId, properties.rows, units.rows, issues, {
      properties: sheets.properties.rows,
      units: sheets.units.rows,
    });
    issues.sort((a, b) => a.sheet.localeCompare(b.sheet) || (a.row ?? 0) - (b.row ?? 0));
    return {
      plan,
      report: {
        fileName,
        sha256,
        counts: {
          properties: {
            create: plan.propertiesToCreate.length,
            update: plan.propertiesToUpdate.length,
            unchanged: plan.propertiesUnchanged,
          },
          units: {
            create: plan.unitsToCreate.length,
            update: plan.unitsToUpdate.length,
            unchanged: plan.unitsUnchanged,
          },
          blocks: plan.blocksToCreate.size,
          meters: plan.metersToCreate.size,
        },
        issues: issues.slice(0, MAX_REPORTED_ISSUES),
        issueCount: issues.length,
      },
    };
  }

  private async readSheets(file: Buffer, issues: ImportIssue[]) {
    const none = { rows: [] as SheetRows, issues: [] as ImportIssue[] };
    const whole = (message: string) =>
      issues.push({ sheet: 'File', row: null, column: null, message });
    const size = declaredUncompressedSize(file);
    if (size === null) {
      whole('This is not an Excel workbook (.xlsx)');
      return { properties: none, units: none };
    }
    if (size > MAX_UNCOMPRESSED_BYTES) {
      whole('This workbook is too large once unpacked');
      return { properties: none, units: none };
    }
    let workbook: { sheet: string; data: unknown[][] }[];
    try {
      workbook = (await readXlsxFile(file)) as unknown as { sheet: string; data: unknown[][] }[];
    } catch {
      whole('This workbook could not be read');
      return { properties: none, units: none };
    }
    const sheet = (name: string) =>
      workbook.find((s) => s.sheet.trim().toLowerCase() === name.toLowerCase())?.data ?? null;
    const propertyData = sheet(IMPORT_SHEETS.properties);
    const unitData = sheet(IMPORT_SHEETS.units);
    if (!propertyData && !unitData)
      whole(
        `The workbook needs a "${IMPORT_SHEETS.properties}" or a "${IMPORT_SHEETS.units}" sheet`,
      );
    return {
      properties: mapSheet(IMPORT_SHEETS.properties, propertyData, PROPERTY_COLUMNS),
      units: mapSheet(IMPORT_SHEETS.units, unitData, UNIT_COLUMNS),
    };
  }

  private async defaultSuppliers(tx: Tx, companyId: string): Promise<Record<Utility, string>> {
    const [row] = await tx
      .select({ suppliers: schema.country.meterSuppliers })
      .from(schema.company)
      .innerJoin(schema.country, eq(schema.country.code, schema.company.countryCode))
      .where(eq(schema.company.id, companyId));
    const suppliers = (row?.suppliers ?? {}) as Partial<Record<Utility, string[]>>;
    return {
      electricity: suppliers.electricity?.[0] ?? 'Electricity supplier',
      water: suppliers.water?.[0] ?? 'Water supplier',
    };
  }

  /** The database checks: owners, existing codes, blocks, availability changes and meter links. */
  private async plan(
    tx: Tx,
    companyId: string,
    propertyRows: PropertyImportRow[],
    unitRows: UnitImportRow[],
    issues: ImportIssue[],
    raw: { properties: SheetRows; units: SheetRows },
  ): Promise<Plan> {
    const issue = (sheet: string, row: number, column: string, message: string) =>
      issues.push({ sheet, row, column, message });
    const [company] = await tx
      .select({ kind: schema.company.kind })
      .from(schema.company)
      .where(eq(schema.company.id, companyId));
    const owners = new Map(
      (
        await tx
          .select({ id: schema.owner.id, reference: schema.owner.reference })
          .from(schema.owner)
          .where(isNull(schema.owner.archivedAt))
      ).map((o) => [o.reference, o.id]),
    );
    const existingProperties = new Map(
      (await tx.select().from(schema.property)).map((p) => [p.code, p]),
    );
    const currentOwners = new Map(
      (
        await tx.execute<{ property_id: string; owner_id: string }>(
          sql`select property_id, owner_id from property_current_ownership`,
        )
      ).rows.map((r) => [r.property_id, r.owner_id]),
    );
    const plan: Plan = {
      propertiesToCreate: [],
      propertiesToUpdate: [],
      propertiesUnchanged: 0,
      ownerByProperty: new Map(),
      blocksToCreate: new Map(),
      unitsToCreate: [],
      unitsToUpdate: [],
      unitsUnchanged: 0,
      metersToCreate: new Map(),
      meterLinks: new Map(),
    };
    const P = IMPORT_SHEETS.properties;
    for (const row of propertyRows) {
      const existing = existingProperties.get(row.code);
      let ownerId: string | 'landlord' | null = null;
      if (row.ownerReference) {
        ownerId = owners.get(row.ownerReference) ?? null;
        if (!ownerId)
          issue(P, row.row, 'Owner reference', `No owner has the reference ${row.ownerReference}`);
      } else if (company?.kind === 'agency') {
        if (!existing)
          issue(
            P,
            row.row,
            'Owner reference',
            'Required: every property in an agency needs its owner',
          );
      } else if (owners.size > 1) {
        if (!existing)
          issue(P, row.row, 'Owner reference', 'Required: this company has several owners');
      } else ownerId = owners.values().next().value ?? 'landlord';
      if (existing) {
        if (existing.archivedAt) {
          issue(P, row.row, 'Property code', `Property ${row.code} is archived`);
          continue;
        }
        if (row.ownerReference && ownerId && currentOwners.get(existing.id) !== ownerId)
          issue(
            P,
            row.row,
            'Owner reference',
            'Change a property’s owner on its page, with the date of the change',
          );
        const changed =
          !same(existing.name, row.name) ||
          !same(existing.propertyType, row.type) ||
          !same(existing.use, row.use) ||
          !same(existing.ghanapostGps, row.gps) ||
          !same(existing.region, row.region) ||
          !same(existing.district, row.district) ||
          !same(existing.mmda, row.mmda) ||
          !same(existing.town, row.town) ||
          !same(existing.street, row.street) ||
          !samePin(existing.latitude, row.pin?.latitude ?? null) ||
          !samePin(existing.longitude, row.pin?.longitude ?? null);
        if (changed) plan.propertiesToUpdate.push({ id: existing.id, row });
        else plan.propertiesUnchanged += 1;
      } else {
        plan.propertiesToCreate.push(row);
        if (ownerId) plan.ownerByProperty.set(row.code, ownerId);
      }
    }

    // Rows that failed the domain checks still get their references checked, so a dry run
    // lists every problem at once rather than one round at a time.
    const checkedRows = new Set(propertyRows.map((r) => r.row));
    for (const { row, values } of raw.properties) {
      if (checkedRows.has(row)) continue;
      const text = cellText(values.owner);
      if (!text) continue;
      try {
        const reference = checkOwnerReference(text);
        if (!owners.has(reference))
          issue(P, row, 'Owner reference', `No owner has the reference ${reference}`);
      } catch {
        // The domain checks already reported the format.
      }
    }
    const knownProperties = new Set([
      ...[...existingProperties.values()].filter((p) => !p.archivedAt).map((p) => p.code),
      ...plan.propertiesToCreate.map((p) => p.code),
      // A property row with problems of its own: its units are not reported twice.
      ...raw.properties
        .map((r) => cellText(r.values.code)?.toUpperCase())
        .filter((c): c is string => !!c),
    ]);
    const checkedUnits = new Set(unitRows.map((r) => r.row));
    for (const { row, values } of raw.units) {
      if (checkedUnits.has(row)) continue;
      const code = cellText(values.property)?.toUpperCase();
      if (code && parsePropertyCode(code) && !knownProperties.has(code))
        issue(
          IMPORT_SHEETS.units,
          row,
          'Property code',
          `Property ${code} is not on the Properties sheet or in the register`,
        );
    }
    const blocks = new Map(
      (
        await tx.execute<{ property_code: string; code: string; archived: boolean }>(
          sql`select p.code as property_code, b.code, b.archived_at is not null as archived
              from block b join property p on p.company_id = b.company_id and p.id = b.property_id`,
        )
      ).rows.map((b) => [`${b.property_code}-${b.code}`, b.archived]),
    );
    const existingUnits = new Map(
      (
        await tx
          .select({
            code: schema.unit.code,
            id: schema.unit.id,
            propertyId: schema.unit.propertyId,
            unitType: schema.unit.unitType,
            bedrooms: schema.unit.bedrooms,
            amenities: schema.unit.amenities,
            floor: schema.unit.floor,
            description: schema.unit.description,
            availability: schema.unit.availability,
            archivedAt: schema.unit.archivedAt,
          })
          .from(schema.unit)
      ).map((u) => [u.code, u]),
    );
    const meters = new Map(
      (
        await tx.execute<{
          key: string;
          type: string;
          property_code: string;
          unit_codes: string[];
        }>(
          sql`select m.utility || '|' || lower(m.supplier) || '|' || m.meter_number as key, m.meter_type as type,
                p.code as property_code,
                array(select u.code from unit_meter um join unit u on u.company_id = um.company_id and u.id = um.unit_id
                      where um.company_id = m.company_id and um.meter_id = m.id) as unit_codes
              from meter m join property p on p.company_id = m.company_id and p.id = m.property_id
              where m.archived_at is null`,
        )
      ).rows.map((m) => [m.key, m]),
    );
    const U = IMPORT_SHEETS.units;
    for (const row of unitRows) {
      if (!knownProperties.has(row.propertyCode)) {
        issue(
          U,
          row.row,
          'Property code',
          `Property ${row.propertyCode} is not on the Properties sheet or in the register`,
        );
        continue;
      }
      const blockKey = `${row.propertyCode}-${row.blockCode}`;
      if (blocks.get(blockKey) === true) {
        issue(U, row.row, 'Block code', `Block ${row.blockCode} is archived`);
        continue;
      }
      if (!blocks.has(blockKey) && !plan.blocksToCreate.has(blockKey))
        plan.blocksToCreate.set(blockKey, {
          propertyCode: row.propertyCode,
          code: row.blockCode,
          name: row.blockName,
        });
      const existing = existingUnits.get(row.code);
      if (existing?.archivedAt) {
        issue(U, row.row, 'Unit', `Unit ${row.code} is archived; its code is never reused`);
        continue;
      }
      if (existing) {
        if (existing.availability !== row.availability) {
          try {
            checkAvailabilityChange(existing.availability as Availability, row.availability, {
              occupied: false,
            });
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            issue(U, row.row, 'Availability', error.message);
          }
        }
        const changed =
          !same(existing.unitType, row.type) ||
          !same(existing.bedrooms, row.bedrooms) ||
          existing.amenities.join(',') !== row.amenities.join(',') ||
          !same(existing.floor, row.floor) ||
          !same(existing.description, row.description) ||
          !same(existing.availability, row.availability);
        if (changed) plan.unitsToUpdate.push({ unit: existing, row });
        else plan.unitsUnchanged += 1;
      } else plan.unitsToCreate.push(row);
      for (const m of row.meters) {
        const key = meterKey(m.utility, m.supplier, m.number);
        const found = meters.get(key);
        const planned = plan.metersToCreate.get(key);
        const type = found?.type ?? planned?.type ?? m.type;
        if (found && found.property_code !== row.propertyCode) {
          issue(
            U,
            row.row,
            m.utility === 'electricity' ? 'Electricity meter' : 'Water meter',
            'This meter belongs to another property',
          );
          continue;
        }
        if (type !== m.type) {
          issue(
            U,
            row.row,
            m.utility === 'electricity' ? 'Electricity meter type' : 'Water meter type',
            `This meter is ${type}`,
          );
          continue;
        }
        if (!found && !planned)
          plan.metersToCreate.set(key, {
            propertyCode: row.propertyCode,
            utility: m.utility,
            number: m.number,
            type: m.type,
            supplier: m.supplier,
          });
        const links = plan.meterLinks.get(key) ?? new Set(found?.unit_codes ?? []);
        links.add(row.code);
        plan.meterLinks.set(key, links);
        if (type !== 'shared' && links.size > 1)
          issue(
            U,
            row.row,
            m.utility === 'electricity' ? 'Electricity meter' : 'Water meter',
            'Only a shared meter can serve more than one unit',
          );
      }
    }
    return plan;
  }

  /** Writes the plan. Runs in the commit transaction; codes come from the file and never change. */
  private async apply(tx: Tx, companyId: string, personId: string, plan: Plan): Promise<void> {
    const portfolioId = await this.register.defaultPortfolio(tx, companyId);
    const propertyIds = new Map(
      (
        await tx
          .select({ id: schema.property.id, code: schema.property.code })
          .from(schema.property)
      ).map((p) => [p.code, p.id]),
    );
    const today = this.register.today();
    for (const row of plan.propertiesToCreate) {
      const address = await this.register.checkAddress(tx, companyId, {
        ghanapostGps: row.gps,
        region: row.region,
        district: row.district,
        mmda: row.mmda,
        town: row.town,
        street: row.street,
        latitude: row.pin?.latitude ?? null,
        longitude: row.pin?.longitude ?? null,
      });
      const id = await this.register.insertProperty(tx, companyId, {
        portfolioId,
        code: row.code,
        name: row.name,
        propertyType: row.type,
        use: row.use,
        address,
      });
      propertyIds.set(row.code, id);
      const owner = plan.ownerByProperty.get(row.code);
      const ownerId =
        owner === 'landlord' || !owner ? await this.owners.landlordOwner(tx, companyId) : owner;
      if (!ownerId) throw new Error(`no owner for ${row.code}`);
      await tx.insert(schema.propertyOwnership).values({
        companyId,
        propertyId: id,
        ownerId,
        shareBps: WHOLE_PROPERTY_BPS,
        effectiveFrom: today,
        recordedBy: personId,
      });
    }
    for (const { id, row } of plan.propertiesToUpdate) {
      const address = await this.register.checkAddress(tx, companyId, {
        ghanapostGps: row.gps,
        region: row.region,
        district: row.district,
        mmda: row.mmda,
        town: row.town,
        street: row.street,
        latitude: row.pin?.latitude ?? null,
        longitude: row.pin?.longitude ?? null,
      });
      await tx
        .update(schema.property)
        .set({
          name: row.name,
          propertyType: row.type,
          use: row.use,
          ...address,
          updatedAt: new Date(),
        })
        .where(eq(schema.property.id, id));
    }
    for (const block of plan.blocksToCreate.values()) {
      const propertyId = propertyIds.get(block.propertyCode)!;
      await this.register.insertBlock(tx, companyId, propertyId, {
        code: block.code,
        name: block.name,
        isDefault: false,
      });
    }
    const blockIds = new Map(
      (
        await tx.execute<{ key: string; id: string }>(
          sql`select p.code || '-' || b.code as key, b.id from block b
              join property p on p.company_id = b.company_id and p.id = b.property_id`,
        )
      ).rows.map((b) => [b.key, b.id]),
    );
    if (plan.unitsToCreate.length)
      await tx.insert(schema.unit).values(
        plan.unitsToCreate.map((row) => ({
          companyId,
          propertyId: propertyIds.get(row.propertyCode)!,
          blockId: blockIds.get(`${row.propertyCode}-${row.blockCode}`)!,
          code: row.code,
          label: row.label,
          unitType: row.type,
          bedrooms: row.bedrooms,
          billingBand: defaultBandFor(row.type),
          availability: row.availability,
          floor: row.floor,
          description: row.description,
          amenities: row.amenities,
        })),
      );
    for (const { unit, row } of plan.unitsToUpdate) {
      const typeChanged = unit.unitType !== row.type;
      await tx
        .update(schema.unit)
        .set({
          unitType: row.type,
          bedrooms: row.bedrooms,
          ...(typeChanged
            ? { billingBand: defaultBandFor(row.type), bandOverrideReason: null }
            : {}),
          amenities: row.amenities,
          floor: row.floor,
          description: row.description,
          availability: row.availability,
          updatedAt: new Date(),
        })
        .where(eq(schema.unit.id, unit.id));
    }
    const unitIds = new Map(
      (await tx.select({ id: schema.unit.id, code: schema.unit.code }).from(schema.unit)).map(
        (u) => [u.code, u.id],
      ),
    );
    const meterIds = new Map(
      (
        await tx.execute<{ key: string; id: string }>(
          sql`select utility || '|' || lower(supplier) || '|' || meter_number as key, id from meter where archived_at is null`,
        )
      ).rows.map((m) => [m.key, m.id]),
    );
    for (const [key, m] of plan.metersToCreate) {
      const id = await this.meters.insert(tx, companyId, propertyIds.get(m.propertyCode)!, {
        utility: m.utility,
        supplier: m.supplier,
        meterNumber: m.number,
        meterType: m.type as 'prepaid' | 'postpaid' | 'shared',
      });
      meterIds.set(key, id);
    }
    for (const [key, codes] of plan.meterLinks) {
      const meterId = meterIds.get(key)!;
      const [meter] = await tx
        .select({ propertyId: schema.meter.propertyId })
        .from(schema.meter)
        .where(and(eq(schema.meter.id, meterId)));
      await this.meters.link(
        tx,
        companyId,
        meter!.propertyId,
        meterId,
        [...codes].map((c) => unitIds.get(c)!),
      );
    }
  }
}
