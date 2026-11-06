import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  addDays,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import {
  ASSESSMENT_BAR_KEY,
  applyNoticeEvent,
  checkNoticeClose,
  checkNoticeCorrection,
  checkNoticeEditable,
  checkNoticeFields,
  checkNoticeSubtype,
  checkLadderControl,
  counselReviewedTemplate,
  formatNoticeNumber,
  LADDER_NOTICE_TYPES,
  NOTICE_FIELD_LABELS,
  NOTICE_FIELD_SCHEMAS,
  NOTICE_REQUIRED_FIELDS,
  NOTICE_STATUS_LABELS,
  NOTICE_SUBTYPE_FIELD_LABELS,
  NOTICE_SUBTYPE_LABELS,
  NOTICE_SUBTYPES,
  NOTICE_TEMPLATE,
  NOTICE_TYPE_LABELS,
  NOTICE_TYPE_RULES,
  NOTICE_TYPES,
  NoticeFieldError,
  noticeCompletionFor,
  noticeDaysOutstanding,
  noticeDocumentContent,
  noticeIssueBlockers,
  noticeKeyDate,
  noticeLadderFor,
  noticeLinkExpiresAt,
  noticeSettingsOf,
  plannedNoticeLadder,
  quitNoticesEnabled,
  SERVICE_METHOD_LABELS,
  servedTooLate,
  statutoryMinimumKey,
  supersededClosure,
  type EarliestDateInput,
  type NoticeIssueBlocker,
  type NoticeLadderFlags,
  type NoticeLadderStep,
  type NoticeOutcome,
  type NoticeRecipientKind,
  type NoticeRuleInput,
  type NoticeRecordKind,
  type NoticeRuleUsed,
  type NoticeStatus,
  type NoticeSubtype,
  type NoticeType,
  type NoticeWarning,
  type ServiceMethod,
} from '@rent/domain/notices';
import { format as formatMoneyOf, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import { rentOn, type LeaseUse } from '@rent/domain/tenancy';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { BillingReadService } from '../billing/billing-read.service';
import { staffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { isUniqueViolation } from '../core/db-errors';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, CONFIG, DATABASE } from '../core/tokens';
import {
  DocumentsService,
  NOTICE_AFFIDAVIT_UPLOAD,
  NOTICE_PHOTO_UPLOAD,
  NOTICE_RECEIVED_UPLOAD,
  RENT_ASSESSMENT_UPLOAD,
  type UploadPurpose,
} from '../documents/documents.service';
import { EsignService } from '../esign/esign.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { TasksService, type TaskView } from '../tasks/tasks.service';
import { billingLeaseOf } from '../tenancy/billing-facts';
import { TenantsService } from '../tenancy/tenants.service';
import {
  assessmentRecordsOf,
  companyFacts,
  effectiveDateOf,
  eventsOf,
  factsOf,
  hasServiceClause,
  noticeRow,
  NOTICE_ESCALATE_JOB,
  NOTICE_LEASE_STATUSES,
  numberOf,
  partyKeyOf,
  planRecipients,
  progressOf,
  recipientRefs,
  recipientsOf,
  recordEvent,
  returnedForApproval,
  servedElectronically,
  syncStatus,
  type CompanyFacts,
  type LeaseRow,
  type NoticeRow,
  type PlannedRecipient,
  type RecipientRow,
} from './records';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

/** The approval action types (decision 8; AD-05). */
export const NOTICE_ISSUE_ACTION = 'notice.issue';
export const NOTICE_ISSUE_QUIT_ACTION = 'notice.issue_quit';
const ISSUER_ROLES = ['owner', 'agency_admin', 'property_manager'] as const;

const LIVE = ['sent', 'delivered', 'reminded', 'opened', 'escalated', 'served', 'signed'];
/**
 * The notice events on a tenant's timeline (LN-03): every status change, including the steps
 * before issue and the ladder's controls (review D-A, founder decision).
 */
export const NOTICE_TIMELINE_KINDS = [
  'submitted',
  'approved',
  'returned_to_draft',
  'cancelled',
  'sent',
  'delivered',
  'opened',
  'reminded',
  'escalated',
  'served',
  'signed',
  'closed',
  'received',
  'ladder_paused',
  'ladder_resumed',
  'ladder_cancelled',
] as const satisfies readonly NoticeRecordKind[];
const PRE_ISSUE = ['draft', 'pending_approval', 'approved'];
const HOUR = 3_600_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const codeOf = (code: string) => code.replace(/\./g, '_');
const formatMoney = (amountMinor: number) => formatMoneyOf(money(amountMinor));

/** Domain state errors become named 409s; field errors 400s (M6 review lesson). */
function asAppError(error: unknown): never {
  if (error instanceof NoticeFieldError)
    throw new AppError(400, codeOf(error.code), error.message, { field: error.field });
  if (error instanceof DomainError) throw conflict(codeOf(error.code), error.message);
  throw error;
}
const guard = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    return asAppError(error);
  }
};

export interface ComposeTarget {
  readonly type: NoticeType;
  readonly subtype?: string | null;
  readonly leaseId?: string | null;
  readonly propertyId?: string | null;
  readonly blockIds?: readonly string[];
}

/** What the service resolved about a notice's target, for checks, issue and views. */
interface Target {
  readonly lease: LeaseRow | null;
  readonly propertyId: string;
  readonly propertyName: string;
  readonly unitId: string | null;
  readonly unitCode: string | null;
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly blockIds: string[];
  readonly blockCodes: string[];
}

export interface NoticeListRowView {
  readonly id: string;
  readonly number: string | null;
  readonly type: NoticeType;
  readonly typeLabel: string;
  readonly subtype: NoticeSubtype | null;
  readonly subtypeLabel: string | null;
  readonly status: NoticeStatus;
  readonly statusLabel: string;
  readonly outcome: NoticeOutcome | null;
  readonly tenant: { readonly id: string; readonly name: string } | null;
  readonly property: { readonly id: string; readonly name: string };
  readonly unitCode: string | null;
  readonly leaseId: string | null;
  readonly issuedAt: Date | null;
  readonly effectiveDate: string | null;
  readonly daysOutstanding: number | null;
  readonly recipientCount: number;
  readonly signedRecipients: number;
  readonly ladderPaused: boolean;
  readonly ladderCancelled: boolean;
  readonly servedTooLate: boolean;
  readonly correctsNumber: string | null;
  readonly correctedByNumber: string | null;
  readonly createdAt: Date;
}

/** How the earliest lawful date was reached (plan 4.3), as the notice keeps it. */
export interface EarliestView {
  readonly earliestDate: string;
  readonly serviceDate: string;
  readonly serviceDateBasis: 'electronic_issue' | 'physical_service' | 'planned_issue' | 'issue';
  readonly periodDays: number;
  readonly periodSource: 'none' | 'contractual' | 'statutory';
  readonly contractualDays: number | null;
  readonly statutoryDays: number | null;
  readonly leaseEndApplied: boolean;
}

export interface NoticeEvaluation {
  readonly prefill: Record<string, unknown>;
  readonly recipients: PlannedRecipient[];
  readonly plannedIssueDate: string;
  readonly earliest: EarliestView | null;
  readonly effectiveCheck: { ok: boolean; shortByDays: number; reason: string | null } | null;
  readonly warnings: NoticeWarning[];
  readonly blockers: NoticeIssueBlocker[];
  readonly quitBar: {
    barred: boolean;
    barredUntil: string | null;
    latestAssessment: string | null;
  } | null;
  readonly fieldErrors: { field: string; code: string; message: string }[];
  readonly ruleVersions: NoticeRuleUsed[];
  readonly statutoryRuleId: string | null;
  readonly barRuleId: string | null;
  readonly electronicService: boolean;
  readonly earliestDate: string | null;
}

/**
 * Legal notices (LN-01 to LN-05, LN-07, LN-09; M7 plan 4): the composer's checks, drafts, approval
 * (one person with notice authority, two for a notice to quit), issue (the date and the s.23 bar
 * checked again, the number taken, the PDF frozen, a signing request per party), the ladder's
 * controls, physical service, closure and corrections. Growth only (decision 14). Nothing here ends
 * a lease or touches a unit: a notice to quit never ends a tenancy by itself.
 */
