import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import {
  DATA_PROTECTION_REQUEST_KINDS,
  DATA_PROTECTION_REQUEST_STATUSES,
  REQUEST_RESPONSE_DAYS_RULE,
  type DataProtectionRequestKind,
  type DataProtectionRequestStatus,
  type RetentionCategory,
} from '@rent/domain/data-protection';
import {
  addDays,
  businessDateOf,
  compareDates,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import {
  CONSENT_CHANNELS,
  consentText,
  consentTextVersion,
  type ConsentChannel,
} from '@rent/domain/messaging';
import type { Actor, PolicyAction } from '@rent/domain/policy';
import type { StoragePort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { sqlStateOf } from '../core/db-errors';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, CONFIG, DATABASE, STORAGE_PORT } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RulesService, type ResolvedRule } from '../rules/rules.service';
import { exportWorkbook, tenantExportIn } from './export';
import {
  anonymiseIdentityIn,
  anonymiseTenantIn,
  CATEGORY_ORDER,
  decide,
  NO_DATABASE_PATH,
  retainedUntil,
  retentionRulesIn,
  tenantRetentionFactsIn,
  webhookBodiesFor,
} from './retention';
import { zipArchive } from './zip';

/** The job that prepares an access request's export (plan 4.14; keyed by the export). */
export const DATA_PROTECTION_EXPORT_JOB = 'data-protection.export';
/** The daily job that deletes exports older than `EXPORT_KEEP_DAYS` (founder, review round). */
export const DATA_PROTECTION_EXPORT_CLEANUP_JOB = 'data-protection.export-cleanup';

/**
 * Founder decision 5 (M11 review round): an export is kept 7 days in the ordinary files bucket,
 * then deleted; the register keeps its fingerprint (the document's SHA-256) and who downloaded it
 * (the audit log). A product setting, not law. M12's bucket configuration adds the backstop: a
 * lifecycle rule expiring objects under `EXPORT_PREFIX/` (current and noncurrent versions) after
 * 7 days.
 */
export const EXPORT_KEEP_DAYS = 7;
export const EXPORT_PREFIX = 'data-protection-exports';
const KEEP_MS = EXPORT_KEEP_DAYS * 86_400_000;
/** The cleanup looks back this far, so a few missed days are caught up (the lifecycle rule is the backstop). */
const CLEANUP_LOOKBACK_MS = 30 * 86_400_000;

/**
 * M11 review B7: the archive is built in memory (the storage port has no streamed plain upload;
 * M12's streamed put removes this), so one archive holds at most this much of stored files,
 * counted from their recorded sizes. An access request is still always answered: over the cap,
 * the largest photos and recordings, then the largest other files, are left out until it fits,
 * and listed in the workbook with the record each belongs to (coordinator, review round; a
 * reversible default). Memory stays bounded by the cap.
 */
export const DEFAULT_MAX_EXPORT_BYTES = 100 * 1024 * 1024;
export interface DataProtectionLimits {
  readonly maxExportBytes: number;
}
export const DATA_PROTECTION_LIMITS = Symbol('DATA_PROTECTION_LIMITS');

