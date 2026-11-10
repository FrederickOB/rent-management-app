import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import { RENT_CYCLE_LABELS, RENT_CYCLES } from '@rent/domain/tenancy';
import {
  OPENING_BALANCES_APPROVAL,
  openingOwnerTotals,
  type OnboardingBatchKind,
  type OnboardingStep,
} from '@rent/domain/onboarding';
import type { Actor, StaffRole } from '@rent/domain/policy';
import { XLSX_CONTENT_TYPE } from '@rent/domain/portfolio';
import type { StoragePort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service';
import { BillingEngine } from '../billing/engine';
import { MONEY_APPROVERS } from '../billing/money.service';
import { isoNow } from '../billing/records';
import { companyRecord, staffActor, type StaffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, CONFIG, DATABASE, STORAGE_PORT } from '../core/tokens';
import { DocumentsService, LEASE_FILE_UPLOAD } from '../documents/documents.service';
import { PostingService } from '../ledger/posting.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import {
  REGISTER_IMPORT_UPLOAD,
  RegisterImportService,
} from '../portfolio/register-import.service';
import { RulesService } from '../rules/rules.service';
import { leaseRow } from '../tenancy/lease-records';
import { LeasesService } from '../tenancy/leases.service';
import { TenantsService } from '../tenancy/tenants.service';
import { checkBalances, type BalanceCheck } from './balances';
import { postBalancePlan } from './posting';
import {
  batchRow,
  batchViews,
  cutOverOf,
  emptyTotals,
  latestBatch,
  lockOnboarding,
  nothingToWrite,
  reportOf,
  settleClosedApprovals,
  withOnboardingChecks,
  type BatchReport,
  type BatchRow,
  type BatchView,
} from './records';
import { applyTenancies, checkTenancies } from './tenancies';
import { readWorkbook, workbookTemplate } from './workbook';

export const ONBOARDING_VALIDATE_JOB = 'onboarding.validate';
export const ONBOARDING_COMMIT_JOB = 'onboarding.commit';
export const ONBOARDING_POST_JOB = 'onboarding.post-balances';

/**
 * Who approves opening balances (founder decision 2, review round): the money approvers, owners,
 * agency admins, property managers and accountants; never the person who committed (AD-05).
 */
const OPENING_APPROVERS: readonly StaffRole[] = MONEY_APPROVERS;

const minor = z.number().int();
const openingTotals = z.object({
  arrearsMinor: minor,
  advancesMinor: minor,
  depositsMinor: minor,
  withholdingMinor: minor,
  agentCashMinor: minor,
  rentTaxOutstandingMinor: minor,
});

/**
 * The `opening_balances` request's payload (M11 review C2), what the approval card shows: the
 * batch, its cut-over and file, where to check it, how many leases, each owner's share and the
 * totals. The same shape as the contract's `openingBalancesApprovalSchema`.
 */
export const openingApprovalSchema = z.object({
  batchId: z.string().uuid(),
  kind: z.enum(['balances', 'adjustment']),
  cutOverDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fileName: z.string().nullable(),
  link: z.literal('/onboarding'),
  leases: minor,
  owners: z.array(
    openingTotals.extend({ owner: z.object({ id: z.string().uuid(), name: z.string() }) }),
  ),
  totals: openingTotals,
});
export type OpeningApprovalPayload = z.infer<typeof openingApprovalSchema>;

/**
 * A batch's approval payload, from its row and its validation's report; owners named as given.
 * At the decision the engine rebuilds it from the batch (`currentPayload`) and compares hashes, so
 * a batch whose figures changed is never approved as asked.
 */
export function openingApprovalPayload(
  row: Pick<BatchRow, 'id' | 'kind' | 'cutOverDate' | 'fileName' | 'report'>,
  names: ReadonlyMap<string, string>,
): OpeningApprovalPayload {
  const report = row.report as BatchReport | null;
  const summary = report?.summary ?? { leases: 0, owners: [] };
  return {
    batchId: row.id,
    kind: row.kind === 'adjustment' ? 'adjustment' : 'balances',
    cutOverDate: row.cutOverDate ?? '',
    fileName: row.fileName,
    link: '/onboarding',
    leases: summary.leases,
    owners: summary.owners.map(({ ownerId, ...figures }) => ({
      owner: { id: ownerId, name: names.get(ownerId) ?? '' },
      ...figures,
    })),
    totals: report?.totals ?? emptyTotals(),
  };
}

/** Shown when a job gave up after its last retry. Each write is one transaction: nothing changed. */
const VALIDATION_ABANDONED = 'The file could not be checked.';
const COMMIT_ABANDONED = 'The import could not be completed, and nothing was changed.';
const POST_ABANDONED = 'The opening balances could not be posted, and nothing was changed.';
const CHANGED = 'Something changed since the file was checked: check it again.';