@Injectable()
export class NoticesService implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(EsignService) private readonly esign: EsignService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(BillingReadService) private readonly billing: BillingReadService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    for (const actionType of [NOTICE_ISSUE_ACTION, NOTICE_ISSUE_QUIT_ACTION])
      this.approvals.register<{ noticeId: string; contentHash: string }>({
        actionType,
        eligibleRoles: ISSUER_ROLES,
        onePerSubject: true,
        schema: z.object({ noticeId: z.string().uuid(), contentHash: z.string() }),
        currentPayload: async (tx, request) => {
          const notice = await noticeRow(tx, request.subjectId);
          return { noticeId: notice.id, contentHash: contentHash(notice) };
        },
        execute: async (tx, request) => {
          await this.onApproved(
            tx,
            request.subjectId,
            (await this.approvals.approverIn(tx, request.id)) ?? request.initiatedBy,
          );
        },
      });
    this.esign.useNoticeFacts(async (tx, noticeId) => {
      const [row] = await tx.select().from(schema.notice).where(eq(schema.notice.id, noticeId));
      if (!row || row.number === null || !row.issuedAt) return null;
      const [next] = await tx
        .select({ number: schema.notice.number })
        .from(schema.notice)
        .where(
          and(
            eq(schema.notice.correctsNoticeId, noticeId),
            sql`${schema.notice.number} is not null`,
          ),
        )
        .limit(1);
      return {
        number: formatNoticeNumber(row.number),
        type: row.type as NoticeType,
        typeLabel: NOTICE_TYPE_LABELS[row.type as NoticeType],
        issuedAt: row.issuedAt,
        effectiveDate: row.effectiveDate,
        supersededBy:
          row.outcome === 'superseded' && next?.number
            ? { number: formatNoticeNumber(next.number) }
            : null,
        closed: row.status === 'closed',
      };
    });
    this.tasks.useRelated('notice', async (tx, ids) => {
      const rows = await tx
        .select({ id: schema.notice.id, number: schema.notice.number, type: schema.notice.type })
        .from(schema.notice)
        .where(inArray(schema.notice.id, [...ids]));
      return new Map(
        rows.map((r) => [
          r.id,
          { number: numberOf(r), typeLabel: NOTICE_TYPE_LABELS[r.type as NoticeType] },
        ]),
      );
    });
    this.tenants.useTimelineSource(async (tx, tenantId, options) => {
      const rows = await tx
        .select({ event: schema.noticeEvent, notice: schema.notice })
        .from(schema.noticeEvent)
        .innerJoin(
          schema.notice,
          and(
            eq(schema.notice.companyId, schema.noticeEvent.companyId),
            eq(schema.notice.id, schema.noticeEvent.noticeId),
          ),
        )
        .where(
          and(
            // The tenant's own events, and every notice-wide event of a notice served on them:
            // a building-wide notice names no tenant on the notice itself (review MF-7).
            or(
              eq(schema.noticeEvent.tenantId, tenantId),
              and(
                isNull(schema.noticeEvent.recipientId),
                sql`exists (select 1 from notice_recipient r where r.company_id = ${schema.noticeEvent.companyId} and r.notice_id = ${schema.noticeEvent.noticeId} and r.tenant_id = ${tenantId})`,
              ),
            ),
            inArray(schema.noticeEvent.kind, [...NOTICE_TIMELINE_KINDS]),
          ),
        )
        .orderBy(desc(schema.noticeEvent.occurredAt))
        .limit(100);
      const people = [
        ...new Set(rows.flatMap((r) => (r.event.actorPersonId ? [r.event.actorPersonId] : []))),
      ];
      const names = people.length
        ? await tx
            .select({ id: schema.person.id, name: schema.person.name })
            .from(schema.person)
            .where(inArray(schema.person.id, people))
        : [];
      const reader = options.actor;
      const mayRead = reader ? this.policy.can(reader, 'notices.read').allowed : false;
      return rows.map(({ event, notice }) => ({
        at: event.occurredAt,
        action: `notice.${event.kind}`,
        recordType: 'notice',
        recordId: notice.id,
        actorName: names.find((n) => n.id === event.actorPersonId)?.name ?? null,
        data: mayRead
          ? {
              noticeId: notice.id,
              number: numberOf(notice),
              type: notice.type,
              typeLabel: NOTICE_TYPE_LABELS[notice.type as NoticeType],
              status: notice.status,
              outcome: notice.outcome,
            }
          : null,
      }));
    });
  }

  // Reads -----------------------------------------------------------------------------------------

  /** The composer's catalogue (LN-01): every type with its fields, period and ladder. */
  async types(actor: Actor | null) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'notices.read');
    const onPlan = await this.entitlements.has(staff.companyId, 'notices');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyFacts(tx, staff.companyId);
      const settings = noticeSettingsOf(company.settings);
      return {
        types: NOTICE_TYPES.map((type) => {
          const rules = NOTICE_TYPE_RULES[type];
          const fields = Object.keys(NOTICE_FIELD_SCHEMAS[type].shape);
          return {
            type,
            label: NOTICE_TYPE_LABELS[type],
            subtypes: (NOTICE_SUBTYPES[type] as readonly NoticeSubtype[]).map((value) => ({
              value,
              label: NOTICE_SUBTYPE_LABELS[value],
            })),
            subtypeFieldLabel: NOTICE_SUBTYPE_FIELD_LABELS[type] ?? null,
            requiredFields: [...NOTICE_REQUIRED_FIELDS[type]],
            fieldLabels: Object.fromEntries(fields.map((f) => [f, NOTICE_FIELD_LABELS[f] ?? f])),
            period: rules.period,
            hasPeriod: rules.hasPeriod,
            ladderKind: rules.ladder,
            ladder: noticeLadderFor(type, settings),
            postOnPremises: rules.postOnPremises,
            twoPersonApproval: rules.twoPersonApproval,
            needsLease: rules.needsLease,
            issuable: rules.issuable,
            template: {
              ...NOTICE_TEMPLATE,
              counselReviewed: counselReviewedTemplate(
                NOTICE_TEMPLATE.key,
                NOTICE_TEMPLATE.version,
              ),
            },
          };
        }),
        quitEnabled: await this.quitEnabledIn(tx),
        onPlan,
        timeZone: company.timeZone,
        sendWindow: { from: settings.sendWindow.from, to: settings.sendWindow.to },
        linkExpiryDays: settings.linkExpiryDays,
      };
    });
  }

  async list(
    actor: Actor | null,
    filter: {
      status?: NoticeStatus;
      open?: boolean;
      type?: NoticeType;
      propertyId?: string;
      tenantId?: string;
      leaseId?: string;
      outcome?: NoticeOutcome;
      servedTooLate?: boolean;
      search?: string;
    },
  ): Promise<NoticeListRowView[]> {
    const staff = await this.reader(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const n = schema.notice;
      const recipientTenants = filter.tenantId
        ? sql`(${n.tenantId} = ${filter.tenantId} or exists (select 1 from notice_recipient r where r.company_id = ${n.companyId} and r.notice_id = ${n.id} and r.tenant_id = ${filter.tenantId}))`
        : undefined;
      const rows = await tx
        .select()
        .from(n)
        .where(
          and(
            filter.status ? eq(n.status, filter.status) : undefined,
            filter.open ? inArray(n.status, LIVE) : undefined,
            filter.type ? eq(n.type, filter.type) : undefined,
            filter.propertyId ? eq(n.propertyId, filter.propertyId) : undefined,
            recipientTenants,
            filter.leaseId ? eq(n.leaseId, filter.leaseId) : undefined,
            filter.outcome ? eq(n.outcome, filter.outcome) : undefined,
            filter.servedTooLate === true ? sql`${n.servedTooLate} is not null` : undefined,
            filter.servedTooLate === false ? sql`${n.servedTooLate} is null` : undefined,
          ),
        )
        .orderBy(desc(n.createdAt))
        .limit(500);
      const views = await this.listRows(tx, rows);
      const q = filter.search?.trim().toLowerCase();
      return q
        ? views.filter((v) =>
            [v.number, v.tenant?.name, v.unitCode, v.property.name, v.typeLabel]
              .filter(Boolean)
              .some((s) => s!.toLowerCase().includes(q)),
          )
        : views;
    });
  }

  async summary(actor: Actor | null) {
    const staff = await this.reader(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyFacts(tx, staff.companyId);
      const rows = await tx
        .select({
          status: schema.notice.status,
          issuedAt: schema.notice.issuedAt,
          servedTooLate: schema.notice.servedTooLate,
        })
        .from(schema.notice);
      const now = this.clock.now();
      const byStatus = new Map<string, number>();
      const byAge = { '0_7': 0, '8_14': 0, '15_30': 0, over_30: 0 };
      let late = 0;
      for (const r of rows) {
        byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
        if (r.servedTooLate) late += 1;
        if (!LIVE.includes(r.status) || !r.issuedAt) continue;
        const days = noticeDaysOutstanding(r.issuedAt, now, company.timeZone);
        if (days <= 7) byAge['0_7'] += 1;
        else if (days <= 14) byAge['8_14'] += 1;
        else if (days <= 30) byAge['15_30'] += 1;
        else byAge.over_30 += 1;
      }
      return {
        byStatus: [...byStatus.entries()].map(([status, count]) => ({
          status: status as NoticeStatus,
          count,
        })),
        byAge: Object.entries(byAge).map(([bucket, count]) => ({
          bucket: bucket as keyof typeof byAge,
          count,
        })),
        servedTooLate: late,
        drafts: byStatus.get('draft') ?? 0,
        awaitingApproval: byStatus.get('pending_approval') ?? 0,
      };
    });
  }

  async get(actor: Actor | null, noticeId: string) {
    const staff = await this.reader(actor);
    const detail = await withCompany(this.database, staffContext(staff), async (tx) =>
      this.detailIn(tx, staff, await noticeRow(tx, noticeId)),
    );
    const approval = detail.approvalRequestId
      ? await this.approvals.get(staff, detail.approvalRequestId).catch(() => null)
      : null;
    return { ...detail, approval };
  }

  /** The draft as its PDF will read, as HTML (no scripts, no styles). */
  async preview(
    actor: Actor | null,
    noticeId: string,
  ): Promise<{ html: string; counselReviewed: boolean }> {
    const staff = await this.reader(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await noticeRow(tx, noticeId);
      const company = await companyFacts(tx, staff.companyId);
      const target = await this.targetOf(tx, notice);
      const recipients = await this.recipientsFor(tx, notice, target);
      const content = noticeDocumentContent({
        type: notice.type as NoticeType,
        subtype: (notice.subtype as NoticeSubtype | null) ?? null,
        fields: notice.fields as Record<string, unknown>,
        number: numberOf(notice) ?? 'DRAFT',
        issueDate: notice.issueDate ?? this.today(company),
        landlordName: company.displayName,
        propertyName: target.propertyName,
        premises: premisesOf(target),
        recipients: recipients.length ? recipients.map((r) => r.name) : ['(no recipient yet)'],
        replaces: await this.correctsNumber(tx, notice),
        counselReviewed: notice.counselReviewed,
      });
      const { renderTemplateContent } = await import('@rent/documents');
      return {
        html: renderTemplateContent(NOTICE_TEMPLATE.key, NOTICE_TEMPLATE.version, content, {
          senderName: company.senderName,
          primaryColour: '#0F766E',
          accentColour: '#F59E0B',
        }),
        counselReviewed: notice.counselReviewed,
      };
    });
  }

  // The composer (LN-01; plan 4.3) ------------------------------------------------------------------

  async compose(
    actor: Actor | null,
    input: ComposeTarget & { fields?: Record<string, unknown>; plannedIssueDate?: string },
  ) {
    const staff = await this.drafter(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyFacts(tx, staff.companyId);
      const target = await this.resolveTarget(tx, input);
      // The ledger's arrears, for readers who may see the money (LN-01).
      const arrears =
        input.type === 'rent_demand' &&
        target.lease &&
        this.policy.can(staff, 'billing.view').allowed
          ? await this.arrearsOf(tx, company, target.lease.id)
          : null;
      const plannedIssueDate = input.plannedIssueDate ?? this.today(company);
      guard(() => parseBusinessDate(plannedIssueDate));
      const fields = input.fields ?? {};
      const evaluation = await this.evaluate(tx, company, {
        type: input.type,
        subtype: input.subtype ?? null,
        fields,
        target,
        issueDate: plannedIssueDate,
      });
      return {
        prefill: {
          tenant: target.tenantId ? { id: target.tenantId, name: target.tenantName ?? '' } : null,
          property: { id: target.propertyId, name: target.propertyName },
          unit: target.unitId ? { id: target.unitId, code: target.unitCode ?? '' } : null,
          lease: target.lease
            ? {
                id: target.lease.id,
                use: target.lease.use as LeaseUse,
                status: target.lease.status,
                startDate: target.lease.startDate,
                endDate: target.lease.endDate,
                noticeDays: target.lease.noticeDays,
                monthlyRentMinor: Number(target.lease.monthlyRentMinor),
                electronicServiceClause: hasServiceClause(target.lease),
              }
            : null,
          arrears,
          suggestedFields: suggestedFields(
            input.type,
            target,
            arrears,
            plannedIssueDate,
            input.type === 'rent_review' && target.lease
              ? rentOn((await billingLeaseOf(tx, target.lease.id)).terms, plannedIssueDate)
              : null,
          ),
        },
        recipients: evaluation.recipients.map((r) => ({
          kind: r.kind,
          name: r.name,
          partyTenantId: r.tenantId,
          unitCode: r.unitCode,
          channels: r.channels,
          physicalServicePlanned: r.physicalServicePlanned,
        })),
        plannedIssueDate,
        earliest: evaluation.earliest,
        effectiveCheck: evaluation.effectiveCheck,
        warnings: evaluation.warnings,
        blockers: evaluation.blockers,
        quitBar: evaluation.quitBar,
        fieldErrors: evaluation.fieldErrors,
        template: {
          ...NOTICE_TEMPLATE,
          counselReviewed: counselReviewedTemplate(NOTICE_TEMPLATE.key, NOTICE_TEMPLATE.version),
        },
      };
    });
  }

  // Drafts ----------------------------------------------------------------------------------------

  async create(
    actor: Actor | null,
    input: ComposeTarget & { fields: Record<string, unknown>; correctsNoticeId?: string | null },
  ) {
    const staff = await this.drafter(actor);
    return this.get(staff, (await this.createRecord(staff, input, null)).noticeId);
  }

  /** The draft's write, under an Idempotency-Key claim when the request sent one. */
  async createRecord(
    actor: Actor | null,
    input: ComposeTarget & { fields: Record<string, unknown>; correctsNoticeId?: string | null },
    claim: IdempotencyClaim | null,
  ): Promise<{ noticeId: string }> {
    const staff = await this.drafter(actor);
    const id = await withCompany(this.database, staffContext(staff), async (tx) => {
      await claim?.claim(tx);
      const rules = NOTICE_TYPE_RULES[input.type];
      if (!rules.issuable)
        throw conflict(
          'notice_not_issuable',
          'Record a notice from the tenant with POST /notices/received',
        );
      if (rules.needsQuitAcknowledgement && !(await this.quitEnabledIn(tx)))
        throw conflict(
          'notice_quit_not_enabled',
          'Notices to quit are switched off until a company admin records that they accept the risk (OQ-16)',
        );
      const subtype = guard(() => checkNoticeSubtype(input.type, input.subtype ?? null));
      const fields = checkDraftFields(input.type, input.fields);
      const target = await this.resolveTarget(tx, input);
      let correctsNoticeId: string | null = null;
      if (input.correctsNoticeId) {
        const original = await noticeRow(tx, input.correctsNoticeId);
        guard(() =>
          checkNoticeCorrection({
            original: {
              status: original.status as NoticeStatus,
              type: original.type as NoticeType,
              leaseId: original.leaseId,
              propertyId: original.propertyId,
            },
            correction: {
              type: input.type,
              leaseId: target.lease?.id ?? null,
              propertyId: target.propertyId,
            },
          }),
        );
        correctsNoticeId = original.id;
        // Review S6: one live correction per notice (the partial unique index backs this up).
        const [open] = await tx
          .select({ id: schema.notice.id })
          .from(schema.notice)
          .where(
            and(
              eq(schema.notice.correctsNoticeId, original.id),
              sql`${schema.notice.status} <> 'cancelled'`,
            ),
          )
          .limit(1);
        if (open)
          throw conflict(
            'notice_correction_open',
            'A correction of this notice has been started already: open it, or discard it first',
            { noticeId: open.id },
          );
      }
      const now = this.clock.now();
      const [row] = await tx
        .insert(schema.notice)
        .values({
          companyId: staff.companyId,
          type: input.type,
          subtype,
          status: 'draft',
          propertyId: target.propertyId,
          unitId: target.unitId,
          leaseId: target.lease?.id ?? null,
          tenantId: target.tenantId,
          blockIds: target.blockIds,
          fields,
          templateKey: NOTICE_TEMPLATE.key,
          templateVersion: NOTICE_TEMPLATE.version,
          counselReviewed: counselReviewedTemplate(NOTICE_TEMPLATE.key, NOTICE_TEMPLATE.version),
          completion: noticeCompletionFor({
            type: input.type,
            leaseUse: (target.lease?.use as LeaseUse | undefined) ?? null,
          }),
          correctsNoticeId,
          createdBy: staff.personId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.notice.id })
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'notice_one_live_correction_key'))
            throw conflict(
              'notice_correction_open',
              'A correction of this notice has been started already: open it, or discard it first',
            );
          throw error;
        });
      await claim?.done(tx, { noticeId: row!.id });
      return row!.id;
    });
    return { noticeId: id };
  }

  async update(
    actor: Actor | null,
    noticeId: string,
    patch: {
      subtype?: string | null;
      blockIds?: readonly string[];
      fields?: Record<string, unknown>;
    },
  ) {
    const staff = await this.drafter(actor);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await this.syncedRow(tx, noticeId, staff.personId);
      guard(() => checkNoticeEditable(notice.status as NoticeStatus));
      const type = notice.type as NoticeType;
      const subtype =
        patch.subtype === undefined
          ? notice.subtype
          : guard(() => checkNoticeSubtype(type, patch.subtype ?? null));
      const fields = patch.fields ? checkDraftFields(type, patch.fields) : notice.fields;
      let blockIds = notice.blockIds;
      if (patch.blockIds) {
        if (type !== 'building_wide')
          throw invalid('notice_blocks', 'Only a building-wide notice names blocks');
        blockIds = await this.checkBlocks(tx, notice.propertyId, patch.blockIds);
      }
      await tx
        .update(schema.notice)
        .set({ subtype, fields, blockIds, returnedReason: null, updatedAt: this.clock.now() })
        .where(eq(schema.notice.id, noticeId));
    });
    return this.get(staff, noticeId);
  }

  async discard(actor: Actor | null, noticeId: string) {
    const staff = await this.drafter(actor);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await this.syncedRow(tx, noticeId, staff.personId);
      await this.transition(tx, notice, { kind: 'cancelled' }, staff.personId);
      await tx
        .update(schema.notice)
        .set({ status: 'cancelled', updatedAt: this.clock.now() })
        .where(eq(schema.notice.id, noticeId));
    });
    return this.get(staff, noticeId);
  }

  /** Sends a draft for approval (decision 8): through the approvals engine, for any type. */
  async submit(actor: Actor | null, noticeId: string) {
    const staff = await this.drafter(actor);
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await this.syncedRow(tx, noticeId, staff.personId);
      const type = notice.type as NoticeType;
      guard(() => checkNoticeFields(type, notice.fields as Record<string, unknown>));
      await this.refuseBlocked(tx, notice);
      await this.transition(tx, notice, { kind: 'submitted' }, staff.personId);
      const requestId = await this.approvals.createInTx(tx, staff, {
        actionType: NOTICE_TYPE_RULES[type].twoPersonApproval
          ? NOTICE_ISSUE_QUIT_ACTION
          : NOTICE_ISSUE_ACTION,
        subjectType: 'notice',
        subjectId: notice.id,
        payload: { noticeId: notice.id, contentHash: contentHash(notice) },
        propertyId: notice.propertyId,
      });
      await tx
        .update(schema.notice)
        .set({
          status: 'pending_approval',
          approvalRequestId: requestId,
          returnedReason: null,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.notice.id, noticeId));
    });
    return this.get(staff, noticeId);
  }

  /** Takes a notice back from approval to change it; its request is withdrawn. */
  async returnToDraft(actor: Actor | null, noticeId: string) {
    const staff = await this.drafter(actor);
    const requestId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await this.syncedRow(tx, noticeId, staff.personId);
      if (notice.status === 'draft') return null;
      if (notice.status !== 'pending_approval')
        throw conflict(
          'notice_transition',
          'Only a notice waiting for approval goes back to draft',
        );
      return notice.approvalRequestId;
    });
    // The engine closes the request in its own transaction (the initiator withdraws it); the
    // notice follows it back to draft. A refusal is never swallowed (review S5).
    if (requestId)
      try {
        await this.approvals.cancel(staff, requestId);
      } catch (error) {
        const status = await withCompany(
          this.database,
          staffContext(staff),
          async (tx) => (await this.approvals.requestsIn(tx, [requestId])).get(requestId)?.status,
        );
        if (status === 'pending' || status === 'cooling_off')
          throw conflict(
            'notice_return_refused',
            'Only the person who submitted this notice can take it back while it waits for approval. Ask them, or ask the approver to reject it.',
          );
        if (status === 'approved')
          throw conflict(
            'notice_transition',
            'This notice was approved meanwhile, so it can no longer go back to draft',
          );
        if (status !== 'rejected' && status !== 'expired' && status !== 'cancelled') throw error;
      }
    await withCompany(this.database, staffContext(staff), async (tx) => {
      await this.syncedRow(tx, noticeId, staff.personId, {
        code: 'notice.taken_back',
        message: 'Taken back to draft to change it',
      });
    });
    return this.get(staff, noticeId);
  }

  /**
   * Issues a notice now (plan 4.6), by a person with notice authority: a draft (approved by them
   * here) or an approved notice. A notice to quit issues only through its two-person approval.
   */
  async issue(actor: Actor | null, noticeId: string) {
    const staff = await this.reader(actor);
    this.policy.assert(staff, 'notices.issue');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await this.syncedRow(tx, noticeId, staff.personId);
      const type = notice.type as NoticeType;
      if (NOTICE_TYPE_RULES[type].twoPersonApproval)
        throw conflict(
          'notice_two_person_required',
          'A notice to quit needs a second person’s approval: submit it, and it issues once approved',
        );
      if (notice.status === 'pending_approval')
        throw conflict('notice_in_approval', 'This notice is waiting for approval');
      if (notice.status === 'draft')
        await this.transition(tx, notice, { kind: 'approved' }, staff.personId);
      else if (notice.status !== 'approved')
        throw conflict('notice_transition', `A notice that is ${notice.status} cannot be issued`);
      const result = await this.issueIn(tx, await noticeRow(tx, noticeId, true), staff.personId);
      if (!result.issued)
        throw conflict(
          codeOf(result.blockers[0]?.code ?? 'notice.issue_refused'),
          result.blockers.map((b) => b.message).join(' '),
        );
    });
    return this.get(staff, noticeId);
  }

  // Ladder, service, closure and corrections (plan 4.7, 4.8) ---------------------------------------

  async controlLadder(
    actor: Actor | null,
    noticeId: string,
    action: 'pause' | 'resume' | 'cancel',
    reason: string,
  ) {
    const staff = await this.reader(actor);
    this.policy.assert(staff, 'notices.ladder.control');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await noticeRow(tx, noticeId, true);
      const flags: NoticeLadderFlags = {
        paused: notice.ladderPaused,
        cancelled: notice.ladderCancelled,
      };
      const next = guard(() =>
        checkLadderControl({ status: notice.status as NoticeStatus, flags, action, reason }),
      );
      const now = this.clock.now();
      // Review D-B: a resume moves the remaining steps on by the time the ladder was paused.
      const pausedSeconds =
        action === 'resume' && notice.ladderPaused && notice.ladderChangedAt
          ? Math.max(0, Math.floor((now.getTime() - notice.ladderChangedAt.getTime()) / 1000))
          : 0;
      await tx
        .update(schema.notice)
        .set({
          ladderPaused: next.paused,
          ladderCancelled: next.cancelled,
          ladderReason: reason.trim(),
          ladderChangedAt: now,
          ladderChangedBy: staff.personId,
          ladderShiftSeconds: notice.ladderShiftSeconds + pausedSeconds,
          updatedAt: now,
        })
        .where(eq(schema.notice.id, noticeId));
      await recordEvent(tx, notice, {
        kind:
          action === 'pause'
            ? 'ladder_paused'
            : action === 'resume'
              ? 'ladder_resumed'
              : 'ladder_cancelled',
        at: now,
        actorPersonId: staff.personId,
        data: {
          reason: reason.trim(),
          ...(action === 'resume' ? { shiftedBySeconds: pausedSeconds } : {}),
        },
      });
      // Review S4: an escalation asked for while the ladder was paused waited; ask again.
      if (action === 'resume') {
        const events = await eventsOf(tx, noticeId);
        const requested = events.some((e) => e.kind === 'escalation_requested');
        const escalated = events.some((e) => e.dedupeKey === `escalated:${noticeId}`);
        if (requested && !escalated)
          await enqueueOutbox(tx, {
            companyId: notice.companyId,
            type: NOTICE_ESCALATE_JOB,
            payload: { noticeId },
            idempotencyKey: `${NOTICE_ESCALATE_JOB}:${noticeId}:resumed:${now.toISOString()}`,
          });
      }
    });
    return this.get(staff, noticeId);
  }

  async recordService(
    actor: Actor | null,
    noticeId: string,
    input: {
      method: ServiceMethod;
      servedAt: string;
      servedByPersonId?: string | null;
      servedByName?: string | null;
      witnessName?: string | null;
      recipientId?: string | null;
      notes?: string | null;
      photoUploadId?: string | null;
      affidavitUploadId?: string | null;
      correctsRecordId?: string | null;
    },
    claim: IdempotencyClaim | null = null,
  ) {
    const staff = await this.reader(actor);
    this.policy.assert(staff, 'notices.service.record');
    const servedAt = new Date(input.servedAt);
    if (Number.isNaN(servedAt.getTime()))
      throw invalid('served_at_invalid', 'Give the time it was served');
    if (servedAt.getTime() > this.clock.now().getTime() + 5 * 60_000)
      throw invalid('served_at_future', 'Service cannot be recorded for a time still to come');
    const ctx = { companyId: staff.companyId, personId: staff.personId };
    const photo = input.photoUploadId
      ? await this.documents.stageEvidenceUpload(ctx, input.photoUploadId, NOTICE_PHOTO_UPLOAD)
      : null;
    const affidavit = input.affidavitUploadId
      ? await this.documents.stageEvidenceUpload(
          ctx,
          input.affidavitUploadId,
          NOTICE_AFFIDAVIT_UPLOAD,
        )
      : null;
    await withCompany(this.database, staffContext(staff), async (tx) => {
      await claim?.claim(tx);
      const notice = await noticeRow(tx, noticeId, true);
      if (!LIVE.includes(notice.status) && notice.status !== 'closed')
        throw conflict('notice_not_issued', 'Only an issued notice is served');
      if (notice.issuedAt && servedAt.getTime() < notice.issuedAt.getTime())
        throw invalid('served_before_issue', 'A notice cannot be served before it was issued');
      const recipients = await recipientsOf(tx, noticeId);
      const recipient = input.recipientId
        ? recipients.find((r) => r.id === input.recipientId)
        : null;
      if (input.recipientId && !recipient) throw notFound('Recipient');
      if (input.correctsRecordId) {
        const [old] = await tx
          .select({ id: schema.serviceRecord.id })
          .from(schema.serviceRecord)
          .where(
            and(
              eq(schema.serviceRecord.id, input.correctsRecordId),
              eq(schema.serviceRecord.noticeId, noticeId),
            ),
          );
        if (!old) throw notFound('Service record');
      }
      let servedByName = input.servedByName?.trim() ?? '';
      if (input.servedByPersonId) {
        const [person] = await tx
          .select({ name: schema.person.name })
          .from(schema.person)
          .innerJoin(
            schema.membership,
            and(
              eq(schema.membership.personId, schema.person.id),
              eq(schema.membership.companyId, staff.companyId),
            ),
          )
          .where(eq(schema.person.id, input.servedByPersonId));
        if (!person)
          throw invalid('served_by_unknown', 'The person who served it is not on this account');
        servedByName = person.name;
      }
      if (servedByName.length < 2) throw invalid('served_by_required', 'Say who served it');
      const photoId = photo
        ? await this.documents.recordStagedEvidence(tx, photo, 'notice_service_photo')
        : null;
      const affidavitId = affidavit
        ? await this.documents.recordStagedEvidence(tx, affidavit, 'notice_affidavit')
        : null;
      const now = this.clock.now();
      try {
        await tx.insert(schema.serviceRecord).values({
          companyId: staff.companyId,
          propertyId: notice.propertyId,
          noticeId,
          recipientId: recipient?.id ?? null,
          method: input.method,
          servedAt,
          servedByPersonId: input.servedByPersonId ?? null,
          servedByName,
          witnessName: input.witnessName?.trim() || null,
          notes: input.notes?.trim() || null,
          photoDocumentId: photoId,
          affidavitDocumentId: affidavitId,
          correctsRecordId: input.correctsRecordId ?? null,
          recordedBy: staff.personId,
          recordedAt: now,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw conflict('service_record_corrected', 'That record has been corrected already');
        throw error;
      }
      await recordEvent(tx, notice, {
        kind: 'served',
        at: now,
        recipient,
        actorPersonId: staff.personId,
        data: {
          method: input.method,
          servedAt: servedAt.toISOString(),
          corrects: input.correctsRecordId ?? null,
        },
      });
      await this.tasks.closeOpen(
        tx,
        {
          noticeId,
          kinds:
            input.method === 'posted_on_premises'
              ? ['notice_post_on_premises', 'notice_physical_service']
              : ['notice_physical_service'],
          recipientIds: recipient
            ? (await recipientsOf(tx, noticeId))
                .filter((r) => partyKeyOf(r) === partyKeyOf(recipient))
                .map((r) => r.id)
            : null,
        },
        'done',
        `Service recorded: ${SERVICE_METHOD_LABELS[input.method]}`,
        staff.personId,
      );
      await this.checkLateService(tx, notice, servedAt, now);
      if (LIVE.includes(notice.status)) await syncStatus(tx, notice, now);
      await claim?.done(tx, { noticeId });
    });
    for (const staged of [photo, affidavit])
      if (staged) await this.documents.discardStagedUpload(staged);
    return this.get(staff, noticeId);
  }

  async createUpload(
    actor: Actor | null,
    input: {
      purpose: 'service_photo' | 'affidavit' | 'received_notice' | 'rent_assessment';
      contentType: string;
      sizeBytes: number;
    },
  ) {
    const staff = await this.reader(actor);
    const purpose: UploadPurpose = {
      service_photo: NOTICE_PHOTO_UPLOAD,
      affidavit: NOTICE_AFFIDAVIT_UPLOAD,
      received_notice: NOTICE_RECEIVED_UPLOAD,
      rent_assessment: RENT_ASSESSMENT_UPLOAD,
    }[input.purpose];
    this.policy.assert(
      staff,
      input.purpose === 'rent_assessment'
        ? 'rent_assessment.record'
        : input.purpose === 'received_notice'
          ? 'notices.draft'
          : 'notices.service.record',
    );
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      purpose,
      input.contentType,
      input.sizeBytes,
    );
  }

  /** Closes a notice (decision 12; plan 4.8): an outcome and a note. Nothing ends the lease. */
  async close(actor: Actor | null, noticeId: string, outcome: NoticeOutcome, note: string) {
    const staff = await this.reader(actor);
    this.policy.assert(staff, 'notices.close');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await noticeRow(tx, noticeId, true);
      const closure = guard(() =>
        checkNoticeClose({ status: notice.status as NoticeStatus, outcome, note }),
      );
      await this.closeIn(tx, notice, closure.outcome, closure.note, staff.personId);
    });
    return this.get(staff, noticeId);
  }

  /** Starts a correction (plan 4.8): a draft copy that references the notice it replaces. */
  async correct(actor: Actor | null, noticeId: string) {
    const staff = await this.drafter(actor);
    return this.get(staff, (await this.correctRecord(staff, noticeId, null)).noticeId);
  }

  /** The correction's draft, under the request's Idempotency-Key claim (review C5). */
  async correctRecord(
    actor: Actor | null,
    noticeId: string,
    claim: IdempotencyClaim | null,
  ): Promise<{ noticeId: string }> {
    const staff = await this.drafter(actor);
    const original = await withCompany(this.database, staffContext(staff), (tx) =>
      noticeRow(tx, noticeId),
    );
    return this.createRecord(
      staff,
      {
        type: original.type as NoticeType,
        subtype: original.subtype,
        leaseId: original.leaseId,
        propertyId: original.leaseId ? null : original.propertyId,
        blockIds: original.blockIds,
        fields: original.fields as Record<string, unknown>,
        correctsNoticeId: original.id,
      },
      claim,
    );
  }

  /** A link to hand over as a QR code (decision 6): earlier links keep working. */
  async handoverLink(actor: Actor | null, noticeId: string, recipientId: string) {
    const staff = await this.reader(actor);
    this.policy.assert(staff, 'notices.issue');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await noticeRow(tx, noticeId);
      const [recipient] = await tx
        .select()
        .from(schema.noticeRecipient)
        .where(
          and(
            eq(schema.noticeRecipient.id, recipientId),
            eq(schema.noticeRecipient.noticeId, noticeId),
          ),
        );
      if (!recipient) throw notFound('Recipient');
      if (!recipient.signerId || !recipient.signingRequestId)
        throw conflict(
          'link_unavailable',
          'This recipient has no phone or email to sign with; serve them in person',
        );
      const link = await this.esign.issueLink(tx, {
        signingRequestId: recipient.signingRequestId,
        signerId: recipient.signerId,
        createdBy: staff.personId,
      });
      await recordEvent(tx, notice, {
        kind: 'link_issued',
        at: this.clock.now(),
        recipient,
        actorPersonId: staff.personId,
        data: { via: 'handover', expiresAt: link.expiresAt.toISOString() },
      });
      return link;
    });
  }

  async download(
    actor: Actor | null,
    noticeId: string,
    which: 'notice' | 'signed' | 'service_pack' | 'service_photo' | 'affidavit' | 'received',
    recordId?: string,
  ): Promise<string> {
    const staff = await this.reader(actor);
    const found = await withCompany(this.database, staffContext(staff), async (tx) => {
      const notice = await noticeRow(tx, noticeId);
      const name = numberOf(notice) ?? 'notice';
      switch (which) {
        case 'notice':
          return { id: notice.documentId, name: `${name}.pdf` };
        case 'service_pack':
          return { id: notice.servicePackDocumentId, name: `${name}-service-pack.pdf` };
        case 'received':
          return {
            id: (notice.fields as { documentId?: string }).documentId ?? null,
            name: `${name}-received`,
          };
        case 'signed': {
          const requests = await this.esign.noticeRequests(tx, noticeId);
          const done = requests.filter((r) => r.request.finalDocumentId);
          const chosen = recordId
            ? done.find(
                (r) => r.signers.some((s) => s.id === recordId) || r.request.id === recordId,
              )
            : done[0];
          return { id: chosen?.request.finalDocumentId ?? null, name: `${name}-acknowledged.pdf` };
        }
        default: {
          if (!recordId) throw invalid('record_required', 'Name the service record');
          const [record] = await tx
            .select()
            .from(schema.serviceRecord)
            .where(
              and(
                eq(schema.serviceRecord.id, recordId),
                eq(schema.serviceRecord.noticeId, noticeId),
              ),
            );
          if (!record) throw notFound('Service record');
          return {
            id: which === 'service_photo' ? record.photoDocumentId : record.affidavitDocumentId,
            name: `${name}-${which}`,
          };
        }
      }
    });
    if (!found.id) throw notFound('Document');
    const url = await this.documents.downloadUrl(staff.companyId, found.id, found.name);
    if (!url) throw notFound('Document');
    return url;
  }

  /** Decision 13: a notice the tenant gave, recorded with its document. */
  async recordReceived(
    actor: Actor | null,
    input: {
      leaseId: string;
      subtype: 'intention_to_vacate' | 'complaint';
      receivedOn: string;
      receivedVia: string;
      uploadId: string;
      details?: string | null;
    },
    claim: IdempotencyClaim | null = null,
  ) {
    const staff = await this.drafter(actor);
    const staged = await this.documents.stageEvidenceUpload(
      { companyId: staff.companyId, personId: staff.personId },
      input.uploadId,
      NOTICE_RECEIVED_UPLOAD,
    );
    const id = await withCompany(this.database, staffContext(staff), async (tx) => {
      await claim?.claim(tx);
      const target = await this.resolveTarget(tx, {
        type: 'tenant_originated',
        leaseId: input.leaseId,
      });
      const documentId = await this.documents.recordStagedEvidence(tx, staged, 'notice_received');
      const fields = guard(() =>
        checkNoticeFields('tenant_originated', {
          receivedOn: input.receivedOn,
          receivedVia: input.receivedVia,
          documentId,
          ...(input.details ? { details: input.details } : {}),
        }),
      );
      const now = this.clock.now();
      if (
        parseBusinessDate(input.receivedOn).toString() >
        this.today(await companyFacts(tx, staff.companyId))
      )
        throw invalid('received_on_future', 'The date received cannot be in the future');
      const [row] = await tx
        .insert(schema.notice)
        .values({
          companyId: staff.companyId,
          type: 'tenant_originated',
          subtype: input.subtype,
          status: 'received',
          propertyId: target.propertyId,
          unitId: target.unitId,
          leaseId: target.lease!.id,
          tenantId: target.tenantId,
          fields,
          templateKey: NOTICE_TEMPLATE.key,
          templateVersion: NOTICE_TEMPLATE.version,
          createdBy: staff.personId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await recordEvent(tx, row!, {
        kind: 'received',
        at: now,
        actorPersonId: staff.personId,
        data: { receivedOn: input.receivedOn, receivedVia: input.receivedVia },
      });
      await claim?.done(tx, { noticeId: row!.id });
      return row!.id;
    });
    await this.documents.discardStagedUpload(staged);
    return this.get(staff, id);
  }

  // For the tracking service and the approval handlers --------------------------------------------

  /**
   * The approval completed (decision 8): issue now, in the deciding transaction. If the date or the
   * bar no longer holds, the notice goes back to draft with the reason (plan 4.3).
   */
  async onApproved(tx: Tx, noticeId: string, approvedBy: string): Promise<void> {
    const notice = await noticeRow(tx, noticeId, true);
    if (notice.status !== 'pending_approval') return;
    // The approver approved it and, by approving, issued it (review notes).
    await this.transition(tx, notice, { kind: 'approved' }, approvedBy);
    await tx
      .update(schema.notice)
      .set({ status: 'approved', updatedAt: this.clock.now() })
      .where(eq(schema.notice.id, noticeId));
    const result = await this.issueIn(tx, await noticeRow(tx, noticeId, true), approvedBy);
    if (!result.issued) {
      const reason = result.blockers.map((b) => b.message).join(' ');
      const now = this.clock.now();
      await recordEvent(tx, notice, {
        kind: 'returned_to_draft',
        at: now,
        data: {
          code: result.blockers[0]?.code ?? 'notice.issue_refused',
          reason,
          blockers: result.blockers,
          approvalRequestId: notice.approvalRequestId,
        },
        dedupeKey: notice.approvalRequestId ? `returned:${notice.approvalRequestId}` : null,
      });
      await tx
        .update(schema.notice)
        .set({
          status: 'draft',
          returnedReason: reason.slice(0, 2000),
          approvalRequestId: null,
          updatedAt: now,
        })
        .where(eq(schema.notice.id, noticeId));
    }
  }

  /**
   * NoticesService.issue's transaction (plan 4.6): checks the date and the bar again, takes the next
   * number, snapshots the fields, recipients and ladder, requests the frozen PDF and opens a signing
   * request per party. Returns the blockers instead when something no longer holds.
   */
  private async issueIn(
    tx: Tx,
    notice: NoticeRow,
    issuedBy: string | null,
  ): Promise<{ issued: true } | { issued: false; blockers: NoticeIssueBlocker[] }> {
    const type = notice.type as NoticeType;
    const company = await companyFacts(tx, notice.companyId);
    const now = this.clock.now();
    const issueDate = toIsoDate(businessDateOf(instantFrom(now), company.timeZone));
    const fields = guard(() => checkNoticeFields(type, notice.fields as Record<string, unknown>));
    const target = await this.targetOf(tx, notice);
    const evaluation = await this.evaluate(tx, company, {
      type,
      subtype: notice.subtype,
      fields,
      target,
      issueDate,
    });
    if (evaluation.blockers.length > 0) return { issued: false, blockers: evaluation.blockers };
    // Review S6: a correction replaces a live notice; one closed meanwhile has nothing to correct.
    if (notice.correctsNoticeId) {
      const original = await noticeRow(tx, notice.correctsNoticeId, true);
      if (!LIVE.includes(original.status))
        return {
          issued: false,
          blockers: [
            {
              code: 'notice.correction_original_closed',
              message: `The notice this corrects is ${original.status} now, so there is nothing to correct. Discard this draft, or start a new notice.`,
            },
          ],
        };
    }
    if (evaluation.recipients.length === 0)
      return {
        issued: false,
        blockers: [{ code: 'notice.no_recipients', message: 'Nobody would receive this notice' }],
      };

    const number = await this.nextNumber(tx, notice.companyId);
    const settings = noticeSettingsOf(company.settings);
    const ladder = noticeLadderFor(type, settings);
    const linkExpiresAt = noticeLinkExpiresAt({
      type,
      issuedAt: now,
      effectiveDate: effectiveDateOf(type, fields),
      timeZone: company.timeZone,
      noPeriodDays: settings.linkExpiryDays,
    });
    const replaces = await this.correctsNumber(tx, notice);
    const content = noticeDocumentContent({
      type,
      subtype: (notice.subtype as NoticeSubtype | null) ?? null,
      fields,
      number: formatNoticeNumber(number),
      issueDate,
      landlordName: company.displayName,
      propertyName: target.propertyName,
      premises: premisesOf(target),
      recipients: [...new Set(evaluation.recipients.map((r) => r.name))],
      replaces,
      counselReviewed: notice.counselReviewed,
    });
    const renderRequestId = await this.documents.requestRender(tx, {
      companyId: notice.companyId,
      templateKey: NOTICE_TEMPLATE.key,
      templateVersion: NOTICE_TEMPLATE.version,
      data: content as unknown as Record<string, unknown>,
      requestedBy: issuedBy,
    });

    // One signing request per party (decision 7): a company tenant's signatories share one, and
    // the first signature acknowledges for the company (any_one); a co-tenant has their own.
    const byParty = new Map<string, PlannedRecipient[]>();
    for (const r of evaluation.recipients)
      byParty.set(r.partyKey, [...(byParty.get(r.partyKey) ?? []), r]);
    let position = 0;
    const inserted: RecipientRow[] = [];
    for (const [, members] of byParty) {
      const tenantId = members[0]!.tenantId;
      const signable = members.filter((m) => m.phone || m.email);
      const opened = signable.length
        ? await this.esign.openNoticeRequest(tx, {
            companyId: notice.companyId,
            propertyId: notice.propertyId,
            tenantId,
            leaseId: members[0]!.leaseId,
            noticeId: notice.id,
            renderRequestId,
            createdBy: issuedBy,
            completionRule:
              signable.length > 1 && signable.every((m) => m.kind === 'signatory')
                ? 'any_one'
                : 'all_required',
            linksExpireAt: linkExpiresAt,
            signers: signable.map((m) => ({
              role: m.kind === 'signatory' ? 'signatory' : 'tenant',
              subject: m.tenantContactId
                ? { type: 'tenant_contact', contactId: m.tenantContactId }
                : { type: 'tenant' },
              leasePartyId: null,
              name: m.name,
              phone: m.phone,
              email: m.email,
              required: true,
              isTestContact: m.isTestContact,
            })),
          })
        : null;
      for (const m of members) {
        position += 1;
        const signerIndex = signable.indexOf(m);
        const [row] = await tx
          .insert(schema.noticeRecipient)
          .values({
            companyId: notice.companyId,
            propertyId: notice.propertyId,
            noticeId: notice.id,
            tenantId,
            leaseId: m.leaseId,
            unitId: m.unitId,
            kind: m.kind,
            tenantContactId: m.tenantContactId,
            name: m.name,
            phone: m.phone,
            whatsappPhone: m.whatsappPhone,
            email: m.email,
            channels: m.channels,
            physicalServicePlanned: m.physicalServicePlanned,
            signingRequestId: opened && signerIndex >= 0 ? opened.requestId : null,
            signerId: opened && signerIndex >= 0 ? (opened.signerIds[signerIndex] ?? null) : null,
            position,
            isTestContact: m.isTestContact,
            createdAt: now,
          })
          .returning();
        inserted.push(row!);
      }
    }

    await tx
      .update(schema.notice)
      .set({
        status: 'sent',
        number,
        fields,
        issueDate,
        issuedAt: now,
        effectiveDate: effectiveDateOf(type, fields),
        earliestLawfulDate: evaluation.earliestDate,
        earliest: evaluation.earliest,
        warnings: evaluation.warnings,
        ruleVersions: evaluation.ruleVersions,
        statutoryRuleId: evaluation.statutoryRuleId,
        barRuleId: evaluation.barRuleId,
        electronicService: evaluation.electronicService,
        ladder,
        linkExpiresAt,
        renderRequestId,
        returnedReason: null,
        updatedAt: now,
      })
      .where(eq(schema.notice.id, notice.id));
    const issued = await noticeRow(tx, notice.id);
    await recordEvent(tx, issued, {
      kind: 'sent',
      at: now,
      actorPersonId: issuedBy,
      data: { number: formatNoticeNumber(number), recipients: inserted.length },
      dedupeKey: `sent:${notice.id}`,
    });
    for (const r of inserted)
      for (const c of r.channels as { channel: string; mode: string; reason: string | null }[])
        if (c.mode === 'withheld')
          await recordEvent(tx, issued, {
            kind: 'channel_withheld',
            at: now,
            recipient: r,
            channel: c.channel,
            data: { reason: c.reason, at: 'issue' },
          });
    // Decision 10: every notice to quit is posted on the premises, signed or not.
    if (NOTICE_TYPE_RULES[type].postOnPremises)
      await this.tasks.create(tx, {
        companyId: notice.companyId,
        propertyId: notice.propertyId,
        unitId: notice.unitId,
        tenantId: notice.tenantId,
        kind: 'notice_post_on_premises',
        title: `Post notice ${formatNoticeNumber(number)} on the premises`,
        noticeId: notice.id,
        recipientId: null,
        assigneePersonId: await this.tasks.assigneeFor(tx, notice.companyId, notice.propertyId),
        dueAt: new Date(now.getTime() + 24 * HOUR),
        dedupeKey: `notice:${notice.id}:post_on_premises`,
        createdBy: issuedBy,
      });
    // Decisions 4 and 5: a party nobody can serve electronically is served in person.
    const parties = new Map<string, RecipientRow>();
    for (const r of inserted)
      if (
        !parties.has(partyKeyOf(r)) &&
        !inserted.some((x) => partyKeyOf(x) === partyKeyOf(r) && !x.physicalServicePlanned)
      )
        parties.set(partyKeyOf(r), r);
    for (const [party, r] of parties)
      await this.tasks.create(tx, {
        companyId: notice.companyId,
        propertyId: notice.propertyId,
        unitId: r.unitId,
        tenantId: r.tenantId,
        kind: 'notice_physical_service',
        title: `Serve notice ${formatNoticeNumber(number)} on ${r.name} in person`,
        noticeId: notice.id,
        recipientId: r.id,
        assigneePersonId: await this.tasks.assigneeFor(tx, notice.companyId, notice.propertyId),
        dueAt: new Date(now.getTime() + 48 * HOUR),
        dedupeKey: `notice:${notice.id}:physical_service:${party}`,
        createdBy: issuedBy,
      });
    // Plan 4.8: issuing a correction closes the notice it replaces as superseded.
    if (notice.correctsNoticeId) {
      const original = await noticeRow(tx, notice.correctsNoticeId, true);
      const closure = supersededClosure({
        originalStatus: original.status as NoticeStatus,
        correctionNumber: formatNoticeNumber(number),
      });
      if (closure) await this.closeIn(tx, original, 'superseded', closure.note, issuedBy);
    }
    await this.audit.append(tx, {
      companyId: notice.companyId,
      action: 'notice.issued',
      recordType: 'notice',
      recordId: notice.id,
      data: {
        number: formatNoticeNumber(number),
        type,
        renderRequestId,
        effectiveDate: effectiveDateOf(type, fields),
        earliestLawfulDate: evaluation.earliestDate,
        ruleVersions: evaluation.ruleVersions,
        recipients: inserted.length,
      },
    });
    return { issued: true };
  }

  /** Closes a notice in the caller's transaction: its requests stop, its open tasks are cancelled. */
  async closeIn(
    tx: Tx,
    notice: NoticeRow,
    outcome: NoticeOutcome,
    note: string,
    by: string | null,
  ): Promise<void> {
    const now = this.clock.now();
    await tx
      .update(schema.notice)
      .set({
        status: 'closed',
        outcome,
        closeNote: note,
        closedAt: now,
        closedBy: by,
        updatedAt: now,
      })
      .where(eq(schema.notice.id, notice.id));
    await recordEvent(tx, notice, {
      kind: 'closed',
      at: now,
      actorPersonId: by,
      data: { outcome, note },
      dedupeKey: `closed:${notice.id}`,
    });
    await this.esign.closeForNotice(tx, notice.id, { reason: `Notice closed: ${outcome}`, by });
    await this.tasks.closeOpen(
      tx,
      {
        noticeId: notice.id,
        kinds: ['notice_in_person_reminder', 'notice_post_on_premises', 'notice_physical_service'],
      },
      'cancelled',
      `The notice closed (${outcome})`,
      by,
    );
    await this.audit.append(tx, {
      companyId: notice.companyId,
      action: 'notice.closed',
      recordType: 'notice',
      recordId: notice.id,
      // Plan 4.8: closing records an outcome; it never ends the lease or touches the unit.
      data: { outcome, note, leaseAction: 'none' },
    });
  }

  // Internals -------------------------------------------------------------------------------------

  private async reader(actor: Actor | null): Promise<StaffActor> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'notices.read');
    await this.entitlements.assert(staff.companyId, 'notices');
    return staff;
  }

  private async drafter(actor: Actor | null): Promise<StaffActor> {
    const staff = await this.reader(actor);
    this.policy.assert(staff, 'notices.draft');
    return staff;
  }

  private today(company: CompanyFacts): string {
    return toIsoDate(businessDateOf(instantFrom(this.clock.now()), company.timeZone));
  }

  private async quitEnabledIn(tx: Tx): Promise<boolean> {
    const rows = await tx
      .select({ action: schema.noticeQuitAcknowledgement.action })
      .from(schema.noticeQuitAcknowledgement)
      .orderBy(asc(schema.noticeQuitAcknowledgement.at), asc(schema.noticeQuitAcknowledgement.id));
    return quitNoticesEnabled(rows.map((r) => ({ action: r.action as 'grant' | 'withdraw' })));
  }

  /** Gap-free per company (decision 15), on the receipts' counter: rolled back with the issue. */
  private async nextNumber(tx: Tx, companyId: string): Promise<number> {
    const result = await tx.execute<{ value: number }>(
      sql`insert into company_counter (company_id, name, value) values (${companyId}, 'notice', 1)
          on conflict (company_id, name) do update set value = company_counter.value + 1
          returning value`,
    );
    return Number(result.rows[0]!.value);
  }

  /** Runs a transition through the state machine and records its event (plan 4.4). */
  private async transition(
    tx: Tx,
    notice: NoticeRow,
    event: { kind: 'submitted' | 'returned_to_draft' | 'approved' | 'cancelled' },
    by: string | null,
  ): Promise<void> {
    const events = await eventsOf(tx, notice.id);
    const recipients = await recipientsOf(tx, notice.id);
    const facts = factsOf(events);
    // Drafts that came back from approval resume from draft whatever their history says.
    const history =
      notice.status === 'draft'
        ? facts.filter((f) => !['submitted', 'approved'].includes(f.kind))
        : facts;
    guard(() =>
      applyNoticeEvent({
        type: notice.type as NoticeType,
        events:
          notice.status === 'draft'
            ? history.filter((f) => f.kind !== 'returned_to_draft')
            : history,
        recipients: recipientRefs(recipients),
        completion: notice.completion as 'any_one' | 'each',
        event,
      }),
    );
    await recordEvent(tx, notice, { kind: event.kind, at: this.clock.now(), actorPersonId: by });
  }

  /**
   * The notice, with a pending approval that closed without approving (rejected, expired or
   * withdrawn) brought back to draft first: the engine has no hook for that, so writes catch up.
   */
  private async syncedRow(
    tx: Tx,
    noticeId: string,
    by: string | null,
    /** Why, when staff took the notice back themselves (review C1); otherwise the request's end. */
    takenBack?: { readonly code: string; readonly message: string },
  ): Promise<NoticeRow> {
    const notice = await noticeRow(tx, noticeId, true);
    if (notice.status !== 'pending_approval' || !notice.approvalRequestId) return notice;
    const requests = await this.approvals.requestsIn(tx, [notice.approvalRequestId]);
    const status = requests.get(notice.approvalRequestId)?.status;
    if (status === 'pending' || status === 'cooling_off' || status === 'approved') return notice;
    const returned =
      takenBack && status === 'cancelled' ? takenBack : returnedForApproval(status ?? 'cancelled');
    const now = this.clock.now();
    await recordEvent(tx, notice, {
      kind: 'returned_to_draft',
      at: now,
      actorPersonId: by,
      data: {
        code: returned.code,
        reason: returned.message,
        approvalRequestId: notice.approvalRequestId,
      },
      dedupeKey: `returned:${notice.approvalRequestId}`,
    });
    await tx
      .update(schema.notice)
      .set({
        status: 'draft',
        approvalRequestId: null,
        returnedReason: returned.message,
        updatedAt: now,
      })
      .where(eq(schema.notice.id, noticeId));
    return noticeRow(tx, noticeId, true);
  }

  private async refuseBlocked(tx: Tx, notice: NoticeRow): Promise<void> {
    const company = await companyFacts(tx, notice.companyId);
    const evaluation = await this.evaluate(tx, company, {
      type: notice.type as NoticeType,
      subtype: notice.subtype,
      fields: notice.fields as Record<string, unknown>,
      target: await this.targetOf(tx, notice),
      issueDate: this.today(company),
    });
    const first = evaluation.blockers[0];
    if (first)
      throw conflict(codeOf(first.code), evaluation.blockers.map((b) => b.message).join(' '));
  }

  private async resolveTarget(tx: Tx, input: ComposeTarget): Promise<Target> {
    const rules = NOTICE_TYPE_RULES[input.type];
    if (rules.needsLease) {
      if (!input.leaseId)
        throw invalid('lease_required', 'Choose the lease this notice is served under');
      const [lease] = await tx
        .select()
        .from(schema.lease)
        .where(eq(schema.lease.id, input.leaseId));
      if (!lease) throw notFound('Lease');
      if (!NOTICE_LEASE_STATUSES.includes(lease.status))
        throw conflict('notice_lease_not_signed', 'A notice is served under a signed lease');
      return this.leaseTarget(tx, lease);
    }
    if (!input.propertyId) throw invalid('property_required', 'Choose the property');
    const [property] = await tx
      .select({ id: schema.property.id, name: schema.property.name })
      .from(schema.property)
      .where(eq(schema.property.id, input.propertyId));
    if (!property) throw notFound('Property');
    const blockIds = await this.checkBlocks(tx, property.id, input.blockIds ?? []);
    const blocks = blockIds.length
      ? await tx
          .select({ code: schema.block.code })
          .from(schema.block)
          .where(inArray(schema.block.id, blockIds))
      : [];
    return {
      lease: null,
      propertyId: property.id,
      propertyName: property.name,
      unitId: null,
      unitCode: null,
      tenantId: null,
      tenantName: null,
      blockIds,
      blockCodes: blocks.map((b) => b.code),
    };
  }

  private async leaseTarget(tx: Tx, lease: LeaseRow): Promise<Target> {
    const [property] = await tx
      .select({ name: schema.property.name })
      .from(schema.property)
      .where(eq(schema.property.id, lease.propertyId));
    const [unit] = await tx
      .select({ code: schema.unit.code })
      .from(schema.unit)
      .where(eq(schema.unit.id, lease.unitId));
    const [tenant] = await tx
      .select({ name: schema.tenant.displayName })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, lease.tenantId));
    return {
      lease,
      propertyId: lease.propertyId,
      propertyName: property?.name ?? '',
      unitId: lease.unitId,
      unitCode: unit?.code ?? null,
      tenantId: lease.tenantId,
      tenantName: tenant?.name ?? null,
      blockIds: [],
      blockCodes: [],
    };
  }

  private async targetOf(tx: Tx, notice: NoticeRow): Promise<Target> {
    if (notice.leaseId) {
      const [lease] = await tx
        .select()
        .from(schema.lease)
        .where(eq(schema.lease.id, notice.leaseId));
      if (!lease) throw notFound('Lease');
      return this.leaseTarget(tx, lease);
    }
    return this.resolveTarget(tx, {
      type: notice.type as NoticeType,
      propertyId: notice.propertyId,
      blockIds: notice.blockIds,
    });
  }

  private async checkBlocks(
    tx: Tx,
    propertyId: string,
    blockIds: readonly string[],
  ): Promise<string[]> {
    const unique = [...new Set(blockIds)];
    if (unique.length === 0) return [];
    const rows = await tx
      .select({ id: schema.block.id })
      .from(schema.block)
      .where(and(eq(schema.block.propertyId, propertyId), inArray(schema.block.id, unique)));
    if (rows.length !== unique.length)
      throw invalid('notice_blocks', 'Choose blocks of this property');
    return unique.sort();
  }

  private async recipientsFor(
    tx: Tx,
    notice: NoticeRow,
    target: Target,
  ): Promise<{ name: string }[]> {
    if (!PRE_ISSUE.includes(notice.status) && notice.status !== 'cancelled')
      return recipientsOf(tx, notice.id);
    return planRecipients(
      tx,
      this.tenants,
      target.lease
        ? { kind: 'lease', lease: target.lease }
        : { kind: 'property', propertyId: target.propertyId, blockIds: target.blockIds },
    );
  }

  private async correctsNumber(tx: Tx, notice: NoticeRow): Promise<string | null> {
    if (!notice.correctsNoticeId) return null;
    const original = await noticeRow(tx, notice.correctsNoticeId);
    return numberOf(original);
  }

  /**
   * Arrears from the ledger for a rent demand (LN-01): the lease's overdue invoices with money
   * still owed, and their total, as of today in the company's time zone (review M2).
   */
  private async arrearsOf(tx: Tx, company: CompanyFacts, leaseId: string) {
    const open = (await this.billing.openInvoicesIn(tx, company.id, leaseId)).filter(
      (i) => i.overdue,
    );
    return {
      amountMinor: open.reduce((sum, i) => sum + i.outstandingMinor, 0),
      asOf: this.today(company),
      invoices: open.map((i) => ({
        id: i.id,
        number: i.number,
        dueDate: i.dueDate,
        outstandingMinor: i.outstandingMinor,
      })),
    };
  }

  /**
   * Review M2 (CLAUDE.md section 4): what a notice states about money and the lease must match the
   * records at submit and at issue. A rent demand names real, open, overdue invoices of the lease,
   * for exactly what the ledger says they still owe; a non-renewal names the lease's end date; a
   * rent review the rent in force on the issue date.
   */
  private async recordChecks(
    tx: Tx,
    company: CompanyFacts,
    type: NoticeType,
    fields: Record<string, unknown>,
    lease: LeaseRow,
    issueDate: string,
  ): Promise<NoticeIssueBlocker[]> {
    const out: NoticeIssueBlocker[] = [];
    if (type === 'rent_demand') {
      const named = Array.isArray(fields.invoiceIds) ? (fields.invoiceIds as string[]) : [];
      const open = new Map(
        (await this.billing.openInvoicesIn(tx, company.id, lease.id)).map((i) => [i.id, i]),
      );
      const unknown = named.filter((id) => !open.has(id));
      if (unknown.length > 0)
        out.push({
          code: 'notice.arrears_invoice_unknown',
          message:
            'An invoice named is not an open invoice of this lease (paid, cancelled or not this lease’s). Refresh the arrears from the ledger',
        });
      const notOverdue = named.filter((id) => open.get(id) && !open.get(id)!.overdue);
      if (notOverdue.length > 0)
        out.push({
          code: 'notice.arrears_invoice_not_overdue',
          message: `${notOverdue.map((id) => open.get(id)!.number).join(', ')} is not overdue yet; a rent demand names overdue invoices only`,
        });
      if (unknown.length === 0) {
        const owed = named.reduce((sum, id) => sum + open.get(id)!.outstandingMinor, 0);
        if (fields.arrearsMinor !== owed)
          out.push({
            code: 'notice.arrears_mismatch',
            message: `The arrears stated (${formatMoney(Number(fields.arrearsMinor ?? 0))}) differ from what the ledger shows these invoices still owe (${formatMoney(owed)}). Refresh the arrears from the ledger`,
          });
      }
      if (typeof fields.arrearsAsOf === 'string' && fields.arrearsAsOf > issueDate)
        out.push({
          code: 'notice.arrears_as_of_future',
          message: 'The arrears cannot be counted to a date after the notice is issued',
        });
    }
    if (type === 'non_renewal' && fields.leaseEndDate !== lease.endDate)
      out.push({
        code: 'notice.lease_end_mismatch',
        message: `The lease ends on ${lease.endDate}; the notice must state that date`,
      });
    if (type === 'rent_review') {
      const current = rentOn((await billingLeaseOf(tx, lease.id)).terms, issueDate);
      if (fields.currentRentMinor !== current)
        out.push({
          code: 'notice.current_rent_mismatch',
          message: `The rent in force on ${issueDate} is ${formatMoney(current)} a month; the notice must state that as the current rent`,
        });
    }
    return out;
  }

  /**
   * Everything the composer and issue check (plan 4.3): recipients and channels, the earliest lawful
   * date with the rules it read, warnings, the s.23 bar, OQ-16, and the fields.
   */
  private async evaluate(
    tx: Tx,
    company: CompanyFacts,
    input: {
      type: NoticeType;
      subtype: string | null;
      fields: Record<string, unknown>;
      target: Target;
      issueDate: string;
    },
  ): Promise<NoticeEvaluation> {
    const { type, target } = input;
    const rules = NOTICE_TYPE_RULES[type];
    const fieldErrors: { field: string; code: string; message: string }[] = [];
    try {
      checkNoticeSubtype(type, input.subtype);
    } catch (error) {
      if (error instanceof DomainError)
        fieldErrors.push({ field: 'subtype', code: error.code, message: error.message });
    }
    try {
      checkNoticeFields(type, input.fields);
    } catch (error) {
      if (error instanceof NoticeFieldError)
        fieldErrors.push({ field: error.field, code: error.code, message: error.message });
      else if (error instanceof DomainError)
        fieldErrors.push({ field: '', code: error.code, message: error.message });
    }
    const recipients = rules.issuable
      ? await planRecipients(
          tx,
          this.tenants,
          target.lease
            ? { kind: 'lease', lease: target.lease }
            : { kind: 'property', propertyId: target.propertyId, blockIds: target.blockIds },
        )
      : [];
    const clause = target.lease ? hasServiceClause(target.lease) : true;
    const electronic = servedElectronically(clause, recipients);
    const asOf = parseBusinessDate(input.issueDate);
    const ruleRow = async (key: string): Promise<NoticeRuleInput | null> => {
      try {
        const r = await this.rules.resolveIn(tx, company.countryCode, key, asOf);
        return {
          id: r.ruleId,
          key: r.key,
          value: r.value,
          verificationStatus: r.verificationStatus,
        };
      } catch (error) {
        if (error instanceof DomainError) return null;
        throw error;
      }
    };
    const statutoryRule =
      rules.usesStatutoryMinimum && target.lease
        ? await ruleRow(statutoryMinimumKey(target.lease.use as LeaseUse))
        : null;
    const barRule = rules.checksAssessmentBar ? await ruleRow(ASSESSMENT_BAR_KEY) : null;
    // Only active assessments count: a corrected or voided record never bars (review C4).
    const assessments =
      rules.checksAssessmentBar && target.unitId
        ? (await assessmentRecordsOf(tx, target.unitId))
            .filter((r) => r.status === 'active')
            .map((r) => ({ date: r.row.assessedOn }))
        : [];
    const effectiveInput: EarliestDateInput & { effectiveDate: string | null } = {
      type,
      lease: target.lease
        ? {
            use: target.lease.use as LeaseUse,
            noticeDays: target.lease.noticeDays,
            endDate: target.lease.endDate,
            electronicServiceClause: clause,
          }
        : null,
      electronicChannelsWithheld: clause && !electronic,
      issueDate: input.issueDate,
      statutoryRule,
      wordingReviewed: counselReviewedTemplate(NOTICE_TEMPLATE.key, NOTICE_TEMPLATE.version),
      effectiveDate: noticeKeyDate(type, input.fields),
    };
    const keyField = rules.keyDateField;
    const datePresent = !keyField || typeof input.fields[keyField] === 'string';
    const checks = datePresent
      ? noticeIssueBlockers({
          type,
          effective: effectiveInput,
          assessments,
          assessmentBarRule: barRule,
          quitAcknowledged: await this.quitEnabledIn(tx),
        })
      : null;
    const earliestCalc = checks?.effective?.earliest ?? null;
    const warnings: NoticeWarning[] = [
      ...(earliestCalc?.warnings ?? []),
      ...(checks?.quitBar?.warnings ?? []),
    ];
    if (type === 'notice_to_quit' && target.lease) {
      if (target.lease.noticeDays === 0)
        warnings.push({
          code: 'lease_notice_days_zero',
          message:
            'This lease gives 0 days’ notice, so no period is enforced from it, and the statutory minimum is unverified. Check the lease and counsel’s advice before relying on the date.',
          ruleKey: null,
        });
      if (assessments.length === 0)
        warnings.push({
          code: 'no_assessment_on_record',
          message:
            'No Rent Officer assessment of this unit is on record. If the Rent Officer assessed it in the last 24 months, record that first: a notice to quit inside that time is barred (Act 220 s.23).',
          ruleKey: ASSESSMENT_BAR_KEY,
        });
    }
    const ruleVersions = [
      ...(earliestCalc?.rulesUsed ?? []),
      ...(checks?.quitBar?.ruleUsed ? [checks.quitBar.ruleUsed] : []),
    ];
    const blockers: NoticeIssueBlocker[] = [
      ...fieldErrors.map((f) => ({ code: f.code, message: f.message })),
      ...(checks?.blockers ?? []),
      ...(target.lease && fieldErrors.length === 0
        ? await this.recordChecks(tx, company, type, input.fields, target.lease, input.issueDate)
        : []),
    ];
    if (rules.needsQuitAcknowledgement && !checks && !(await this.quitEnabledIn(tx)))
      blockers.push({
        code: 'notice.quit_not_enabled',
        message:
          'Notices to quit are switched off until a company admin records that they accept the risk (OQ-16)',
      });
    return {
      prefill: {},
      recipients,
      plannedIssueDate: input.issueDate,
      earliest: earliestCalc
        ? {
            earliestDate: earliestCalc.earliestDate,
            serviceDate: earliestCalc.serviceDate,
            serviceDateBasis: earliestCalc.serviceDateBasis,
            periodDays: earliestCalc.periodDays,
            periodSource: earliestCalc.periodSource,
            contractualDays: earliestCalc.contractualDays,
            statutoryDays: earliestCalc.statutoryDays,
            leaseEndApplied: earliestCalc.leaseEndApplied,
          }
        : null,
      effectiveCheck: checks?.effective
        ? {
            ok: checks.effective.ok,
            shortByDays: checks.effective.shortByDays,
            reason: checks.effective.reason,
          }
        : null,
      warnings,
      blockers,
      quitBar: checks?.quitBar
        ? {
            barred: checks.quitBar.barred,
            barredUntil: checks.quitBar.barredUntil,
            latestAssessment: checks.quitBar.latestAssessment,
          }
        : null,
      fieldErrors,
      ruleVersions: ruleVersions as NoticeRuleUsed[],
      statutoryRuleId: statutoryRule?.id ?? null,
      barRuleId: checks?.quitBar?.ruleUsed ? (barRule?.id ?? null) : null,
      electronicService: electronic,
      earliestDate: earliestCalc?.earliestDate ?? null,
    };
  }

  /** Plan 4.3: physical service recorded too late for the stated date flags the notice. */
  private async checkLateService(
    tx: Tx,
    notice: NoticeRow,
    servedAt: Date,
    now: Date,
  ): Promise<void> {
    if (notice.electronicService !== false || notice.servedTooLate || !notice.issueDate) return;
    const type = notice.type as NoticeType;
    const target = await this.targetOf(tx, notice);
    const company = await companyFacts(tx, notice.companyId);
    const servedOn = toIsoDate(businessDateOf(instantFrom(servedAt), company.timeZone));
    const statutory = (
      notice.ruleVersions as {
        key: string;
        ruleId: string;
        value: unknown;
        verificationStatus: string;
      }[]
    ).find((r) => r.key.startsWith('notice_to_quit.statutory_min_days.'));
    // Review data S12: the period as it stood at issue (frozen on the notice), never the lease's
    // values now, which may have changed since.
    const atIssue = notice.earliest as EarliestView | null;
    const fields = notice.fields as Record<string, unknown>;
    const late = servedTooLate({
      type,
      lease: target.lease
        ? {
            use: target.lease.use as LeaseUse,
            noticeDays: atIssue?.contractualDays ?? target.lease.noticeDays,
            endDate:
              typeof fields.leaseEndDate === 'string' ? fields.leaseEndDate : target.lease.endDate,
            electronicServiceClause: hasServiceClause(target.lease),
          }
        : null,
      electronicChannelsWithheld: true,
      issueDate: notice.issueDate,
      physicalServiceDate: servedOn < notice.issueDate ? notice.issueDate : servedOn,
      statutoryRule: statutory
        ? {
            id: statutory.ruleId,
            key: statutory.key,
            value: statutory.value,
            verificationStatus: statutory.verificationStatus as
              'verified' | 'from_prd' | 'unverified',
          }
        : null,
      wordingReviewed: notice.counselReviewed,
      effectiveDate: noticeKeyDate(type, notice.fields as Record<string, unknown>),
    });
    if (!late.tooLate) return;
    const detail = {
      earliestFromService: late.earliestFromService,
      shortByDays: late.shortByDays,
      reason: late.reason,
    };
    await tx
      .update(schema.notice)
      .set({ servedTooLate: detail, updatedAt: now })
      .where(eq(schema.notice.id, notice.id));
    await recordEvent(tx, notice, {
      kind: 'served_too_late',
      at: now,
      data: detail,
      dedupeKey: `served_too_late:${notice.id}`,
    });
  }

  // Views -----------------------------------------------------------------------------------------

  private async listRows(tx: Tx, rows: readonly NoticeRow[]): Promise<NoticeListRowView[]> {
    if (rows.length === 0) return [];
    const company = await companyFacts(tx, rows[0]!.companyId);
    const now = this.clock.now();
    const ids = rows.map((r) => r.id);
    const propertyIds = [...new Set(rows.map((r) => r.propertyId))];
    const properties = await tx
      .select({ id: schema.property.id, name: schema.property.name })
      .from(schema.property)
      .where(inArray(schema.property.id, propertyIds));
    const unitIds = [...new Set(rows.flatMap((r) => (r.unitId ? [r.unitId] : [])))];
    const units = unitIds.length
      ? await tx
          .select({ id: schema.unit.id, code: schema.unit.code })
          .from(schema.unit)
          .where(inArray(schema.unit.id, unitIds))
      : [];
    const tenantIds = [...new Set(rows.flatMap((r) => (r.tenantId ? [r.tenantId] : [])))];
    const tenants = tenantIds.length
      ? await tx
          .select({ id: schema.tenant.id, name: schema.tenant.displayName })
          .from(schema.tenant)
          .where(inArray(schema.tenant.id, tenantIds))
      : [];
    const recipients = await tx
      .select()
      .from(schema.noticeRecipient)
      .where(inArray(schema.noticeRecipient.noticeId, ids));
    const signed = await tx
      .select({
        noticeId: schema.noticeEvent.noticeId,
        recipientId: schema.noticeEvent.recipientId,
      })
      .from(schema.noticeEvent)
      .where(and(inArray(schema.noticeEvent.noticeId, ids), eq(schema.noticeEvent.kind, 'signed')));
    const numbers = new Map<string, string | null>();
    const related = [
      ...new Set(rows.flatMap((r) => (r.correctsNoticeId ? [r.correctsNoticeId] : []))),
    ];
    if (related.length)
      for (const r of await tx
        .select({ id: schema.notice.id, number: schema.notice.number })
        .from(schema.notice)
        .where(inArray(schema.notice.id, related)))
        numbers.set(r.id, numberOf(r));
    const correctedBy = await tx
      .select({ corrects: schema.notice.correctsNoticeId, number: schema.notice.number })
      .from(schema.notice)
      .where(
        and(inArray(schema.notice.correctsNoticeId, ids), sql`${schema.notice.number} is not null`),
      );
    return rows.map((r) => {
      const unitCode = r.unitId ? (units.find((u) => u.id === r.unitId)?.code ?? null) : null;
      const tenant = r.tenantId ? tenants.find((t) => t.id === r.tenantId) : null;
      const next = correctedBy.find((c) => c.corrects === r.id);
      return {
        id: r.id,
        number: numberOf(r),
        type: r.type as NoticeType,
        typeLabel: NOTICE_TYPE_LABELS[r.type as NoticeType],
        subtype: (r.subtype as NoticeSubtype | null) ?? null,
        subtypeLabel: r.subtype ? NOTICE_SUBTYPE_LABELS[r.subtype as NoticeSubtype] : null,
        status: r.status as NoticeStatus,
        statusLabel: NOTICE_STATUS_LABELS[r.status as NoticeStatus],
        outcome: (r.outcome as NoticeOutcome | null) ?? null,
        tenant: tenant ? { id: tenant.id, name: tenant.name } : null,
        property: {
          id: r.propertyId,
          name: properties.find((p) => p.id === r.propertyId)?.name ?? '',
        },
        unitCode,
        leaseId: r.leaseId,
        issuedAt: r.issuedAt,
        effectiveDate:
          r.effectiveDate ??
          noticeKeyDate(r.type as NoticeType, r.fields as Record<string, unknown>),
        daysOutstanding: r.issuedAt
          ? noticeDaysOutstanding(r.issuedAt, now, company.timeZone)
          : null,
        recipientCount: recipients.filter((x) => x.noticeId === r.id).length,
        signedRecipients: new Set(
          signed.filter((s) => s.noticeId === r.id).map((s) => s.recipientId),
        ).size,
        ladderPaused: r.ladderPaused,
        ladderCancelled: r.ladderCancelled,
        servedTooLate: r.servedTooLate !== null,
        correctsNumber: r.correctsNoticeId ? (numbers.get(r.correctsNoticeId) ?? null) : null,
        correctedByNumber: next?.number ? formatNoticeNumber(next.number) : null,
        createdAt: r.createdAt,
      };
    });
  }

  private async detailIn(tx: Tx, staff: StaffActor, notice: NoticeRow) {
    const [row] = await this.listRows(tx, [notice]);
    const company = await companyFacts(tx, notice.companyId);
    const type = notice.type as NoticeType;
    const recipients = await recipientsOf(tx, notice.id);
    const events = await eventsOf(tx, notice.id);
    const progress = progressOf(notice, recipients, events);
    const requests = await this.esign.noticeRequests(tx, notice.id);
    const signers = new Map(requests.flatMap((r) => r.signers.map((s) => [s.id, s] as const)));
    const people = [
      ...new Set(
        [
          ...events.map((e) => e.actorPersonId),
          notice.createdBy,
          notice.closedBy,
          notice.ladderChangedBy,
        ].filter((v): v is string => !!v),
      ),
    ];
    const names = people.length
      ? await tx
          .select({ id: schema.person.id, name: schema.person.name })
          .from(schema.person)
          .where(inArray(schema.person.id, people))
      : [];
    const nameOf = (id: string | null) =>
      id ? (names.find((n) => n.id === id)?.name ?? null) : null;
    const records = await tx
      .select()
      .from(schema.serviceRecord)
      .where(eq(schema.serviceRecord.noticeId, notice.id))
      .orderBy(asc(schema.serviceRecord.recordedAt));
    const recordedBy = records.length
      ? await tx
          .select({ id: schema.person.id, name: schema.person.name })
          .from(schema.person)
          .where(
            inArray(
              schema.person.id,
              records.map((r) => r.recordedBy),
            ),
          )
      : [];
    const tasks: TaskView[] = await this.tasks.forNotice(tx, staff, notice.id);
    const issued = LIVE.includes(notice.status) || notice.status === 'closed';
    const evaluation =
      notice.status === 'draft' ||
      notice.status === 'approved' ||
      notice.status === 'pending_approval'
        ? await this.evaluate(tx, company, {
            type,
            subtype: notice.subtype,
            fields: notice.fields as Record<string, unknown>,
            target: await this.targetOf(tx, notice),
            issueDate: this.today(company),
          })
        : null;
    const flags = { paused: notice.ladderPaused, cancelled: notice.ladderCancelled };
    const steps = (
      ((notice.ladder as NoticeLadderStep[] | null) ??
      (LADDER_NOTICE_TYPES as readonly string[]).includes(type))
        ? ((notice.ladder as NoticeLadderStep[] | null) ??
          noticeLadderFor(type, noticeSettingsOf(company.settings)))
        : []
    ) as NoticeLadderStep[];
    const settings = noticeSettingsOf(company.settings);
    const planned = notice.issuedAt
      ? plannedNoticeLadder({
          issuedAt: notice.issuedAt,
          steps,
          timeZone: company.timeZone,
          window: settings.sendWindow,
          shiftSeconds: notice.ladderShiftSeconds,
        })
      : steps.map((step) => ({ step, dueAt: null, runsAt: null }));
    const can = (action: Parameters<PolicyService['can']>[1]) =>
      this.policy.can(staff, action).allowed;
    const status = notice.status as NoticeStatus;
    const completedRequests = requests.filter((r) => r.request.finalSha256);
    const firstOf = (kind: string, recipientId: string) =>
      events.find((e) => e.kind === kind && e.recipientId === recipientId) ?? null;
    return {
      ...row!,
      fields: notice.fields as Record<string, unknown>,
      blockIds: notice.blockIds,
      issueDate: notice.issueDate,
      earliestLawfulDate: notice.earliestLawfulDate ?? evaluation?.earliestDate ?? null,
      earliest: (notice.earliest as EarliestView | null) ?? evaluation?.earliest ?? null,
      electronicService: notice.electronicService ?? evaluation?.electronicService ?? null,
      ruleVersions: (issued
        ? notice.ruleVersions
        : (evaluation?.ruleVersions ?? [])) as NoticeRuleUsed[],
      warnings: (issued ? notice.warnings : (evaluation?.warnings ?? [])) as NoticeWarning[],
      blockers: evaluation?.blockers ?? [],
      quitBar: evaluation?.quitBar ?? null,
      servedTooLateDetail: notice.servedTooLate as {
        earliestFromService: string;
        shortByDays: number;
        reason: string;
      } | null,
      template: {
        key: notice.templateKey,
        version: notice.templateVersion,
        counselReviewed: notice.counselReviewed,
      },
      document: {
        sha256: notice.documentSha256,
        signedSha256:
          completedRequests.length === 1 ? completedRequests[0]!.request.finalSha256 : null,
        servicePackReady: notice.servicePackDocumentId !== null,
      },
      ladder: {
        paused: notice.ladderPaused,
        cancelled: notice.ladderCancelled,
        reason: notice.ladderReason,
        changedAt: notice.ladderChangedAt,
        changedByName: nameOf(notice.ladderChangedBy),
        steps: planned.map((p) => ({ ...p.step, dueAt: p.dueAt, runsAt: p.runsAt })),
      },
      linkExpiresAt: notice.linkExpiresAt,
      completion: notice.completion as 'any_one' | 'each',
      approvalRequestId: notice.approvalRequestId,
      lastApproval: await this.lastApprovalOf(tx, notice),
      returnedReason: returnedReasonOf(notice, events),
      corrects: notice.correctsNoticeId
        ? { id: notice.correctsNoticeId, number: row!.correctsNumber }
        : null,
      correctedBy: await this.correctedBy(tx, notice.id),
      closeNote: notice.closeNote,
      closedAt: notice.closedAt,
      closedByName: nameOf(notice.closedBy),
      createdByName: nameOf(notice.createdBy),
      recipients: recipients.map((r) => {
        const p = progress.recipients.find((x) => x.recipientId === r.id);
        const signer = r.signerId ? signers.get(r.signerId) : undefined;
        const delivered = firstOf('delivered', r.id);
        return {
          id: r.id,
          kind: r.kind as NoticeRecipientKind,
          name: r.name,
          partyTenantId: r.tenantId,
          leaseId: r.leaseId,
          unitCode: null as string | null,
          phoneMasked: r.phone ? maskPhone(r.phone) : null,
          emailMasked: r.email ? maskEmail(r.email) : null,
          status: p?.status ?? null,
          acknowledged: p?.acknowledged ?? false,
          channels: r.channels as {
            channel: 'whatsapp' | 'sms' | 'email';
            mode: 'service' | 'courtesy' | 'withheld';
            reason: 'no_address' | 'no_consent' | 'opted_out' | null;
          }[],
          physicalServicePlanned: r.physicalServicePlanned,
          firstOpenedAt: firstOf('opened', r.id)?.occurredAt ?? signer?.firstOpenedAt ?? null,
          signedAt: firstOf('signed', r.id)?.occurredAt ?? signer?.signedAt ?? null,
          deliveredVia: (delivered?.channel as 'whatsapp' | 'sms' | 'email' | null) ?? null,
          deliveredAt: delivered?.occurredAt ?? null,
        };
      }),
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind as NoticeRecordKind,
        recipientId: e.recipientId,
        channel: e.channel as 'whatsapp' | 'sms' | 'email' | null,
        at: e.occurredAt,
        actorName: nameOf(e.actorPersonId),
        data: e.data as Record<string, unknown> | null,
      })),
      serviceRecords: records.map((s) => ({
        id: s.id,
        method: s.method as ServiceMethod,
        methodLabel: SERVICE_METHOD_LABELS[s.method as ServiceMethod],
        servedAt: s.servedAt,
        servedByName: s.servedByName,
        witnessName: s.witnessName,
        recipientId: s.recipientId,
        notes: s.notes,
        hasPhoto: s.photoDocumentId !== null,
        hasAffidavit: s.affidavitDocumentId !== null,
        correctsRecordId: s.correctsRecordId,
        correctedByRecordId: records.find((x) => x.correctsRecordId === s.id)?.id ?? null,
        recordedByName: recordedBy.find((p) => p.id === s.recordedBy)?.name ?? null,
        recordedAt: s.recordedAt,
      })),
      tasks,
      actions: {
        edit: status === 'draft' && can('notices.draft'),
        discard: status === 'draft' && can('notices.draft'),
        submit: status === 'draft' && can('notices.draft'),
        returnToDraft: status === 'pending_approval' && can('notices.draft'),
        issue:
          (status === 'draft' || status === 'approved') &&
          !NOTICE_TYPE_RULES[type].twoPersonApproval &&
          NOTICE_TYPE_RULES[type].issuable &&
          can('notices.issue'),
        controlLadder: LIVE.includes(status) && !flags.cancelled && can('notices.ladder.control'),
        recordService:
          (LIVE.includes(status) || status === 'closed') && can('notices.service.record'),
        close: (LIVE.includes(status) || status === 'received') && can('notices.close'),
        correct: LIVE.includes(status) && NOTICE_TYPE_RULES[type].issuable && can('notices.draft'),
        // Review D-D, founder decision: notice authority only, while live and frozen.
        handover: LIVE.includes(status) && notice.documentSha256 !== null && can('notices.issue'),
      },
    };
  }

  private async correctedBy(tx: Tx, noticeId: string) {
    // The issued correction (review S10: ordered, should there ever be more than one).
    const [next] = await tx
      .select({ id: schema.notice.id, number: schema.notice.number })
      .from(schema.notice)
      .where(
        and(
          eq(schema.notice.correctsNoticeId, noticeId),
          inArray(schema.notice.status, [...LIVE, 'closed']),
        ),
      )
      .orderBy(asc(schema.notice.issuedAt), asc(schema.notice.id))
      .limit(1);
    return next ? { id: next.id, number: numberOf(next) } : null;
  }

  /** Review C1: the notice's latest approval request, open or closed, with who decided it. */
  private async lastApprovalOf(tx: Tx, notice: NoticeRow) {
    const latest = await this.approvals.latestForSubject(tx, 'notice', notice.id, [
      NOTICE_ISSUE_ACTION,
      NOTICE_ISSUE_QUIT_ACTION,
    ]);
    if (!latest) return null;
    const [person] = latest.decidedBy
      ? await tx
          .select({ name: schema.person.name })
          .from(schema.person)
          .where(eq(schema.person.id, latest.decidedBy))
      : [];
    return {
      id: latest.id,
      actionType: latest.actionType as typeof NOTICE_ISSUE_ACTION | typeof NOTICE_ISSUE_QUIT_ACTION,
      status: latest.status,
      decidedAt: latest.decidedAt,
      decidedByName: person?.name ?? null,
    };
  }
}