type StaffActor = Extract<Actor, { kind: 'staff' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Export links last five minutes, like every other download. */
const DOWNLOAD_MS = 300_000;
const ZIP_CONTENT_TYPE = 'application/zip';
const CLOSED: readonly DataProtectionRequestStatus[] = ['completed', 'refused'];

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export interface DataProtectionExportView {
  readonly id: string;
  readonly status: 'preparing' | 'ready' | 'failed';
  /** A five-minute link, from `exportGet` only once ready; null in the register's lists. */
  readonly url: string | null;
  readonly expiresAt: Date | null;
  /** Once ready: whether files were left out to keep it under the cap, and how many (B7). */
  readonly split?: boolean;
  readonly leftOut?: number;
}

export interface HeldRecords {
  readonly category: RetentionCategory;
  readonly records: number;
  readonly until: string | null;
  readonly reason: string;
}

/** What an erasure did (`data_protection_request.result`). */
export interface ErasureResult {
  readonly assessedAt: string;
  readonly anonymised: readonly {
    readonly category: RetentionCategory;
    readonly records: number;
  }[];
  readonly held: readonly HeldRecords[];
}

export interface DataProtectionRequestView {
  readonly id: string;
  readonly tenant: { readonly id: string; readonly name: string };
  readonly kind: DataProtectionRequestKind;
  readonly receivedOn: string;
  readonly dueOn: string | null;
  readonly dueRuleUnverified: boolean;
  readonly status: DataProtectionRequestStatus;
  readonly notes: string | null;
  readonly outcome: string | null;
  readonly messagingStopped: boolean;
  readonly anonymised: ErasureResult['anonymised'];
  readonly held: ErasureResult['held'];
  readonly export: DataProtectionExportView | null;
  readonly createdBy: { readonly id: string; readonly name: string } | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

type RequestRow = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  kind: DataProtectionRequestKind;
  received_on: string;
  due_on: string | null;
  due_rule_id: string | null;
  rule_status: string | null;
  status: DataProtectionRequestStatus;
  notes: string | null;
  outcome: string | null;
  messaging_stopped_at: Date | string | null;
  result: ErasureResult | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  export_id: string | null;
  export_status: DataProtectionExportView['status'] | null;
  export_left_out: number | null;
};

const viewOf = (r: RequestRow): DataProtectionRequestView => ({
  id: r.id,
  tenant: { id: r.tenant_id, name: r.tenant_name },
  kind: r.kind,
  receivedOn: r.received_on,
  dueOn: r.due_on,
  dueRuleUnverified: r.due_rule_id === null || r.rule_status !== 'verified',
  status: r.status,
  notes: r.notes,
  outcome: r.outcome,
  messagingStopped: r.messaging_stopped_at !== null,
  anonymised: r.result?.anonymised ?? [],
  held: r.result?.held ?? [],
  export:
    r.export_id && r.export_status
      ? {
          id: r.export_id,
          status: r.export_status,
          url: null,
          expiresAt: null,
          ...splitOf(r.export_status, r.export_left_out),
        }
      : null,
  createdBy:
    r.created_by && r.created_by_name !== null
      ? { id: r.created_by, name: r.created_by_name }
      : null,
  createdAt: asDate(r.created_at),
  completedAt: r.completed_at === null ? null : asDate(r.completed_at),
});

/** A ready export's split: whether files were left out to stay under the cap, and how many. */
const splitOf = (
  status: DataProtectionExportView['status'],
  leftOut: number | null,
): { split?: boolean; leftOut?: number } =>
  status === 'ready' ? { split: Number(leftOut ?? 0) > 0, leftOut: Number(leftOut ?? 0) } : {};

/** A request closed by another transaction meanwhile (RA121) is the same 409 as one closed before. */
const closedConflict = () =>
  conflict('request_closed', 'This request is completed or refused and no longer changes.');
async function closedChecks<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (sqlStateOf(error) === 'RA121') throw closedConflict();
    throw error;
  }
}

/**
 * Data protection requests under Act 843 (M11 decision 5; prd-issues 30; NFR-DP). The landlord is
 * the controller, so the register is the company's, for company admins (`data_protection.manage`;
 * the export needs `data_protection.export`). Every change is row-audited by the database, and the
 * service adds semantic events. Nothing here logs a tenant's data.
 *
 * - **Due date:** from `data_protection.request_response_days` as of the day received, with the
 *   rule recorded; none while the row has no value (OQ-65).
 * - **Erasure:** messaging to the tenant (and their contacts) stops at once, on every channel:
 *   consent is withdrawn per channel with source `data_protection`, and the send job refuses
 *   anything for the tenant while the request stands (CM-09). A legal notice is never blocked:
 *   its electronic copy is withheld and service falls back to physical, as the ladder does for any
 *   notice without electronic service. Then each category of records is anonymised only where its
 *   retention rule is verified and its period has passed; the rest is held, with until when.
 * - **Access:** a job prepares one archive of the tenant's own records (an Excel workbook) and
 *   their stored lease, receipt and notice PDFs and the photos and recordings they sent, kept 7
 *   days in the ordinary files bucket (founder, review round) with its SHA-256 recorded, and
 *   downloaded through a five-minute link. One export holds at most `DEFAULT_MAX_EXPORT_BYTES`.
 */