export interface OnboardingState {
  readonly cutOverDate: string | null;
  readonly cutOverFixed: boolean;
  readonly steps: {
    readonly step: OnboardingStep;
    readonly status: 'not_started' | 'in_progress' | 'done';
    readonly lastBatchId: string | null;
  }[];
  readonly leasesMissingScan: number;
}

/**
 * Pilot onboarding (M11 decisions 2 and 3; P25): one screen, three steps, each previewed before
 * anything is written. Step 1 is the register import (PR-08) with its Owners sheet; step 2 the
 * Tenants and Leases sheets, written at once and never messaging a tenant; step 3 the opening
 * balances, dated the company's cut-over, committed through a second person
 * (`opening_balances`) and posted once approved; corrections come from an adjustment workbook of
 * signed changes. For company admins and unscoped managers (`onboarding.import`). Every job is
 * idempotent: a validation is keyed on its batch and validation, a commit on the validation it
 * follows, the posting on the batch and its approval.
 */
@Injectable()
export class OnboardingService implements OnModuleInit {
  private approvalsRegistered = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(LeasesService) private readonly leases: LeasesService,
    @Inject(RegisterImportService) private readonly registerImports: RegisterImportService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registerApprovals();
  }

  /**
   * The `opening_balances` approval (AD-05; OQ-29 for a single user, which the engine handles).
   * Its execute, in the transaction of the final approval, moves the batch to `posting` (RA124
   * checks the decision) and queues the posting job, which reads the workbook outside any
   * transaction and posts it in one.
   */
  registerApprovals(): void {
    if (this.approvalsRegistered) return;
    this.approvalsRegistered = true;
    this.approvals.register<OpeningApprovalPayload>({
      actionType: OPENING_BALANCES_APPROVAL,
      eligibleRoles: OPENING_APPROVERS,
      schema: openingApprovalSchema,
      onePerSubject: true,
      // Rebuilt from the batch as it is now, with the owners named as they were when asked (a
      // renamed owner never cancels the request; changed figures do).
      currentPayload: async (tx, request) => {
        const row = await batchRow(tx, request.subjectId);
        const asked = openingApprovalSchema.safeParse(request.payload);
        const names = new Map(
          asked.success ? asked.data.owners.map((o) => [o.owner.id, o.owner.name] as const) : [],
        );
        return openingApprovalPayload(row, names);
      },
      execute: async (tx, request, payload) => {
        const row = await batchRow(tx, payload.batchId, { lock: true });
        if (row.status !== 'awaiting_approval' || row.approvalRequestId !== request.id)
          throw conflict('batch_busy', 'This workbook is no longer waiting for this approval');
        await withOnboardingChecks(() =>
          tx
            .update(schema.onboardingBatch)
            .set({ status: 'posting', error: null, updatedAt: this.clock.now() })
            .where(eq(schema.onboardingBatch.id, row.id)),
        );
        await enqueueOutbox(tx, {
          companyId: row.companyId,
          type: ONBOARDING_POST_JOB,
          payload: { batchId: row.id },
          idempotencyKey: `${ONBOARDING_POST_JOB}:${row.id}:${request.id}`,
        });
      },
    });
  }

  // Reading ---------------------------------------------------------------------------------------

  private importer(actor: Actor | null): StaffActor {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'onboarding.import');
    return staff;
  }

  private system(companyId: string, personId?: string | null) {
    return { companyId, personId: personId ?? undefined, actorKind: 'system' as const };
  }

  private async todayOf(tx: Tx, companyId: string): Promise<string> {
    const company = await companyRecord(tx, companyId);
    if (!company) throw notFound('Company');
    return isoNow(this.clock, company.timeZone);
  }

  /** Batches whose approval closed without approval are rejected first (see records). */
  private async settle(companyId: string): Promise<void> {
    await withCompany(this.database, this.system(companyId), (tx) => settleClosedApprovals(tx));
  }

  async state(actor: Actor | null): Promise<OnboardingState> {
    const staff = this.importer(actor);
    await this.settle(staff.companyId);
    return withCompany(this.database, staffContext(staff), (tx) =>
      this.stateIn(tx, staff.companyId),
    );
  }

  private async stateIn(tx: Tx, companyId: string): Promise<OnboardingState> {
    const cutOver = await cutOverOf(tx, companyId);
    const [register] = await tx
      .select({ id: schema.registerImport.id })
      .from(schema.registerImport)
      .orderBy(desc(schema.registerImport.createdAt), desc(schema.registerImport.id))
      .limit(1);
    const [registered] = await tx
      .select({ id: schema.registerImport.id })
      .from(schema.registerImport)
      .where(eq(schema.registerImport.status, 'committed'))
      .limit(1);
    const done = async (kinds: OnboardingBatchKind[], statuses: string[]) =>
      (
        await tx
          .select({ id: schema.onboardingBatch.id })
          .from(schema.onboardingBatch)
          .where(
            and(
              inArray(schema.onboardingBatch.kind, kinds),
              inArray(schema.onboardingBatch.status, statuses),
            ),
          )
          .limit(1)
      ).length > 0;
    const tenancies = await latestBatch(tx, 'tenancies');
    const balances = await latestBatch(tx, 'balances');
    const step = (lastBatchId: string | null, isDone: boolean) => ({
      status: isDone
        ? ('done' as const)
        : lastBatchId
          ? ('in_progress' as const)
          : ('not_started' as const),
      lastBatchId,
    });
    return {
      cutOverDate: cutOver?.date ?? null,
      cutOverFixed: cutOver?.fixed ?? false,
      steps: [
        { step: 'register', ...step(register?.id ?? null, Boolean(registered)) },
        {
          step: 'tenancies',
          ...step(tenancies?.id ?? null, await done(['tenancies'], ['committed'])),
        },
        { step: 'balances', ...step(balances?.id ?? null, await done(['balances'], ['posted'])) },
      ],
      leasesMissingScan: Number(
        (
          await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from lease
                where imported_batch_id is not null and signed_document_id is null
                  and status <> 'cancelled'`,
          )
        ).rows[0]?.n ?? 0,
      ),
    };
  }

  async batches(actor: Actor | null, kind?: OnboardingBatchKind): Promise<BatchView[]> {
    const staff = this.importer(actor);
    await this.settle(staff.companyId);
    return withCompany(this.database, staffContext(staff), async (tx) =>
      batchViews(
        tx,
        await tx
          .select()
          .from(schema.onboardingBatch)
          .where(kind ? eq(schema.onboardingBatch.kind, kind) : undefined)
          .orderBy(desc(schema.onboardingBatch.createdAt), desc(schema.onboardingBatch.id))
          .limit(100),
      ),
    );
  }

  async batch(actor: Actor | null, batchId: string): Promise<BatchView> {
    const staff = this.importer(actor);
    await this.settle(staff.companyId);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [view] = await batchViews(tx, [await batchRow(tx, batchId)]);
      return view!;
    });
  }

  // The cut-over ------------------------------------------------------------------------------------

  /**
   * Sets the cut-over (decision 3): on or before today, in the company's time zone. It is fixed once
   * opening balances are posted (RA120), and, so that every imported lease bills from the period
   * it was imported for, once a tenancies workbook has been committed.
   */
  async setCutOver(actor: Actor | null, cutOverDate: string): Promise<OnboardingState> {
    const staff = this.importer(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const today = await this.todayOf(tx, staff.companyId);
      if (cutOverDate > today)
        throw invalid('cut_over_future', 'The cut-over is a day on or before today');
      const current = await cutOverOf(tx, staff.companyId);
      if (current?.date !== cutOverDate) {
        if (current?.fixed)
          throw conflict(
            'cut_over_fixed',
            'The cut-over is fixed once opening balances are posted',
          );
        const [committed] = await tx
          .select({ id: schema.onboardingBatch.id })
          .from(schema.onboardingBatch)
          .where(
            and(
              eq(schema.onboardingBatch.kind, 'tenancies'),
              eq(schema.onboardingBatch.status, 'committed'),
            ),
          )
          .limit(1);
        if (committed)
          throw conflict(
            'cut_over_fixed',
            'The cut-over is fixed once tenancies are imported: their billing starts from it',
          );
        const now = this.clock.now();
        await withOnboardingChecks(() =>
          tx
            .insert(schema.companyOnboarding)
            .values({
              companyId: staff.companyId,
              cutOverDate,
              setBy: staff.personId,
              setAt: now,
            })
            .onConflictDoUpdate({
              target: schema.companyOnboarding.companyId,
              set: { cutOverDate, setBy: staff.personId, setAt: now, updatedAt: now },
            }),
        );
      }
      return this.stateIn(tx, staff.companyId);
    });
  }

  // Templates and uploads ---------------------------------------------------------------------------

  /** A workbook template with a Lists sheet: the allowed values, the units and the owners. */
  async template(actor: Actor | null, kind: OnboardingBatchKind): Promise<Buffer> {
    const staff = this.importer(actor);
    const { units, owners } = await withCompany(this.database, staffContext(staff), async (tx) => ({
      units: (
        await tx
          .select({ code: schema.unit.code })
          .from(schema.unit)
          .where(isNull(schema.unit.archivedAt))
          .orderBy(schema.unit.code)
      ).map((u) => u.code),
      owners: (
        await tx
          .select({ reference: schema.owner.reference })
          .from(schema.owner)
          .where(isNull(schema.owner.archivedAt))
          .orderBy(schema.owner.reference)
      ).map((o) => o.reference),
    }));
    const lists: [string, string[]][] =
      kind === 'tenancies'
        ? [
            ['Kind', ['Individual', 'Company']],
            ['ID type', ['Ghana Card', 'Passport']],
            ['Consent', ['Yes', 'No']],
            ['Rent cycle', RENT_CYCLES.map((c) => RENT_CYCLE_LABELS[c])],
            ['Use', ['Residential', 'Commercial']],
            ['Unit', units],
          ]
        : [
            ['Kind', ['Rent', 'Service charge']],
            ['Unit', units],
            ['Owner reference', owners],
          ];
    return workbookTemplate(kind, lists);
  }

  /** Step 1's template: the register import's, with an Owners sheet first (agencies). */
  registerTemplate(actor: Actor | null): Promise<Buffer> {
    this.importer(actor);
    return this.registerImports.template(actor, { owners: true });
  }

  async createUpload(
    actor: Actor | null,
    input: {
      readonly kind: OnboardingBatchKind;
      readonly sizeBytes: number;
      readonly fileName?: string | null;
    },
  ) {
    const staff = this.importer(actor);
    const upload = await this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      REGISTER_IMPORT_UPLOAD,
      XLSX_CONTENT_TYPE,
      input.sizeBytes,
    );
    const batchId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [intent] = await tx
        .select({ storageKey: schema.uploadIntent.storageKey })
        .from(schema.uploadIntent)
        .where(eq(schema.uploadIntent.id, upload.uploadId));
      const [row] = await tx
        .insert(schema.onboardingBatch)
        .values({
          companyId: staff.companyId,
          kind: input.kind,
          uploadIntentId: upload.uploadId,
          storageKey: intent!.storageKey,
          fileName: input.fileName?.trim().slice(0, 200) || null,
          createdBy: staff.personId,
        })
        .returning({ id: schema.onboardingBatch.id });
      return row!.id;
    });
    return { batchId, upload };
  }

  // Validation --------------------------------------------------------------------------------------

  /**
   * Starts the dry run (worker job): nothing is written but the report. 409 STEP_ORDER when an
   * earlier step is missing: tenancies need the register's units, balances the leases, and an
   * adjustment opening balances already posted. Every step needs the cut-over.
   */
  async startValidation(actor: Actor | null, batchId: string): Promise<BatchView> {
    const staff = this.importer(actor);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await batchRow(tx, batchId, { lock: true });
      if (!['uploaded', 'invalid', 'failed', 'validated'].includes(row.status))
        throw conflict('batch_busy', 'This workbook is being checked, committed or posted already');
      const cutOver = await cutOverOf(tx, staff.companyId);
      if (!cutOver)
        throw conflict('cut_over_missing', 'Set the cut-over date before checking a workbook');
      await this.stepOrder(tx, row.kind as OnboardingBatchKind);
      const validationId = uuidv7();
      await withOnboardingChecks(() =>
        tx
          .update(schema.onboardingBatch)
          .set({
            status: 'validating',
            validationId,
            cutOverDate: cutOver.date,
            error: null,
            updatedAt: this.clock.now(),
          })
          .where(eq(schema.onboardingBatch.id, batchId)),
      );
      await enqueueOutbox(tx, {
        companyId: staff.companyId,
        type: ONBOARDING_VALIDATE_JOB,
        payload: { batchId, validationId },
        idempotencyKey: `${ONBOARDING_VALIDATE_JOB}:${batchId}:${validationId}`,
      });
    });
    return this.batch(staff, batchId);
  }

  private async stepOrder(tx: Tx, kind: OnboardingBatchKind): Promise<void> {
    const exists = async (query: ReturnType<typeof sql>) =>
      (await tx.execute<{ ok: boolean }>(sql`select exists (${query}) as ok`)).rows[0]?.ok ?? false;
    if (kind === 'tenancies') {
      if (!(await exists(sql`select 1 from unit where archived_at is null`)))
        throw conflict(
          'step_order',
          'Import the register (properties and units) before the tenancies',
        );
      return;
    }
    if (
      !(await exists(
        sql`select 1 from lease where status in ('signed', 'active', 'ending', 'holding_over')`,
      ))
    )
      throw conflict('step_order', 'Import the tenancies (tenants and leases) before the balances');
    if (
      kind === 'adjustment' &&
      !(await exists(
        sql`select 1 from onboarding_batch where kind = 'balances' and status = 'posted'`,
      ))
    )
      throw conflict(
        'step_order',
        'An adjustment corrects opening balances already posted; post the Balances workbook first',
      );
  }

  /** Reads a batch's file: what was uploaded, at most 5 MB, with its SHA-256. */
  private async file(
    row: BatchRow,
  ): Promise<{ file: Buffer; sha256: string } | { problem: string }> {
    const bucket = this.config.S3_BUCKET_FILES;
    const head = await this.storage.head({ bucket, key: row.storageKey });
    if (!head) return { problem: 'The file was not uploaded' };
    if (head.size > REGISTER_IMPORT_UPLOAD.maxBytes)
      return { problem: 'The file is larger than 5 MB' };
    const file = await this.storage.get({
      bucket,
      key: row.storageKey,
      versionId: head.versionId ?? undefined,
    });
    return { file, sha256: createHash('sha256').update(file).digest('hex') };
  }

  private async loadFor(companyId: string, batchId: string) {
    return withCompany(this.database, this.system(companyId), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.onboardingBatch)
        .where(eq(schema.onboardingBatch.id, batchId));
      return row ?? null;
    });
  }

  /** Moves a batch from one status to another, only if it is still there. */
  private async move(
    companyId: string,
    batchId: string,
    from: string,
    set: Partial<typeof schema.onboardingBatch.$inferInsert>,
    validationId?: string,
  ): Promise<void> {
    await withCompany(this.database, this.system(companyId), (tx) =>
      tx
        .update(schema.onboardingBatch)
        .set({ ...set, updatedAt: this.clock.now() })
        .where(
          and(
            eq(schema.onboardingBatch.id, batchId),
            eq(schema.onboardingBatch.status, from),
            validationId ? eq(schema.onboardingBatch.validationId, validationId) : undefined,
          ),
        ),
    );
  }

  /** Checks a workbook against the records, in the caller's transaction. */
  private async check(
    tx: Tx,
    row: BatchRow,
    file: Buffer,
    sha256: string,
    options: { readonly write?: boolean } = {},
  ): Promise<{
    report: BatchReport;
    balances: BalanceCheck | null;
    tenancies: Awaited<ReturnType<typeof checkTenancies>> | null;
  }> {
    const kind = row.kind as OnboardingBatchKind;
    const company = await companyRecord(tx, row.companyId);
    if (!company) throw notFound('Company');
    const today = isoNow(this.clock, company.timeZone);
    const cutOver = await cutOverOf(tx, row.companyId);
    const workbook = await readWorkbook(file, kind);
    if (!cutOver || (row.cutOverDate && cutOver.date !== row.cutOverDate))
      return {
        report: reportOf({
          sha256,
          counts: {},
          issues: [{ sheet: 'File', row: null, column: null, message: CHANGED }],
          totals: null,
        }),
        balances: null,
        tenancies: null,
      };
    if (kind === 'tenancies') {
      const result = await checkTenancies(
        tx,
        { tenants: this.tenants, leases: this.leases },
        { companyId: row.companyId, sheets: workbook.sheets, cutOver: cutOver.date, today },
      );
      return {
        report: reportOf({
          sha256,
          counts: result.counts,
          issues: [...workbook.issues, ...result.issues],
          totals: null,
        }),
        balances: null,
        tenancies: result,
      };
    }
    const result = await checkBalances(
      tx,
      { engine: this.engine, rules: this.rules },
      {
        companyId: row.companyId,
        companyKind: company.kind,
        countryCode: company.countryCode,
        batchId: row.id,
        mode: kind === 'adjustment' ? 'adjustment' : 'balances',
        sheets: workbook.sheets,
        cutOver: cutOver.date,
        today,
        write: options.write,
      },
    );
    return {
      report: reportOf({
        sha256,
        counts: result.counts,
        issues: [...workbook.issues, ...result.issues],
        totals: result.totals,
        summary: result.summary,
      }),
      balances: result,
      tenancies: null,
    };
  }

  /** `onboarding.validate`: the dry run, keyed on the batch and its validation. */
  async validate(companyId: string, batchId: string, validationId: string): Promise<void> {
    const row = await this.loadFor(companyId, batchId);
    if (!row || row.status !== 'validating' || row.validationId !== validationId) return;
    const loaded = await this.file(row);
    if ('problem' in loaded) {
      await this.move(
        companyId,
        batchId,
        'validating',
        { status: 'failed', error: loaded.problem },
        validationId,
      );
      return;
    }
    // Read only: the dry run writes nothing but its report.
    const { report } = await withCompany(
      this.database,
      this.system(companyId, row.createdBy),
      (tx) => this.check(tx, row, loaded.file, loaded.sha256),
      { accessMode: 'read only' },
    );
    await this.move(
      companyId,
      batchId,
      'validating',
      {
        status: report.issueCount === 0 ? 'validated' : 'invalid',
        fileSha256: loaded.sha256,
        report,
        validatedAt: this.clock.now(),
      },
      validationId,
    );
  }

  /** The validation job failed its last retry: the batch can be checked again. */
  async validationAbandoned(
    companyId: string,
    batchId: string,
    validationId: string,
  ): Promise<void> {
    await this.move(
      companyId,
      batchId,
      'validating',
      { status: 'failed', error: VALIDATION_ABANDONED },
      validationId,
    );
  }

  // The preview -------------------------------------------------------------------------------------

  /**
   * Balances and adjustments (decision 3): each lease as it will be after the commit, to check
   * against the landlord's own records, with totals per owner. For an adjustment, `before` holds
   * the figures today. 409 NOT_VALIDATED before a clean validation, and once posted.
   */
  async preview(actor: Actor | null, batchId: string) {
    const staff = this.importer(actor);
    const row = await withCompany(this.database, staffContext(staff), (tx) =>
      batchRow(tx, batchId),
    );
    if (row.kind === 'tenancies')
      throw conflict('not_balances', 'Tenancies have no opening balances to preview');
    if (!['validated', 'awaiting_approval'].includes(row.status) || !row.report)
      throw conflict(
        'not_validated',
        'Check the workbook, and fix every problem, before the preview',
      );
    const loaded = await this.file(row);
    if ('problem' in loaded) throw conflict('not_validated', loaded.problem);
    return withCompany(
      this.database,
      staffContext(staff),
      async (tx) => {
        const { balances } = await this.check(tx, row, loaded.file, loaded.sha256);
        if (!balances) throw conflict('not_validated', CHANGED);
        const ownerIds = [
          ...new Set([
            ...balances.leases.map((l) => l.ownerId),
            ...balances.owners.map((o) => o.ownerId),
          ]),
        ];
        const names = await ownerFacts(tx, ownerIds);
        const named = (id: string) => ({ id, name: names.get(id)?.displayName ?? '' });
        const adjusting = row.kind === 'adjustment';
        return {
          batchId,
          cutOverDate: row.cutOverDate!,
          leases: balances.leases.map((l) => ({
            leaseId: l.leaseId,
            unitCode: l.unitCode,
            tenantName: l.tenantName,
            owner: named(l.ownerId),
            after: l.after,
            before: adjusting ? l.before : null,
          })),
          owners: openingOwnerTotals({
            leases: balances.leases.map((l) => ({ ownerId: l.ownerId, figures: l.after })),
            owners: balances.owners.map((o) => ({
              ownerId: o.ownerId,
              agentCashMinor: o.agentCashMinor,
              rentTaxOutstandingMinor: o.rentTaxOutstandingMinor,
              rentTaxDueOn: o.rentTaxDueOn,
            })),
          }).map(({ ownerId, ...totals }) => ({ owner: named(ownerId), ...totals })),
        };
      },
      { accessMode: 'read only' },
    );
  }

  // Commit ------------------------------------------------------------------------------------------

  /**
   * Commits a validated batch. Tenancies: written at once by the commit job, never messaging a
   * tenant. Balances and adjustments: a second person is asked (`opening_balances`); they post
   * once approved. 409 HAS_ISSUES, NOT_VALIDATED (also when the cut-over moved since the check),
   * CUT_OVER_MISSING, NOTHING_TO_POST (every row is already recorded as it says).
   */
  async commit(
    actor: Actor | null,
    batchId: string,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<BatchView> {
    const staff = this.importer(actor);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      const row = await batchRow(tx, batchId, { lock: true });
      if (row.status !== 'validated' || !row.report || !row.validationId)
        throw conflict(
          'not_validated',
          'Check the workbook, and fix every problem, before committing it',
        );
      const report = row.report as BatchReport;
      if (report.issueCount > 0)
        throw conflict('has_issues', 'Fix every problem in the workbook and check it again');
      const cutOver = await cutOverOf(tx, staff.companyId);
      if (!cutOver) throw conflict('cut_over_missing', 'Set the cut-over date first');
      if (cutOver.date !== row.cutOverDate)
        throw conflict(
          'not_validated',
          'The cut-over changed after the check: check the workbook again',
        );
      if (row.kind === 'tenancies') {
        await withOnboardingChecks(() =>
          tx
            .update(schema.onboardingBatch)
            .set({ status: 'committing', error: null, updatedAt: this.clock.now() })
            .where(eq(schema.onboardingBatch.id, batchId)),
        );
        await enqueueOutbox(tx, {
          companyId: staff.companyId,
          type: ONBOARDING_COMMIT_JOB,
          payload: { batchId, validationId: row.validationId },
          idempotencyKey: `${ONBOARDING_COMMIT_JOB}:${batchId}:${row.validationId}`,
        });
      } else {
        if (nothingToWrite(report))
          throw conflict(
            'nothing_to_post',
            'Every row is already recorded as it says: nothing would change',
          );
        const owners = await ownerFacts(tx, report.summary?.owners.map((o) => o.ownerId) ?? []);
        const requestId = await this.approvals.createInTx(tx, staff, {
          actionType: OPENING_BALANCES_APPROVAL,
          subjectType: 'onboarding_batch',
          subjectId: batchId,
          payload: openingApprovalPayload(
            row,
            new Map([...owners].map(([id, o]) => [id, o.displayName])),
          ),
          propertyId: null,
        });
        await withOnboardingChecks(() =>
          tx
            .update(schema.onboardingBatch)
            .set({
              status: 'awaiting_approval',
              approvalRequestId: requestId,
              error: null,
              updatedAt: this.clock.now(),
            })
            .where(eq(schema.onboardingBatch.id, batchId)),
        );
      }
      await options.claim?.done(tx, { batchId });
    });
    return this.batch(staff, batchId);
  }

  /**
   * `onboarding.commit`: a validated tenancies workbook, in one transaction, as the person who
   * started it. The file is checked again first; if its bytes or the records changed and a row no
   * longer passes, nothing is written and the batch fails with the new report, to be checked again.
   */
  async commitTenancies(companyId: string, batchId: string, validationId: string): Promise<void> {
    const row = await this.loadFor(companyId, batchId);
    if (!row || row.status !== 'committing' || row.validationId !== validationId) return;
    const loaded = await this.file(row);
    if ('problem' in loaded || loaded.sha256 !== row.fileSha256) {
      await this.move(
        companyId,
        batchId,
        'committing',
        {
          status: 'failed',
          error: 'problem' in loaded ? loaded.problem : 'The file changed after it was checked',
        },
        validationId,
      );
      return;
    }
    // ID numbers and TINs are sealed in the commit's transaction: the company's key exists first.
    await this.tenants.ensureFieldKey(companyId);
    await withCompany(this.database, this.system(companyId, row.createdBy), async (tx) => {
      await lockOnboarding(tx, companyId);
      const current = await batchRow(tx, batchId, { lock: true });
      if (current.status !== 'committing' || current.validationId !== validationId)
        return 'skipped';
      const { report, tenancies } = await this.check(tx, current, loaded.file, loaded.sha256);
      if (report.issueCount > 0 || !tenancies) {
        await tx
          .update(schema.onboardingBatch)
          .set({ status: 'failed', report, error: CHANGED, updatedAt: this.clock.now() })
          .where(eq(schema.onboardingBatch.id, batchId));
        return 'changed';
      }
      await applyTenancies(
        tx,
        { tenants: this.tenants, leases: this.leases },
        { companyId, personId: row.createdBy },
        batchId,
        tenancies.plan,
      );
      await tx
        .update(schema.onboardingBatch)
        .set({
          status: 'committed',
          report,
          committedAt: this.clock.now(),
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.onboardingBatch.id, batchId));
      return 'committed';
    });
  }

  /** The commit job failed its last retry. One transaction: nothing was written. */
  async commitAbandoned(companyId: string, batchId: string, validationId: string): Promise<void> {
    await this.move(
      companyId,
      batchId,
      'committing',
      { status: 'failed', error: COMMIT_ABANDONED },
      validationId,
    );
  }

  /**
   * `onboarding.post-balances`, after the approval: reads the workbook (outside any transaction),
   * then in one transaction, under every lease's billing lock and the counters, checks it again
   * against the records (an item paid or drawn since may no longer pass), accrues each lease to
   * today, and posts every P25 entry with its records and items; the batch is then posted and the
   * cut-over fixed. A batch that no longer passes fails with the new report and posts nothing.
   * Idempotent: a posted batch, and every key, is left as it is.
   */
  async postBalances(companyId: string, batchId: string): Promise<'posted' | 'failed' | 'skipped'> {
    const row = await this.loadFor(companyId, batchId);
    if (!row || row.status !== 'posting') return 'skipped';
    const loaded = await this.file(row);
    if ('problem' in loaded || loaded.sha256 !== row.fileSha256) {
      await this.move(companyId, batchId, 'posting', {
        status: 'failed',
        error: 'problem' in loaded ? loaded.problem : 'The file changed after it was checked',
      });
      return 'failed';
    }
    const approver = await withCompany(this.database, this.system(companyId), async (tx) =>
      row.approvalRequestId ? await this.approvals.approverIn(tx, row.approvalRequestId) : null,
    );
    return withCompany(
      this.database,
      this.system(companyId, approver ?? row.createdBy),
      async (tx) => {
        await lockOnboarding(tx, companyId);
        const current = await batchRow(tx, batchId, { lock: true });
        if (current.status !== 'posting') return 'skipped' as const;
        const { report, balances } = await this.check(tx, current, loaded.file, loaded.sha256, {
          write: true,
        });
        if (report.issueCount > 0 || !balances) {
          // The accruals the check made are rolled back with the posting it refused: nothing stays.
          throw new PostingRefused(report);
        }
        await postBalancePlan(
          tx,
          { engine: this.engine, posting: this.posting },
          {
            companyId,
            batchId,
            cutOver: current.cutOverDate!,
            causedBy: approver,
            check: balances,
          },
        );
        const now = this.clock.now();
        await tx
          .update(schema.onboardingBatch)
          .set({ status: 'posted', report, committedAt: now, postedAt: now, updatedAt: now })
          .where(eq(schema.onboardingBatch.id, batchId));
        await tx
          .update(schema.companyOnboarding)
          .set({ fixedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.companyOnboarding.companyId, companyId),
              isNull(schema.companyOnboarding.fixedAt),
            ),
          );
        return 'posted' as const;
      },
    ).catch(async (error: unknown) => {
      if (!(error instanceof PostingRefused)) throw error;
      await this.move(companyId, batchId, 'posting', {
        status: 'failed',
        report: error.report,
        error: CHANGED,
      });
      return 'failed' as const;
    });
  }

  /** The posting job failed its last retry. One transaction: nothing was posted. */
  async postAbandoned(companyId: string, batchId: string): Promise<void> {
    await this.move(companyId, batchId, 'posting', { status: 'failed', error: POST_ABANDONED });
  }

  // Scans to follow (decision 2) ------------------------------------------------------------------

  /**
   * Attaches the scan of an imported paper lease, once (RA122): an upload from
   * `leases.createUpload`, stored write-once as the lease's signed copy. 409 SCAN_PRESENT.
   */
  async attachScan(
    actor: Actor | null,
    leaseId: string,
    scanUploadId: string,
  ): Promise<{ leaseId: string; scanDocumentId: string }> {
    const staff = this.importer(actor);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const lease = await leaseRow(tx, leaseId);
      if (!lease.importedBatchId)
        throw conflict('not_imported', 'Only an imported lease has its scan attached later');
      if (lease.signedDocumentId) throw conflict('scan_present', 'This lease already has its scan');
    });
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      scanUploadId,
      LEASE_FILE_UPLOAD,
    );
    const scanDocumentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const lease = await leaseRow(tx, leaseId, { lock: true });
      if (lease.signedDocumentId) throw conflict('scan_present', 'This lease already has its scan');
      const documentId = await this.documents.recordStagedEvidence(tx, staged, 'lease_scan');
      await withOnboardingChecks(() =>
        tx
          .update(schema.lease)
          .set({ signedDocumentId: documentId, updatedAt: this.clock.now() })
          .where(eq(schema.lease.id, leaseId)),
      );
      return documentId;
    });
    await this.documents.discardStagedUpload(staged);
    return { leaseId, scanDocumentId };
  }

  async leasesMissingScan(actor: Actor | null) {
    const staff = this.importer(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx.execute<{
        id: string;
        unit_code: string;
        tenant_name: string;
        start_date: string;
        imported_at: Date | string;
      }>(
        sql`select l.id, u.code as unit_code, coalesce(t.legal_name, t.display_name) as tenant_name,
              l.start_date::text as start_date, coalesce(b.committed_at, l.created_at) as imported_at
            from lease l
            join unit u on u.company_id = l.company_id and u.id = l.unit_id
            join tenant t on t.company_id = l.company_id and t.id = l.tenant_id
            join onboarding_batch b on b.company_id = l.company_id and b.id = l.imported_batch_id
            where l.signed_document_id is null and l.status <> 'cancelled'
            order by u.code, l.start_date`,
      );
      return rows.rows.map((r) => ({
        leaseId: r.id,
        unitCode: r.unit_code,
        tenantName: r.tenant_name,
        startDate: r.start_date,
        importedAt: new Date(r.imported_at),
      }));
    });
  }
}

/** A posting the records no longer allow: its transaction is rolled back, then the batch fails. */
class PostingRefused extends Error {
  constructor(readonly report: BatchReport) {
    super('The opening balances no longer pass their check');
  }
}