/** What an approval re-checks at decision time (AD-05): the content it was asked about. */
function contentHash(notice: NoticeRow): string {
  return sha256(
    JSON.stringify({
      type: notice.type,
      subtype: notice.subtype,
      fields: notice.fields,
      leaseId: notice.leaseId,
      blockIds: notice.blockIds,
    }),
  );
}

/** A draft keeps only the type's fields; full checks happen at submit and issue. */
function checkDraftFields(
  type: NoticeType,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const known = new Set(Object.keys(NOTICE_FIELD_SCHEMAS[type].shape));
  const unknown = Object.keys(fields).filter((k) => !known.has(k));
  if (unknown.length)
    throw new AppError(
      400,
      'notice_field_unknown',
      `A ${NOTICE_TYPE_LABELS[type].toLowerCase()} has no field ${unknown.join(', ')}`,
      {
        field: unknown[0]!,
      },
    );
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function premisesOf(target: Target): string {
  if (target.unitCode) return target.unitCode;
  return target.blockCodes.length ? `Blocks ${target.blockCodes.join(', ')}` : '';
}

function suggestedFields(
  type: NoticeType,
  target: Target,
  arrears: { amountMinor: number; asOf: string; invoices: { id: string }[] } | null,
  issueDate: string,
  currentRentMinor: number | null,
): Record<string, unknown> {
  switch (type) {
    case 'rent_demand':
      return arrears
        ? {
            arrearsMinor: arrears.amountMinor,
            arrearsAsOf: arrears.asOf,
            invoiceIds: arrears.invoices.map((i) => i.id),
            payBy: toIsoDate(addDays(parseBusinessDate(issueDate), 14)),
          }
        : {};
    case 'rent_review':
      return currentRentMinor !== null ? { currentRentMinor } : {};
    case 'non_renewal':
      return target.lease
        ? { leaseEndDate: target.lease.endDate, effectiveDate: target.lease.endDate }
        : {};
    case 'building_wide':
      return { propertyId: target.propertyId };
    default:
      return {};
  }
}

const maskPhone = (phone: string) =>
  phone.length > 4 ? `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}` : '****';
const maskEmail = (email: string) => {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
};

/**
 * Review C1: why a draft is a draft again, from its latest return to draft; null unless the notice
 * is a draft whose last pre-issue step was that return.
 */
function returnedReasonOf(
  notice: NoticeRow,
  events: readonly { kind: string; occurredAt: Date; data: unknown }[],
): { code: string; message: string; at: Date } | null {
  if (notice.status !== 'draft') return null;
  const last = [...events]
    .reverse()
    .find((e) => ['submitted', 'returned_to_draft', 'approved'].includes(e.kind));
  if (last?.kind !== 'returned_to_draft') return null;
  const data = (last.data ?? {}) as { code?: unknown; reason?: unknown; blockers?: unknown };
  const blockers = Array.isArray(data.blockers) ? (data.blockers as { code?: unknown }[]) : [];
  const code =
    typeof data.code === 'string'
      ? data.code
      : typeof blockers[0]?.code === 'string'
        ? blockers[0].code
        : 'notice.returned';
  const message =
    typeof data.reason === 'string' ? data.reason : (notice.returnedReason ?? 'Returned to draft');
  return { code, message, at: last.occurredAt };
}