@Injectable()
export class DataProtectionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(DATA_PROTECTION_LIMITS)
    limits: DataProtectionLimits | null = null,
  ) {
    this.maxExportBytes = limits?.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES;
  }

  private readonly maxExportBytes: number;

  /** Exports made before this instant are gone (B6): older than `EXPORT_KEEP_DAYS`. */
  private keptSince(): Date {
    return new Date(this.clock.now().getTime() - KEEP_MS);
  }

  /**
   * The files one archive holds, and those left out to stay within the cap: photos and
   * recordings first, then other files, largest first, until the rest fits.
   */
  private split<T extends { readonly sizeBytes: number; readonly media: boolean }>(
    files: readonly T[],
  ): { kept: T[]; leftOut: T[] } {
    let total = files.reduce((t, f) => t + f.sizeBytes, 0);
    const order = [...files].sort(
      (a, b) => Number(b.media) - Number(a.media) || b.sizeBytes - a.sizeBytes,
    );
    const leftOut = new Set<T>();
    for (const f of order) {
      if (total <= this.maxExportBytes) break;
      leftOut.add(f);
      total -= f.sizeBytes;
    }
    return {
      kept: files.filter((f) => !leftOut.has(f)),
      leftOut: order.filter((f) => leftOut.has(f)),
    };
  }

  private admin(actor: Actor | null, action: PolicyAction): StaffActor {
    const staff = staffActor(actor);
    this.policy.assert(staff, action);
    return staff;
  }

  // The register -------------------------------------------------------------------------------

  async list(
    actor: Actor | null,
    filters: { readonly tenantId?: string; readonly status?: DataProtectionRequestStatus } = {},
  ): Promise<DataProtectionRequestView[]> {
    const staff = this.admin(actor, 'data_protection.manage');
    if (filters.tenantId !== undefined && !UUID.test(filters.tenantId))
      throw invalid('bad_tenant', 'Choose a tenant from the list');
    if (filters.status !== undefined && !DATA_PROTECTION_REQUEST_STATUSES.includes(filters.status))
      throw invalid('bad_status', 'Choose a status from the list');
    const rows = await withCompany(
      this.database,
      staffContext(staff),
      (tx) =>
        this.rowsIn(
          tx,
          sql`(${filters.tenantId ?? null}::uuid is null or r.tenant_id = ${filters.tenantId ?? null}::uuid)
              and (${filters.status ?? null}::text is null or r.status = ${filters.status ?? null}::text)`,
        ),
      { accessMode: 'read only' },
    );
    return rows.map(viewOf);
  }

  async get(actor: Actor | null, requestId: string): Promise<DataProtectionRequestView> {
    const staff = this.admin(actor, 'data_protection.manage');
    return withCompany(this.database, staffContext(staff), (tx) => this.viewIn(tx, requestId), {
      accessMode: 'read only',
    });
  }

  private async rowsIn(tx: Tx, where: ReturnType<typeof sql>): Promise<RequestRow[]> {
    const rows = await tx.execute<RequestRow>(
      sql`select r.id, r.tenant_id, t.display_name as tenant_name, r.kind,
            r.received_on::text as received_on, r.due_on::text as due_on, r.due_rule_id,
            ru.verification_status as rule_status, r.status, r.notes, r.outcome,
            r.messaging_stopped_at, r.result, r.created_by, p.name as created_by_name, r.created_at,
            r.completed_at, x.id as export_id, x.status as export_status,
            x.left_out as export_left_out
          from data_protection_request r
          join tenant t on t.company_id = r.company_id and t.id = r.tenant_id
          left join person p on p.id = r.created_by
          left join rule ru on ru.id = r.due_rule_id
          left join lateral (
            select e.id, e.status,
              (select jsonb_array_length(coalesce(d.data_snapshot->'leftOut', '[]'::jsonb))
               from document d where d.company_id = e.company_id and d.id = e.document_id) as left_out
            from data_protection_export e
            where e.company_id = r.company_id and e.request_id = r.id
              -- B6: an export deleted after its 7 days is no longer offered.
              and not (e.status = 'ready' and e.ready_at <= ${this.keptSince()})
            order by e.created_at desc, e.id desc limit 1) x on true
          where ${where}
          order by r.received_on desc, r.created_at desc, r.id desc`,
    );
    return rows.rows;
  }

  private async viewIn(tx: Tx, requestId: string): Promise<DataProtectionRequestView> {
    if (!UUID.test(requestId)) throw notFound('Request');
    const [row] = await this.rowsIn(tx, sql`r.id = ${requestId}::uuid`);
    if (!row) throw notFound('Request');
    return viewOf(row);
  }

  /**
   * Records a request. Its due date comes from the rules row as of the day received; an erasure
   * request stops messaging to the tenant in the same transaction.
   */
  async create(
    actor: Actor | null,
    input: {
      readonly tenantId: string;
      readonly kind: DataProtectionRequestKind;
      readonly receivedOn: string;
      readonly notes?: string | null;
    },
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<DataProtectionRequestView> {
    const staff = this.admin(actor, 'data_protection.manage');
    if (!UUID.test(input.tenantId)) throw notFound('Tenant');
    if (!DATA_PROTECTION_REQUEST_KINDS.includes(input.kind))
      throw invalid('bad_kind', 'Choose access, correction, erasure or objection');
    if (!ISO_DATE.test(input.receivedOn))
      throw invalid('bad_date', 'Use a date such as 2026-11-01');
    try {
      parseBusinessDate(input.receivedOn);
    } catch {
      throw invalid('bad_date', 'Use a date such as 2026-11-01');
    }
    const notes = input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null;
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await options.claim?.claim(tx);
      const [tenant] = (
        await tx.execute<{ id: string }>(
          sql`select id from tenant where id = ${input.tenantId}::uuid`,
        )
      ).rows;
      if (!tenant) throw notFound('Tenant');
      const company = (await companyRecord(tx, staff.companyId))!;
      const today = toIsoDate(businessDateOf(instantFrom(this.clock.now()), company.timeZone));
      if (compareDates(parseBusinessDate(input.receivedOn), parseBusinessDate(today)) > 0)
        throw invalid('received_in_future', 'The day received is today or earlier');
      // OQ-65: the response time is a rules row; no due date while it has no value.
      let rule: ResolvedRule | null = null;
      try {
        rule = await this.rules.resolveIn(
          tx,
          company.countryCode,
          REQUEST_RESPONSE_DAYS_RULE,
          parseBusinessDate(input.receivedOn),
        );
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'rule.missing')) throw error;
      }
      const days = (rule?.value as { days?: unknown } | null | undefined)?.days;
      const dueOn =
        typeof days === 'number' && Number.isSafeInteger(days) && days >= 0
          ? toIsoDate(addDays(parseBusinessDate(input.receivedOn), days))
          : null;
      const id = uuidv7();
      await tx.execute(
        sql`insert into data_protection_request
              (id, company_id, tenant_id, kind, received_on, due_on, due_rule_id, notes, created_by)
            values (${id}::uuid, ${staff.companyId}::uuid, ${input.tenantId}::uuid, ${input.kind},
                    ${input.receivedOn}::date, ${dueOn}::date, ${rule?.ruleId ?? null}::uuid, ${notes},
                    ${staff.personId}::uuid)`,
      );
      const stopped =
        input.kind === 'erasure'
          ? await this.stopMessagingIn(tx, staff.companyId, input.tenantId, id, staff.personId)
          : 0;
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'data_protection.request_recorded',
        recordType: 'data_protection_request',
        recordId: id,
        data: {
          kind: input.kind,
          receivedOn: input.receivedOn,
          dueOn,
          dueRuleId: rule?.ruleId ?? null,
          messagingStopped: input.kind === 'erasure',
          consentWithdrawn: stopped,
        },
      });
      await options.claim?.done(tx, id);
      return this.viewIn(tx, id);
    });
  }

  /** Moves a request on. A completed or refused request needs an outcome, and is then closed. */
  async update(
    actor: Actor | null,
    requestId: string,
    input: { readonly status: DataProtectionRequestStatus; readonly outcome?: string | null },
  ): Promise<DataProtectionRequestView> {
    const staff = this.admin(actor, 'data_protection.manage');
    if (!UUID.test(requestId)) throw notFound('Request');
    if (!DATA_PROTECTION_REQUEST_STATUSES.includes(input.status))
      throw invalid('bad_status', 'Choose a status from the list');
    const outcome = input.outcome?.trim() ? input.outcome.trim().slice(0, 2000) : null;
    return closedChecks(() =>
      withCompany(this.database, staffContext(staff), async (tx) => {
        const row = await this.lockedIn(tx, requestId);
        if (CLOSED.includes(row.status)) throw closedConflict();
        const closing = CLOSED.includes(input.status);
        if (input.status === 'received' && row.status !== 'received')
          throw conflict('request_started', 'This request is already in progress.');
        if (closing && !outcome && !row.outcome)
          throw invalid('outcome_required', 'Say what was done, or why the request is refused');
        await tx.execute(
          sql`update data_protection_request
              set status = ${input.status}, outcome = coalesce(${outcome}, outcome), updated_at = now(),
                  completed_at = ${closing ? sql`now()` : sql`null`}
              where id = ${requestId}::uuid`,
        );
        await this.audit.append(tx, {
          companyId: staff.companyId,
          action: 'data_protection.request_updated',
          recordType: 'data_protection_request',
          recordId: requestId,
          data: { from: row.status, to: input.status },
        });
        return this.viewIn(tx, requestId);
      }),
    );
  }

  private async lockedIn(
    tx: Tx,
    requestId: string,
  ): Promise<{
    id: string;
    tenant_id: string;
    kind: DataProtectionRequestKind;
    status: DataProtectionRequestStatus;
    outcome: string | null;
    result: ErasureResult | null;
  }> {
    const [row] = (
      await tx.execute<{
        id: string;
        tenant_id: string;
        kind: DataProtectionRequestKind;
        status: DataProtectionRequestStatus;
        outcome: string | null;
        result: ErasureResult | null;
      }>(
        sql`select id, tenant_id, kind, status, outcome, result from data_protection_request
            where id = ${requestId}::uuid for update`,
      )
    ).rows;
    if (!row) throw notFound('Request');
    return row;
  }

  // Erasure -------------------------------------------------------------------------------------

  /**
   * Stops messaging to the tenant on every channel (decision 5; CM-09): marks the request, and
   * withdraws consent with source `data_protection` on each channel of the tenant and of each of
   * their contacts whose latest event is not already a withdrawal. Returns the withdrawals made.
   */
  private async stopMessagingIn(
    tx: Tx,
    companyId: string,
    tenantId: string,
    requestId: string,
    personId: string,
  ): Promise<number> {
    await tx.execute(
      sql`update data_protection_request set messaging_stopped_at = now(), updated_at = now()
          where id = ${requestId}::uuid and messaging_stopped_at is null`,
    );
    const contacts = await tx.execute<{ id: string }>(
      sql`select id from tenant_contact where tenant_id = ${tenantId}::uuid order by created_at, id`,
    );
    const latest = await tx.execute<{
      tenant_contact_id: string | null;
      channel: ConsentChannel;
      action: string;
    }>(
      sql`select distinct on (tenant_contact_id, channel) tenant_contact_id, channel, action
          from consent_event where tenant_id = ${tenantId}::uuid
          order by tenant_contact_id, channel, recorded_at desc, id desc`,
    );
    const withdrawn = new Set(
      latest.rows
        .filter((r) => r.action === 'withdraw')
        .map((r) => `${r.tenant_contact_id ?? ''}:${r.channel}`),
    );
    const version = consentTextVersion('data_protection', 'withdraw');
    let made = 0;
    for (const contactId of [null, ...contacts.rows.map((c) => c.id)])
      for (const channel of CONSENT_CHANNELS) {
        // Push reaches the tenant's own app only (decision 5); contacts have none.
        if (contactId !== null && channel === 'push') continue;
        if (withdrawn.has(`${contactId ?? ''}:${channel}`)) continue;
        await tx.execute(
          sql`insert into consent_event
                (company_id, tenant_id, tenant_contact_id, channel, action, text_version, text_sha256,
                 source, recorded_by)
              values (${companyId}::uuid, ${tenantId}::uuid, ${contactId}::uuid, ${channel},
                      'withdraw', ${version}, ${sha256(consentText(version, channel))},
                      'data_protection', ${personId}::uuid)`,
        );
        made += 1;
      }
    return made;
  }

  /**
   * Erasure (decision 5): messaging stays stopped; then each category is anonymised where its
   * retention rule is verified and its period has passed, and the rest is held, with until when and
   * why. With today's rules (none verified) nothing is anonymised. Books stay balanced (no journal
   * row is touched) and the audit chain keeps verifying (the changes are ordinary audited updates).
   * Running it again works the categories out again; what was anonymised stays listed.
   */
  async erase(
    actor: Actor | null,
    requestId: string,
    options: { readonly claim?: IdempotencyClaim | null } = {},
  ): Promise<DataProtectionRequestView> {
    const staff = this.admin(actor, 'data_protection.manage');
    if (!UUID.test(requestId)) throw notFound('Request');
    const ctx = staffContext(staff);
    // Webhook bodies sit in a system table (ADR-002): counted first, outside the write.
    const references = await withCompany(
      this.database,
      ctx,
      async (tx) => {
        const [row] = (
          await tx.execute<{ tenant_id: string; kind: string }>(
            sql`select tenant_id, kind from data_protection_request where id = ${requestId}::uuid`,
          )
        ).rows;
        if (!row) throw notFound('Request');
        if (row.kind !== 'erasure')
          throw conflict('not_erasure_request', 'Only an erasure request anonymises records.');
        const company = (await companyRecord(tx, staff.companyId))!;
        const [facts] = await tenantRetentionFactsIn(tx, company.timeZone, row.tenant_id);
        return facts?.providerReferences ?? [];
      },
      { accessMode: 'read only' },
    );
    const webhookBodies = await webhookBodiesFor(this.database, references);
    return closedChecks(() =>
      withCompany(this.database, ctx, async (tx) => {
        await options.claim?.claim(tx);
        const row = await this.lockedIn(tx, requestId);
        if (row.kind !== 'erasure')
          throw conflict('not_erasure_request', 'Only an erasure request anonymises records.');
        if (CLOSED.includes(row.status)) throw closedConflict();
        await this.stopMessagingIn(tx, staff.companyId, row.tenant_id, requestId, staff.personId);
        const company = (await companyRecord(tx, staff.companyId))!;
        const today = toIsoDate(businessDateOf(instantFrom(this.clock.now()), company.timeZone));
        const rules = await retentionRulesIn(tx, this.rules, company.countryCode, today);
        const [facts] = await tenantRetentionFactsIn(tx, company.timeZone, row.tenant_id);
        if (!facts) throw notFound('Tenant');
        const earlier = new Map(
          (row.result?.anonymised ?? []).map((a) => [a.category, a.records] as const),
        );
        const held: HeldRecords[] = [];
        // Every category is decided first, then the tenant row changes once (B8: after the update
        // that sets `anonymised_at`, RA127 refuses any other).
        const due = new Set<RetentionCategory>();
        for (const category of CATEGORY_ORDER) {
          const rule = rules[category];
          const records = category === 'webhook_bodies' ? webhookBodies : facts.records[category];
          const decision = decide(rule, records, facts.from[category], today, facts.live);
          if (decision.kind === 'held')
            held.push({
              category,
              records: decision.records,
              until: decision.until,
              reason: decision.reason,
            });
          if (decision.kind !== 'anonymise') continue;
          const blocked = NO_DATABASE_PATH[category];
          if (blocked)
            held.push({
              category,
              records: decision.records,
              until: retainedUntil(facts.from[category]!, rule.years!),
              reason: blocked,
            });
          else due.add(category);
        }
        const done = new Map<RetentionCategory, number>();
        if (due.has('tenant_profile')) {
          const changed = await anonymiseTenantIn(tx, row.tenant_id, {
            identity: due.has('identity'),
          });
          done.set('tenant_profile', changed.profile);
          done.set('identity', changed.identity);
        } else if (due.has('identity')) {
          done.set('identity', await anonymiseIdentityIn(tx, row.tenant_id));
        }
        const anonymised: { category: RetentionCategory; records: number }[] = [];
        for (const category of CATEGORY_ORDER) {
          const total = (done.get(category) ?? 0) + (earlier.get(category) ?? 0);
          if (total > 0) anonymised.push({ category, records: total });
        }
        const result: ErasureResult = {
          assessedAt: this.clock.now().toISOString(),
          anonymised,
          held,
        };
        await tx.execute(
          sql`update data_protection_request
              set result = ${JSON.stringify(result)}::jsonb, updated_at = now(),
                  status = case when status = 'received' then 'in_progress' else status end
              where id = ${requestId}::uuid`,
        );
        await this.audit.append(tx, {
          companyId: staff.companyId,
          action: 'data_protection.erasure_run',
          recordType: 'data_protection_request',
          recordId: requestId,
          data: {
            anonymised: result.anonymised,
            held: result.held.map((h) => ({
              category: h.category,
              records: h.records,
              until: h.until,
            })),
            rules: CATEGORY_ORDER.map((c) => ({
              category: c,
              ruleId: rules[c].ruleId,
              verified: rules[c].verified,
            })),
          },
        });
        await options.claim?.done(tx, requestId);
        return this.viewIn(tx, requestId);
      }),
    );
  }

  // Access: the export --------------------------------------------------------------------------

  /**
   * Prepares the tenant's export, in a job. A request has one live export at a time: asked again
   * while one is preparing or ready (and not yet deleted after its 7 days), it gets that one;
   * after a failure or once deleted, a new one.
   */
  async exportCreate(actor: Actor | null, requestId: string): Promise<DataProtectionExportView> {
    const staff = this.admin(actor, 'data_protection.export');
    if (!UUID.test(requestId)) throw notFound('Request');
    const found = await closedChecks(() =>
      withCompany(this.database, staffContext(staff), async (tx) => {
        const row = await this.lockedIn(tx, requestId);
        if (row.kind !== 'access')
          throw conflict('not_access_request', 'Only an access request prepares an export.');
        if (CLOSED.includes(row.status)) throw closedConflict();
        const [live] = (
          await tx.execute<{ id: string }>(
            sql`select id from data_protection_export
                where request_id = ${requestId}::uuid
                  and (status = 'preparing' or (status = 'ready' and ready_at > ${this.keptSince()}))
                order by created_at desc, id desc limit 1`,
          )
        ).rows;
        if (live) return live.id;
        const exportId = uuidv7();
        await tx.execute(
          sql`insert into data_protection_export (id, company_id, request_id, requested_by)
              values (${exportId}::uuid, ${staff.companyId}::uuid, ${requestId}::uuid, ${staff.personId}::uuid)`,
        );
        await enqueueOutbox(tx, {
          companyId: staff.companyId,
          type: DATA_PROTECTION_EXPORT_JOB,
          payload: { companyId: staff.companyId, exportId, requestId },
          idempotencyKey: `${DATA_PROTECTION_EXPORT_JOB}:${exportId}`,
        });
        if (row.status === 'received')
          await tx.execute(
            sql`update data_protection_request set status = 'in_progress', updated_at = now()
                where id = ${requestId}::uuid`,
          );
        await this.audit.append(tx, {
          companyId: staff.companyId,
          action: 'data_protection.export_requested',
          recordType: 'data_protection_export',
          recordId: exportId,
          data: { requestId },
        });
        return exportId;
      }),
    );
    return this.exportView(staff, found);
  }

  /** The export, with a five-minute link once it is ready. Issuing a link is audited. */
  async exportGet(actor: Actor | null, exportId: string): Promise<DataProtectionExportView> {
    const staff = this.admin(actor, 'data_protection.export');
    if (!UUID.test(exportId)) throw notFound('Export');
    return this.exportView(staff, exportId);
  }

  private async exportView(staff: StaffActor, exportId: string): Promise<DataProtectionExportView> {
    const row = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [found] = (
        await tx.execute<{
          id: string;
          status: DataProtectionExportView['status'];
          document_id: string | null;
          ready_at: Date | string | null;
          left_out: number | null;
        }>(
          sql`select e.id, e.status, e.document_id, e.ready_at,
                (select jsonb_array_length(coalesce(d.data_snapshot->'leftOut', '[]'::jsonb))
                 from document d where d.company_id = e.company_id and d.id = e.document_id) as left_out
              from data_protection_export e where e.id = ${exportId}::uuid`,
        )
      ).rows;
      // B6: deleted after its 7 days; a new one can be prepared.
      if (
        found?.status === 'ready' &&
        found.ready_at !== null &&
        asDate(found.ready_at).getTime() <= this.keptSince().getTime()
      )
        throw new AppError(
          410,
          'export_expired',
          'This export was deleted after 7 days. Prepare a new one.',
        );
      if (found?.status === 'ready')
        await this.audit.append(tx, {
          companyId: staff.companyId,
          action: 'data_protection.export_link_issued',
          recordType: 'data_protection_export',
          recordId: found.id,
          data: {},
        });
      return found;
    });
    if (!row) throw notFound('Export');
    if (row.status !== 'ready' || !row.document_id)
      return { id: row.id, status: row.status, url: null, expiresAt: null };
    const split = splitOf(row.status, row.left_out);
    const url = await this.documents.downloadUrl(
      staff.companyId,
      row.document_id,
      'personal-data-export.zip',
    );
    if (!url) throw notFound('Export');
    return {
      id: row.id,
      status: 'ready',
      url,
      expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_MS),
      ...split,
    };
  }

  /**
   * The `data-protection.export` job: one archive of the tenant's own records and stored files,
   * kept in the ordinary files bucket for 7 days (founder, review round; not write-once) and
   * recorded with its SHA-256. Idempotent: a ready or failed export is left as it is, and a run
   * after one that stored the archive but did not record it records that object rather than
   * storing a second copy. Over the size cap (B7) the largest photos and recordings are left out
   * and listed, and the export is still ready (`split`). Only the files kept are read, so memory
   * stays bounded by the cap. Logs nothing of what it holds.
   */
  async prepareExport(companyId: string, exportId: string): Promise<'ready' | 'skipped'> {
    const ctx = { companyId, actorKind: 'system' as const };
    const found = await withCompany(
      this.database,
      ctx,
      async (tx) => {
        const [row] = (
          await tx.execute<{ status: string; tenant_id: string; requested_by: string | null }>(
            sql`select e.status, r.tenant_id, e.requested_by from data_protection_export e
                join data_protection_request r on r.company_id = e.company_id and r.id = e.request_id
                where e.id = ${exportId}::uuid`,
          )
        ).rows;
        if (!row || row.status !== 'preparing') return null;
        const company = (await companyRecord(tx, companyId))!;
        const data = await tenantExportIn(tx, row.tenant_id, company.timeZone);
        return { row, company, data };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (!found) return 'skipped';
    const { row, company, data } = found;
    const { kept, leftOut } = this.split(data.files);
    const files: {
      name: string;
      what: string;
      sha256: string;
      intact: boolean;
      bytes: Buffer | null;
    }[] = [];
    for (const f of kept) {
      // A file still being scanned fails this run, which is retried; a quarantined one is listed
      // and left out (M11 decision 6: never served).
      let file: Awaited<ReturnType<DocumentsService['documentFile']>>;
      try {
        file = await this.documents.documentFile(companyId, f.documentId);
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'document_quarantined')) throw error;
        files.push({ name: f.name, what: f.what, sha256: '', intact: false, bytes: null });
        continue;
      }
      if (!file) continue;
      files.push({
        name: f.name,
        what: f.what,
        sha256: file.sha256,
        intact: file.intact,
        bytes: file.bytes,
      });
    }
    const preparedAt = this.clock.now();
    const workbook = await exportWorkbook(
      data,
      { companyName: company.displayName, preparedAt, timeZone: company.timeZone },
      files,
      leftOut,
      this.maxExportBytes,
    );
    const archive = zipArchive([
      { name: 'personal-data.xlsx', bytes: workbook },
      ...files.flatMap((f) => (f.bytes ? [{ name: f.name, bytes: f.bytes }] : [])),
    ]);
    // B6: re-check before anything is written, so a retry of a finished run stores nothing.
    const still = await withCompany(this.database, ctx, (tx) =>
      tx.execute<{ status: string }>(
        sql`select status from data_protection_export where id = ${exportId}::uuid`,
      ),
    );
    if (still.rows[0]?.status !== 'preparing') return 'skipped';
    const ref = {
      bucket: this.config.S3_BUCKET_FILES,
      key: `${EXPORT_PREFIX}/${companyId}/${exportId}.zip`,
    };
    // A run that stored the archive and then failed before recording it left one copy: record
    // that one rather than store a second.
    const earlier = await this.storage.head(ref);
    const stored = earlier
      ? {
          versionId: earlier.versionId,
          bytes: await this.storage.get({
            ...ref,
            ...(earlier.versionId ? { versionId: earlier.versionId } : {}),
          }),
        }
      : {
          versionId: (
            await this.storage.put({ ...ref, body: archive, contentType: ZIP_CONTENT_TYPE })
          ).versionId,
          bytes: archive,
        };
    return withCompany(this.database, ctx, async (tx) => {
      const [current] = (
        await tx.execute<{ status: string }>(
          sql`select status from data_protection_export where id = ${exportId}::uuid for update`,
        )
      ).rows;
      if (current?.status !== 'preparing') return 'skipped' as const;
      const documentId = await this.documents.insertDocument(tx, {
        origin: 'generated',
        companyId,
        kind: 'data_protection_export',
        contentType: ZIP_CONTENT_TYPE,
        bytes: stored.bytes,
        bucket: ref.bucket,
        storageKey: ref.key,
        storageVersionId: stored.versionId,
        writeOnce: false,
        createdBy: row.requested_by,
        // What the archive left out to stay under the cap, for the register (no personal data:
        // file names, record references, dates and sizes).
        dataSnapshot: {
          capBytes: this.maxExportBytes,
          leftOut: leftOut.map((f) => ({
            name: f.name,
            belongsTo: f.belongsTo,
            on: f.on,
            sizeBytes: f.sizeBytes,
          })),
        },
      });
      const [doc] = (
        await tx.execute<{ sha256: string }>(
          sql`select sha256 from document where id = ${documentId}::uuid`,
        )
      ).rows;
      await tx.execute(
        sql`update data_protection_export
            set status = 'ready', document_id = ${documentId}::uuid, ready_at = ${this.clock.now()},
                updated_at = now()
            where id = ${exportId}::uuid`,
      );
      await this.audit.append(tx, {
        companyId,
        action: 'data_protection.export_prepared',
        recordType: 'data_protection_export',
        recordId: exportId,
        data: {
          documentId,
          sha256: doc!.sha256,
          keptDays: EXPORT_KEEP_DAYS,
          files: files.filter((f) => f.bytes).length,
          withheld: files.filter((f) => !f.bytes).length,
          leftOut: leftOut.length,
        },
      });
      return 'ready' as const;
    });
  }

  /** After the job's last retry: the export is marked failed, with a code, never its contents. */
  async failExport(companyId: string, exportId: string, code: string): Promise<void> {
    await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx.execute(
        sql`update data_protection_export set status = 'failed', error = ${code.slice(0, 200)},
              updated_at = now()
            where id = ${exportId}::uuid and status = 'preparing'`,
      ),
    );
  }

  /**
   * The daily `data-protection.export-cleanup` (B6, founder: 7 days): every company's exports
   * older than `EXPORT_KEEP_DAYS` have their object deleted, exactly the version recorded. The
   * document row stays, with its SHA-256, and the export is refused from then on (410). Each
   * company in its own context (ADR-002); idempotent, as an object already gone is skipped.
   */
  async cleanupExports(): Promise<{ deleted: number }> {
    const keptSince = this.keptSince();
    const lookback = new Date(keptSince.getTime() - CLEANUP_LOOKBACK_MS);
    const companies = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.company_ids() as id`),
    );
    let deleted = 0;
    for (const { id: companyId } of companies.rows) {
      const ctx = { companyId, actorKind: 'system' as const };
      const old = await withCompany(
        this.database,
        ctx,
        (tx) =>
          tx.execute<{
            id: string;
            document_id: string;
            bucket: string;
            storage_key: string;
            storage_version_id: string | null;
          }>(
            sql`select e.id, d.id as document_id, d.bucket, d.storage_key, d.storage_version_id
                from data_protection_export e
                join document d on d.company_id = e.company_id and d.id = e.document_id
                where e.status = 'ready' and e.ready_at <= ${keptSince} and e.ready_at > ${lookback}
                  and not d.write_once`,
          ),
        { accessMode: 'read only' },
      );
      for (const e of old.rows) {
        const ref = {
          bucket: e.bucket,
          key: e.storage_key,
          ...(e.storage_version_id ? { versionId: e.storage_version_id } : {}),
        };
        if (!(await this.storage.head(ref))) continue;
        await this.storage.delete(ref);
        deleted += 1;
        await withCompany(this.database, ctx, (tx) =>
          this.audit.append(tx, {
            companyId,
            action: 'data_protection.export_deleted',
            recordType: 'data_protection_export',
            recordId: e.id,
            data: { documentId: e.document_id, keptDays: EXPORT_KEEP_DAYS },
          }),
        );
      }
    }
    return { deleted };
  }
}
