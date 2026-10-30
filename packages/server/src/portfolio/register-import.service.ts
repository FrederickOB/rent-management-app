import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { DomainError } from '@rent/domain/errors';
import type { Actor, ScopeIds } from '@rent/domain/policy';
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
  propertyFieldsAfterImport,
  REGISTER_IMPORT_MAX_BYTES,
  UNIT_COLUMNS,
  UNIT_TYPE_LABELS,
  unitFieldsAfterImport,
  WHOLE_PROPERTY_BPS,
  XLSX_CONTENT_TYPE,
  type Amenity,
  type Availability,
  type ImportIssue,
  type PropertyImportFields,
  type PropertyImportRow,
  type PropertyType,
  type PropertyUse,
  type UnitImportFields,
  type UnitImportRow,
  type UnitType,
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
import { declaredUncompressedSize, inflatedSize } from './zip-guard';

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

/** Shown when a job gave up after its last retry. The commit is one transaction, so nothing changed. */
const COMMIT_ABANDONED = 'The import could not be completed, and nothing was changed.';
const VALIDATION_ABANDONED = 'The file could not be checked.';

/**
 * The scope an import job runs with (AD-02): the person's, captured by the policy when they
 * started the check or the commit. Null means the whole company.
 */
export interface ImportJobOptions {
  readonly scope?: ScopeIds | null;
}

export interface CommitJobOptions extends ImportJobOptions {
  /**
   * The check this commit was started from: its validatedAt time in milliseconds. A commit job
   * left over from an earlier check does nothing.
   */
  readonly attempt?: number;
}

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

/**
 * Property codes and meter numbers taken anywhere in the company, archived and out-of-scope ones
 * included. Both are unique across the company, so a scoped import must not plan to create one
 * that exists where it cannot see. Only the fact that each is taken is used.
 */
interface Taken {
  readonly propertyCodes: ReadonlySet<string>;
  readonly meterKeys: ReadonlySet<string>;
}

interface Plan {
  readonly propertiesToCreate: PropertyImportRow[];
  readonly propertiesToUpdate: {
    id: string;
    before: PropertyImportFields;
    next: PropertyImportFields;
  }[];
  propertiesUnchanged: number;
  readonly ownerByProperty: Map<string, string | 'landlord'>;
  readonly blocksToCreate: Map<string, { propertyCode: string; code: string; name: string | null }>;
  readonly unitsToCreate: UnitImportRow[];
  readonly unitsToUpdate: { unit: ExistingUnit; next: UnitImportFields }[];
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

/** Said for a row about a property outside the person's scope; it reveals nothing more (AD-02). */
const notYours = (code: string) => `${code} is not a property you can manage`;

type PropertyRecord = typeof schema.property.$inferSelect;

const propertyFields = (p: PropertyRecord): PropertyImportFields => ({
  name: p.name,
  type: p.propertyType as PropertyType,
  use: p.use as PropertyUse,
  gps: p.ghanapostGps,
  region: p.region,
  district: p.district,
  mmda: p.mmda,
  town: p.town,
  street: p.street,
  pin:
    p.latitude !== null && p.longitude !== null
      ? { latitude: p.latitude, longitude: p.longitude }
      : null,
});

const addressChanged = (a: PropertyImportFields, b: PropertyImportFields) =>
  !same(a.gps, b.gps) ||
  a.region !== b.region ||
  !same(a.district, b.district) ||
  !same(a.mmda, b.mmda) ||
  !same(a.town, b.town) ||
  !same(a.street, b.street) ||
  !samePin(a.pin?.latitude ?? null, b.pin?.latitude ?? null) ||
  !samePin(a.pin?.longitude ?? null, b.pin?.longitude ?? null);

const propertyChanged = (a: PropertyImportFields, b: PropertyImportFields) =>
  a.name !== b.name || a.type !== b.type || a.use !== b.use || addressChanged(a, b);

const unitFields = (u: ExistingUnit): UnitImportFields => ({
  type: u.unitType as UnitType,
  bedrooms: u.bedrooms,
  amenities: u.amenities as Amenity[],
  floor: u.floor,
  description: u.description,
  availability: u.availability as Availability,
});

const unitChanged = (a: UnitImportFields, b: UnitImportFields) =>
  a.type !== b.type ||
  !same(a.bedrooms, b.bedrooms) ||
  a.amenities.join(',') !== b.amenities.join(',') ||
  !same(a.floor, b.floor) ||
  !same(a.description, b.description) ||
  a.availability !== b.availability;

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
 * nothing, and an import never changes a code or deletes anything. Both jobs run with the scope
 * of the person who started them, so a scoped manager imports only their owners' properties.
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
    const scope = this.policy.scopeFor(staff);
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
        payload: { importId, scope },
        idempotencyKey: `${VALIDATE_IMPORT_JOB}:${importId}:${this.clock.now().getTime()}`,
      });
    });
    return this.get(staff, importId);
  }

  /**
   * Commits a validated import (worker job). The same person who checked it commits it. The job
   * is keyed by the check it follows: committing one check twice runs once, and an import
   * checked again after a failed commit can still be committed.
   */
  async startCommit(actor: Actor | null, importId: string): Promise<RegisterImportView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.import');
    const scope = this.policy.scopeFor(staff);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const found = await this.mine(tx, staff.personId, importId);
      if (found.status !== 'validated' || !found.validatedAt)
        throw invalid(
          'import_not_validated',
          'Check the file, and fix every problem, before importing it',
        );
      const attempt = found.validatedAt.getTime();
      await tx
        .update(schema.registerImport)
        .set({ status: 'committing', error: null, updatedAt: new Date() })
        .where(eq(schema.registerImport.id, importId));
      await enqueueOutbox(tx, {
        companyId: staff.companyId,
        type: COMMIT_IMPORT_JOB,
        payload: { importId, attempt, scope },
        idempotencyKey: `${COMMIT_IMPORT_JOB}:${importId}:${attempt}`,
      });
    });
    return this.get(staff, importId);
  }

  /** An import and its report, for the person who uploaded it only. */
  async get(actor: Actor | null, importId: string): Promise<RegisterImportView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'register.import');
    const row = await withCompany(this.database, staffContext(staff), (tx) =>
      this.mine(tx, staff.personId, importId),
    );
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

  /**
   * The dry run: reads the file and checks every row, under the scope of the person who started
   * it (AD-02); writes only the report.
   */
  async validate(
    companyId: string,
    importId: string,
    options: ImportJobOptions = {},
  ): Promise<void> {
    const loaded = await this.load(companyId, importId, 'validating');
    if (!loaded) return;
    const { row, file, sha256 } = loaded;
    const taken = await this.takenInCompany(companyId);
    const scope = options.scope ?? null;
    const report = await withCompany(
      this.database,
      { companyId, personId: row.createdBy, actorKind: 'system', scope },
      async (tx) =>
        (await this.check(tx, companyId, row.fileName, file, sha256, { taken, scope })).report,
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
        .where(
          and(
            eq(schema.registerImport.id, importId),
            eq(schema.registerImport.status, 'validating'),
          ),
        ),
    );
  }

  /**
   * Applies a validated import in one transaction, as the person who started it and under their
   * scope. The file is checked again first: if its bytes or the register changed and a row no
   * longer passes, nothing is written and the import goes back to "invalid" with the new report.
   * Any other failure rolls everything back and the job retries; after the last retry the import
   * is marked failed (commitAbandoned).
   */
  async commit(companyId: string, importId: string, options: CommitJobOptions = {}): Promise<void> {
    const loaded = await this.load(companyId, importId, 'committing');
    if (!loaded) return;
    const { row, file, sha256 } = loaded;
    if (!this.isAttempt(row, options.attempt)) return;
    if (row.fileSha256 && row.fileSha256 !== sha256) {
      await this.finish(
        companyId,
        importId,
        'failed',
        null,
        'The file changed after it was checked',
        {
          from: 'committing',
        },
      );
      return;
    }
    const taken = await this.takenInCompany(companyId);
    const scope = options.scope ?? null;
    const ctx = { companyId, personId: row.createdBy, actorKind: 'system' as const, scope };
    const outcome = await withCompany(this.database, ctx, async (tx) => {
      // Locked and read again, so a job delivered twice applies the import once.
      const [current] = await tx
        .select()
        .from(schema.registerImport)
        .where(eq(schema.registerImport.id, importId))
        .for('update');
      if (!current || current.status !== 'committing' || !this.isAttempt(current, options.attempt))
        return { outcome: 'skipped' as const };
      const { plan, report } = await this.check(tx, companyId, row.fileName, file, sha256, {
        taken,
        scope,
      });
      if (report.issueCount > 0) return { outcome: 'invalid' as const, report };
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
      return { outcome: 'committed' as const };
    });
    if (outcome.outcome === 'invalid')
      await this.finish(companyId, importId, 'invalid', outcome.report, null, {
        from: 'committing',
      });
  }

  /**
   * The commit job failed its last retry (the job's dead-letter step). The commit is one
   * transaction, so nothing was written; the import says so and can be checked again.
   */
  async commitAbandoned(companyId: string, importId: string, attempt?: number): Promise<void> {
    await this.abandon(companyId, importId, 'committing', COMMIT_ABANDONED, attempt);
  }

  /** The check job failed its last retry: the import can be checked again. */
  async validationAbandoned(companyId: string, importId: string): Promise<void> {
    await this.abandon(companyId, importId, 'validating', VALIDATION_ABANDONED);
  }

  private async abandon(
    companyId: string,
    importId: string,
    status: ImportStatus,
    error: string,
    attempt?: number,
  ): Promise<void> {
    await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.registerImport)
        .where(eq(schema.registerImport.id, importId))
        .for('update');
      if (!current || current.status !== status || !this.isAttempt(current, attempt)) return;
      await tx
        .update(schema.registerImport)
        .set({ status: 'failed', error, updatedAt: new Date() })
        .where(eq(schema.registerImport.id, importId));
    });
  }

  /** Whether an import is still at the check a commit job was started from. */
  private isAttempt(row: { validatedAt: Date | null }, attempt: number | undefined): boolean {
    return attempt === undefined || row.validatedAt?.getTime() === attempt;
  }

  private async load(companyId: string, importId: string, status: ImportStatus) {
    const [row] = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx.select().from(schema.registerImport).where(eq(schema.registerImport.id, importId)),
    );
    if (!row || row.status !== status) return null;
    const bucket = this.config.S3_BUCKET_FILES;
    const head = await this.storage.head({ bucket, key: row.storageKey });
    if (!head) {
      await this.finish(companyId, importId, 'failed', null, 'The file was not uploaded', {
        from: status,
      });
      return null;
    }
    if (head.size > REGISTER_IMPORT_UPLOAD.maxBytes) {
      await this.finish(companyId, importId, 'failed', null, 'The file is larger than 5 MB', {
        from: status,
      });
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
    options: { readonly from: ImportStatus },
  ): Promise<void> {
    await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.registerImport)
        .set({ status, ...(report ? { report } : {}), error, updatedAt: new Date() })
        .where(
          and(
            eq(schema.registerImport.id, importId),
            eq(schema.registerImport.status, options.from),
          ),
        ),
    );
  }

  /**
   * Every property code and meter number in the company, archived ones and those outside any
   * scope included (see Taken). Read without a scope; only membership of the sets is used.
   */
  private async takenInCompany(companyId: string): Promise<Taken> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const properties = await tx.select({ code: schema.property.code }).from(schema.property);
      const meters = await tx.execute<{ key: string }>(
        sql`select utility || '|' || lower(supplier) || '|' || meter_number as key from meter`,
      );
      return {
        propertyCodes: new Set(properties.map((p) => p.code)),
        meterKeys: new Set(meters.rows.map((m) => m.key)),
      };
    });
  }

  /** Parses the workbook and checks every row against the domain rules and the register. */
  private async check(
    tx: Tx,
    companyId: string,
    fileName: string | null,
    file: Buffer,
    sha256: string,
    context: { readonly taken: Taken; readonly scope: ScopeIds | null },
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
    const plan = await this.plan(
      tx,
      companyId,
      properties.rows,
      units.rows,
      issues,
      { properties: sheets.properties.rows, units: sheets.units.rows },
      { taken: context.taken, scoped: context.scope !== null },
    );
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
    const tooLarge = 'This workbook is too large once unpacked';
    // A fast first pass on the sizes the zip declares, then the sizes it really inflates to,
    // since a crafted file can understate them.
    const size = declaredUncompressedSize(file);
    if (size === null) {
      whole('This is not an Excel workbook (.xlsx)');
      return { properties: none, units: none };
    }
    if (size > MAX_UNCOMPRESSED_BYTES) {
      whole(tooLarge);
      return { properties: none, units: none };
    }
    const inflated = inflatedSize(file, MAX_UNCOMPRESSED_BYTES);
    if (!inflated.ok) {
      whole(inflated.problem === 'too_large' ? tooLarge : 'This workbook could not be read');
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

  /**
   * The database checks: owners, existing codes, blocks, availability changes and meter links.
   * It reads the register through the job's scope, so a scoped person's rows can name only the
   * properties and owners they manage; anything else is a row error that reveals nothing more.
   */
  private async plan(
    tx: Tx,
    companyId: string,
    propertyRows: PropertyImportRow[],
    unitRows: UnitImportRow[],
    issues: ImportIssue[],
    raw: { properties: SheetRows; units: SheetRows },
    context: { readonly taken: Taken; readonly scoped: boolean },
  ): Promise<Plan> {
    const { taken, scoped } = context;
    const issue = (sheet: string, row: number, column: string, message: string) =>
      issues.push({ sheet, row, column, message });
    const unknownOwner = (reference: string) =>
      scoped
        ? `${reference} is not an owner you can manage`
        : `No owner has the reference ${reference}`;
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
    // A code that exists in the company but not in what this person can see.
    const outOfScope = (code: string) =>
      !existingProperties.has(code) && taken.propertyCodes.has(code);
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
      if (outOfScope(row.code)) {
        issue(P, row.row, 'Property code', notYours(row.code));
        continue;
      }
      let ownerId: string | 'landlord' | null = null;
      if (row.ownerReference) {
        ownerId = owners.get(row.ownerReference) ?? null;
        if (!ownerId) issue(P, row.row, 'Owner reference', unknownOwner(row.ownerReference));
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
      } else if (owners.size === 1) ownerId = owners.values().next().value!;
      else if (!scoped) ownerId = 'landlord';
      else if (!existing)
        // A scoped person never creates the landlord's own owner record.
        issue(P, row.row, 'Owner reference', 'You can add a property only for an owner you manage');
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
        // Blank optional cells leave the property as it is (re-import).
        const before = propertyFields(existing);
        const next = propertyFieldsAfterImport(before, row);
        if (propertyChanged(before, next))
          plan.propertiesToUpdate.push({ id: existing.id, before, next });
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
      const code = cellText(values.code)?.toUpperCase();
      if (code && outOfScope(code)) issue(P, row, 'Property code', notYours(code));
      const text = cellText(values.owner);
      if (!text) continue;
      try {
        const reference = checkOwnerReference(text);
        if (!owners.has(reference)) issue(P, row, 'Owner reference', unknownOwner(reference));
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
        .filter((c): c is string => !!c && !outOfScope(c)),
    ]);
    const U = IMPORT_SHEETS.units;
    const checkedUnits = new Set(unitRows.map((r) => r.row));
    for (const { row, values } of raw.units) {
      if (checkedUnits.has(row)) continue;
      const code = cellText(values.property)?.toUpperCase();
      if (!code || !parsePropertyCode(code)) continue;
      if (outOfScope(code)) issue(U, row, 'Property code', notYours(code));
      else if (!knownProperties.has(code))
        issue(
          U,
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
    // Archived meters too: their numbers stay taken (meter_number_key covers them).
    const meters = new Map(
      (
        await tx.execute<{
          key: string;
          type: string;
          property_code: string;
          archived: boolean;
          unit_codes: string[];
        }>(
          sql`select m.utility || '|' || lower(m.supplier) || '|' || m.meter_number as key, m.meter_type as type,
                p.code as property_code, m.archived_at is not null as archived,
                array(select u.code from unit_meter um join unit u on u.company_id = um.company_id and u.id = um.unit_id
                      where um.company_id = m.company_id and um.meter_id = m.id) as unit_codes
              from meter m join property p on p.company_id = m.company_id and p.id = m.property_id`,
        )
      ).rows.map((m) => [m.key, m]),
    );
    for (const row of unitRows) {
      if (outOfScope(row.propertyCode)) {
        issue(U, row.row, 'Property code', notYours(row.propertyCode));
        continue;
      }
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
        // Blank optional cells leave the unit as it is: a blank availability never resets it.
        const before = unitFields(existing);
        const next = unitFieldsAfterImport(before, row);
        if (existing.availability !== next.availability) {
          try {
            checkAvailabilityChange(existing.availability as Availability, next.availability, {
              occupied: false,
            });
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            issue(U, row.row, 'Availability', error.message);
          }
        }
        if (unitChanged(before, next)) plan.unitsToUpdate.push({ unit: existing, next });
        else plan.unitsUnchanged += 1;
      } else plan.unitsToCreate.push(row);
      for (const m of row.meters) {
        const key = meterKey(m.utility, m.supplier, m.number);
        const column = m.utility === 'electricity' ? 'Electricity meter' : 'Water meter';
        const found = meters.get(key);
        if (found?.archived) {
          issue(U, row.row, column, 'An archived meter has this number. Use another number.');
          continue;
        }
        if (!found && taken.meterKeys.has(key)) {
          // In the company, but on a property this person cannot see.
          issue(U, row.row, column, 'This meter belongs to another property');
          continue;
        }
        const planned = plan.metersToCreate.get(key);
        const type = found?.type ?? planned?.type ?? m.type;
        if (found && found.property_code !== row.propertyCode) {
          issue(U, row.row, column, 'This meter belongs to another property');
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
          issue(U, row.row, column, 'Only a shared meter can serve more than one unit');
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
    for (const { id, before, next } of plan.propertiesToUpdate) {
      // The address is written only when it changed, so its source (lookup or manual) stays.
      const address = addressChanged(before, next)
        ? await this.register.checkAddress(tx, companyId, {
            ghanapostGps: next.gps,
            region: next.region,
            district: next.district,
            mmda: next.mmda,
            town: next.town,
            street: next.street,
            latitude: next.pin?.latitude ?? null,
            longitude: next.pin?.longitude ?? null,
          })
        : {};
      await tx
        .update(schema.property)
        .set({
          name: next.name,
          propertyType: next.type,
          use: next.use,
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
    for (const { unit, next } of plan.unitsToUpdate) {
      const typeChanged = unit.unitType !== next.type;
      await tx
        .update(schema.unit)
        .set({
          unitType: next.type,
          bedrooms: next.bedrooms,
          ...(typeChanged
            ? { billingBand: defaultBandFor(next.type), bandOverrideReason: null }
            : {}),
          amenities: [...next.amenities],
          floor: next.floor,
          description: next.description,
          availability: next.availability,
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
