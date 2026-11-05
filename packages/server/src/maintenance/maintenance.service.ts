import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import { DomainError } from '@rent/domain/errors';
import {
  autoCloseDue,
  dueSlaWarnings,
  formatTicketNumber,
  maintenanceDueTimes,
  maintenanceSettingsOf,
  MAINTENANCE_JOB_STATUS_LABELS,
  MAINTENANCE_PRIORITY_LABELS,
  nextMaintenanceStatus,
  OPEN_MAINTENANCE_STATUSES,
  parseTicketNumber,
  type MaintenanceAttachmentKind,
  type MaintenanceAttachmentStage,
  type MaintenanceCategory,
  type MaintenanceJobAction,
  type MaintenanceJobStatus,
  type MaintenancePriority,
  type MaintenanceSource,
  type MaintenanceStepFacts,
  type MaintenanceTargetKind,
} from '@rent/domain/maintenance';
import type { Actor, PolicyAction } from '@rent/domain/policy';
import { scopeOf } from '@rent/domain/policy';
import { parseCompanySettings } from '@rent/domain/settings';
import type { TaskKind, TaskStatus } from '@rent/domain/tasks';
import { v5 as uuidv5 } from 'uuid';
import { companyRecord, staffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import { maintenanceCheckConflict } from '../core/db-errors';
import { AppError, conflict, forbidden, invalid, notFound } from '../core/errors';
import { queueMessage, type NewMessage } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import {
  DocumentsService,
  JOB_MEDIA_UPLOAD,
  type StagedMedia,
} from '../documents/documents.service';
import { memberActors, membersWhoCan } from '../policy/members';
import { PolicyService, staffContext } from '../policy/policy.service';
import { TasksService } from '../tasks/tasks.service';
import { expenseRows, type ExpenseRowView } from './expense-records';
import { ARTISAN_KIND, TENANT_KIND } from './kinds';

type StaffActor = Extract<Actor, { kind: 'staff' }>;
/** The kinds of maintenance_job_event (0040's check), as contracts list them. */
export type MaintenanceEventKind =
  | 'reported'
  | 'triaged'
  | 'priority_changed'
  | 'assigned'
  | 'unassigned'
  | 'accepted'
  | 'declined'
  | 'visit_planned'
  | 'started'
  | 'work_done'
  | 'confirmed'
  | 'disputed'
  | 'closed'
  | 'auto_closed'
  | 'cancelled'
  | 'note'
  | 'media_added'
  | 'alerted'
  | 'sla_warned'
  | 'tenant_updated'
  | 'expense_linked';
type JobRow = typeof schema.maintenanceJob.$inferSelect;

/** Outbox jobs (plan 4.13). */
export const MAINTENANCE_EMERGENCY_ALERT_JOB = 'maintenance.emergency-alert';
export const MAINTENANCE_SLA_JOB = 'maintenance.sla-check';
export const MAINTENANCE_AUTO_CLOSE_JOB = 'maintenance.auto-close';

const NAMESPACE = '6b1f9a52-2a3e-4f0c-9d3e-8c1e5f7a4b20';
const HOUR = 3_600_000;

/** The steps a tenant hears about and sees (CM-04); never a staff note, an alert or a warning. */
const TENANT_STEPS = [
  'reported',
  'assigned',
  'visit_planned',
  'started',
  'work_done',
  'confirmed',
  'disputed',
  'closed',
  'cancelled',
] as const;

export interface ReportedJob {
  readonly jobId: string;
  readonly ticketNumber: number;
  readonly ticket: string;
  /** False when this report had been recorded already (a retried job): no second ticket. */
  readonly created: boolean;
}

export interface JobActor {
  readonly kind: 'staff' | 'artisan' | 'tenant' | 'system';
  readonly personId?: string | null;
  readonly artisanId?: string | null;
}

export interface MaintenanceJobView {
  readonly id: string;
  readonly ticket: string;
  readonly ticketNumber: number;
  readonly status: MaintenanceJobStatus;
  readonly statusLabel: string;
  readonly source: MaintenanceSource;
  readonly description: string;
  readonly property: { readonly id: string; readonly name: string };
  readonly unit: { readonly id: string; readonly code: string } | null;
  readonly tenant: { readonly id: string; readonly name: string } | null;
  readonly leaseId: string | null;
  readonly conversationId: string | null;
  readonly attachmentCount: number;
  readonly createdAt: Date;
  readonly priority: MaintenancePriority | null;
  readonly category: MaintenanceCategory | null;
  readonly emergencyFlag: boolean;
  readonly assignee:
    | { readonly kind: 'staff'; readonly personId: string; readonly name: string }
    | {
        readonly kind: 'artisan';
        readonly artisanId: string;
        readonly name: string;
        readonly response: 'accepted' | 'declined' | null;
      }
    | null;
  readonly targets: {
    readonly respondBy: Date;
    readonly completeBy: Date;
    readonly respondedAt: Date | null;
    readonly workDoneAt: Date | null;
    readonly overdue: MaintenanceTargetKind | null;
  } | null;
  readonly visitAt: Date | null;
  readonly costMinor: number;
  readonly closedAt: Date | null;
  readonly updatedAt: Date;
}

export interface MaintenanceJobDetail extends MaintenanceJobView {
  readonly attachments: readonly {
    readonly id: string;
    readonly kind: MaintenanceAttachmentKind;
    readonly stage: MaintenanceAttachmentStage;
    readonly contentType: string;
    readonly sizeBytes: number | null;
    readonly durationSeconds: number | null;
    readonly createdAt: Date;
    readonly addedByKind: 'staff' | 'artisan' | 'tenant' | 'message';
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly kind: MaintenanceEventKind;
    readonly at: Date;
    readonly actorKind: 'staff' | 'artisan' | 'tenant' | 'system';
    readonly actorName: string | null;
    readonly data: Record<string, unknown> | null;
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly kind: TaskKind;
    readonly status: TaskStatus;
    readonly assignee: { readonly personId: string; readonly name: string } | null;
    readonly dueAt: Date;
  }[];
  readonly beforePhotoReason: string | null;
  readonly completionNote: string | null;
  readonly tenantResponse: {
    readonly kind: 'confirmed' | 'disputed';
    readonly reason: string | null;
    readonly at: Date;
    readonly via: 'app' | 'whatsapp' | 'sms' | 'staff';
  } | null;
  readonly expenses: readonly ExpenseRowView[];
  readonly actions: Record<
    | 'triage'
    | 'changePriority'
    | 'assign'
    | 'unassign'
    | 'planVisit'
    | 'start'
    | 'complete'
    | 'recordResponse'
    | 'close'
    | 'cancel'
    | 'addMedia'
    | 'addNote'
    | 'recordExpense',
    boolean
  >;
}

export interface TenantRepairView {
  readonly jobId: string;
  readonly ticket: string;
  readonly status: MaintenanceJobStatus;
  readonly statusLabel: string;
  readonly description: string;
  readonly category: MaintenanceCategory | null;
  readonly emergency: boolean;
  readonly leaseId: string | null;
  readonly unitCode: string | null;
  readonly visitAt: Date | null;
  readonly awaitingResponse: boolean;
  readonly completionNote: string | null;
  readonly steps: readonly { readonly kind: (typeof TENANT_STEPS)[number]; readonly at: Date }[];
  readonly attachments: readonly {
    readonly id: string;
    readonly kind: MaintenanceAttachmentKind;
    readonly stage: MaintenanceAttachmentStage;
    readonly contentType: string;
  }[];
  readonly createdAt: Date;
  readonly forwarded: boolean;
}

export interface ReportInput {
  readonly propertyId: string;
  readonly unitId: string | null;
  readonly leaseId: string | null;
  readonly tenantId: string | null;
  readonly source: MaintenanceSource;
  readonly description: string;
  readonly conversationId: string | null;
  readonly messageIds: readonly string[];
  readonly reportedBy: string | null;
  // M8 ----------------------------------------------------------------------------------------
  readonly priority?: MaintenancePriority | null;
  readonly category?: MaintenanceCategory | null;
  /** The tenant said it is an emergency (decision 5): emergency at once. */
  readonly emergencyFlag?: boolean;
  /** The tenant app's id for the request: a retry or an offline send makes one job. */
  readonly clientId?: string | null;
  /** Files staged before the transaction (decision 2). */
  readonly media?: readonly StagedMedia[];
  readonly actor?: JobActor;
}

const conflictOf = (error: unknown): never => {
  if (error instanceof DomainError) {
    const code = error.code.replace(/\./g, '_');
    // An illegal move is a named 409; missing evidence or a missing reason, a 400.
    if (error.code === 'maintenance.transition') throw conflict(code, error.message);
    throw invalid(code, error.message);
  }
  throw maintenanceCheckConflict(error) ?? error;
};

/** A short human place for alerts and job sheets: the unit code, or the property's name. */
const placeOf = (job: { unitCode: string | null; propertyName: string }) =>
  job.unitCode ?? job.propertyName;

/**
 * Maintenance jobs (MI-01 to MI-06, CM-04; M8 plan 4.2 to 4.4). Every source lands on one board:
 * the bot (M6), the tenant app, staff and caretakers, and SMS or email logged from the inbox. Each
 * step is checked by the domain's machine, written with its event in one transaction, and checked
 * again by the database (0041). The board, assignment, alerts and SLAs are Growth (decision 1).
 */
@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.tasks.useRelated('maintenance_job', async (tx, ids) => {
      const rows = await tx
        .select({ id: schema.maintenanceJob.id, n: schema.maintenanceJob.ticketNumber })
        .from(schema.maintenanceJob)
        .where(inArray(schema.maintenanceJob.id, [...ids]));
      return new Map(
        rows.map((r) => [r.id, { number: formatTicketNumber(r.n), typeLabel: 'Repair' }]),
      );
    });
  }

  // Reporting (CM-04, MI-01) ---------------------------------------------------------------------

  /**
   * Records a reported repair in the caller's transaction. Idempotent by its first message (the
   * bot) or the app's client id: a retried job answers the ticket it already made. M8: its
   * reported event, any priority and category given, the files staged for it, and the emergency
   * alert when it is one (decision 5).
   */
  async report(tx: Tx, companyId: string, input: ReportInput): Promise<ReportedJob> {
    const first = input.messageIds[0] ?? null;
    const now = this.clock.now();
    const priority: MaintenancePriority | null = input.emergencyFlag
      ? 'emergency'
      : (input.priority ?? null);
    const inserted = await tx
      .insert(schema.maintenanceJob)
      .values({
        companyId,
        propertyId: input.propertyId,
        unitId: input.unitId,
        leaseId: input.leaseId,
        tenantId: input.tenantId,
        source: input.source,
        description:
          input.description.trim().slice(0, 4000) || 'Reported with a photo, video or voice note',
        conversationId: input.conversationId,
        sourceMessageId: first,
        sourceMessageIds: [...input.messageIds],
        reportedBy: input.reportedBy,
        emergencyFlag: input.emergencyFlag ?? false,
        priority,
        category: input.category ?? null,
        clientId: input.clientId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted[0] ??
      (
        await tx
          .select()
          .from(schema.maintenanceJob)
          .where(
            input.clientId && input.tenantId
              ? and(
                  eq(schema.maintenanceJob.tenantId, input.tenantId),
                  eq(schema.maintenanceJob.clientId, input.clientId),
                )
              : eq(
                  schema.maintenanceJob.sourceMessageId,
                  first ?? '00000000-0000-0000-0000-000000000000',
                ),
          )
      )[0];
    if (!row) throw new Error('repair report not recorded');
    const created = inserted.length > 0;
    if (created) {
      const actor = input.actor ?? {
        kind: input.source === 'staff' ? ('staff' as const) : ('tenant' as const),
        personId: input.reportedBy,
      };
      await this.event(tx, row, 'reported', actor, { source: input.source });
      if (input.messageIds.length > 0) {
        const stored = await tx
          .select()
          .from(schema.messageAttachment)
          .where(
            and(
              inArray(schema.messageAttachment.messageId, [...input.messageIds]),
              eq(schema.messageAttachment.status, 'stored'),
            ),
          );
        for (const a of stored) await this.attach(tx, companyId, row.id, input.propertyId, a);
      }
      if (input.media?.length) {
        await this.recordMedia(tx, row, input.media, 'report', actor);
      }
      if (priority && input.category) {
        await this.applyTriage(tx, row, priority, input.category, now);
        await this.event(tx, row, 'triaged', actor, { priority, category: input.category });
      }
      if (priority === 'emergency') await this.queueAlert(tx, row);
    }
    return {
      jobId: row.id,
      ticketNumber: row.ticketNumber,
      ticket: formatTicketNumber(row.ticketNumber),
      created,
    };
  }

  /** Media copied after the report was made joins the jobs made from its message. */
  async attachLate(
    tx: Tx,
    companyId: string,
    attachment: typeof schema.messageAttachment.$inferSelect,
  ): Promise<number> {
    if (attachment.status !== 'stored') return 0;
    const jobs = await tx
      .select({
        id: schema.maintenanceJob.id,
        propertyId: schema.maintenanceJob.propertyId,
        status: schema.maintenanceJob.status,
      })
      .from(schema.maintenanceJob)
      .where(
        sql`${schema.maintenanceJob.sourceMessageIds} @> array[${attachment.messageId}]::uuid[]`,
      );
    let joined = 0;
    for (const job of jobs) {
      // A closed job's files are fixed (0041); media that arrives too late stays on the message.
      if (job.status === 'closed' || job.status === 'cancelled') continue;
      await this.attach(tx, companyId, job.id, job.propertyId, attachment);
      joined += 1;
    }
    return joined;
  }

  private async attach(
    tx: Tx,
    companyId: string,
    jobId: string,
    propertyId: string,
    a: typeof schema.messageAttachment.$inferSelect,
  ): Promise<void> {
    if (!a.documentId) return;
    const kind =
      a.kind === 'sticker' ? 'image' : (a.kind as 'image' | 'video' | 'audio' | 'document');
    await tx
      .insert(schema.maintenanceJobAttachment)
      .values({
        companyId,
        propertyId,
        jobId,
        documentId: a.documentId,
        kind,
        messageAttachmentId: a.id,
        sizeBytes: a.sizeBytes ?? null,
      })
      .onConflictDoNothing();
  }

  /** Staff and caretakers log a repair for a unit or a common area (CM-04), with its files. */
  async logRepair(
    actor: Actor | null,
    input: {
      readonly propertyId: string;
      readonly unitId?: string | null;
      readonly description: string;
      readonly category?: MaintenanceCategory | null;
      readonly priority?: MaintenancePriority | null;
      readonly uploadIds: readonly string[];
      readonly conversationId?: string | null;
      readonly messageIds: readonly string[];
    },
  ): Promise<MaintenanceJobDetail> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'maintenance.report');
    await this.entitlements.assert(staff.companyId, 'maintenance');
    const media = await this.stage(staff, input.uploadIds);
    const jobId = await this.write(
      staff,
      async (tx) => {
        const facts = await this.unitFacts(tx, input.propertyId, input.unitId ?? null);
        let conversationTenant: string | null = null;
        if (input.conversationId) {
          const [conversation] = await tx
            .select({ tenantId: schema.conversation.tenantId })
            .from(schema.conversation)
            .where(eq(schema.conversation.id, input.conversationId));
          if (!conversation) throw notFound('Conversation');
          conversationTenant = conversation.tenantId;
        }
        const tenantId = facts.tenantId ?? conversationTenant;
        const source = input.conversationId
          ? await this.conversationSource(tx, input.conversationId, input.messageIds)
          : 'staff';
        const job = await this.report(tx, staff.companyId, {
          propertyId: input.propertyId,
          unitId: input.unitId ?? null,
          leaseId: tenantId && facts.tenantId === tenantId ? facts.leaseId : null,
          tenantId,
          source,
          description: input.description,
          conversationId: input.conversationId ?? null,
          // An inbox repair links its messages; it is never reported twice from them.
          messageIds: input.conversationId ? input.messageIds : [],
          reportedBy: staff.personId,
          priority: input.priority ?? null,
          category: input.category ?? null,
          media,
          actor: { kind: 'staff', personId: staff.personId },
        });
        if (!job.created)
          throw conflict('maintenance_already_reported', 'This repair was already logged');
        return job.jobId;
      },
      media,
    );
    return this.get(actor, jobId);
  }

  private async conversationSource(
    tx: Tx,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<MaintenanceSource> {
    const [m] = messageIds.length
      ? await tx
          .select({ channel: schema.message.channel })
          .from(schema.message)
          .where(
            and(
              inArray(schema.message.id, [...messageIds]),
              eq(schema.message.conversationId, conversationId),
            ),
          )
      : [];
    const channel = m?.channel;
    return channel === 'sms' || channel === 'email' || channel === 'whatsapp' ? channel : 'staff';
  }

  /** The unit's current tenancy, if it is let: who the repair is for. */
  private async unitFacts(tx: Tx, propertyId: string, unitId: string | null) {
    const [property] = await tx
      .select({ id: schema.property.id })
      .from(schema.property)
      .where(eq(schema.property.id, propertyId));
    if (!property) throw notFound('Property');
    if (!unitId) return { tenantId: null, leaseId: null };
    const [unit] = await tx
      .select({ id: schema.unit.id })
      .from(schema.unit)
      .where(and(eq(schema.unit.id, unitId), eq(schema.unit.propertyId, propertyId)));
    if (!unit) throw notFound('Unit');
    const [lease] = await tx
      .select({ id: schema.lease.id, tenantId: schema.lease.tenantId })
      .from(schema.lease)
      .where(
        and(
          eq(schema.lease.unitId, unitId),
          inArray(schema.lease.status, ['active', 'ending', 'holding_over']),
        ),
      )
      .orderBy(desc(schema.lease.startDate))
      .limit(1);
    return { tenantId: lease?.tenantId ?? null, leaseId: lease?.id ?? null };
  }

  // The board (MI-01 to MI-06; decision 9) -------------------------------------------------------

  async list(
    actor: Actor | null,
    filter: {
      propertyId?: string;
      tenantId?: string;
      status?: MaintenanceJobStatus;
      open?: boolean;
      priority?: MaintenancePriority;
      category?: MaintenanceCategory;
      overdue?: boolean;
      assigneePersonId?: string;
      artisanId?: string;
      search?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ items: MaintenanceJobView[]; nextCursor: string | null }> {
    const staff = this.reader(actor);
    await this.entitlements.assert(staff.companyId, 'maintenance');
    const j = schema.maintenanceJob;
    const now = this.clock.now();
    const ticket = filter.search ? parseTicketNumber(filter.search) : null;
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select()
        .from(j)
        .where(
          and(
            filter.propertyId ? eq(j.propertyId, filter.propertyId) : undefined,
            filter.tenantId ? eq(j.tenantId, filter.tenantId) : undefined,
            filter.status ? eq(j.status, filter.status) : undefined,
            filter.open ? inArray(j.status, [...OPEN_MAINTENANCE_STATUSES]) : undefined,
            filter.priority ? eq(j.priority, filter.priority) : undefined,
            filter.category ? eq(j.category, filter.category) : undefined,
            filter.assigneePersonId ? eq(j.assigneePersonId, filter.assigneePersonId) : undefined,
            filter.artisanId ? eq(j.assigneeArtisanId, filter.artisanId) : undefined,
            filter.overdue
              ? sql`${j.status} not in ('closed', 'cancelled') and ((${j.respondedAt} is null and ${j.respondBy} < ${now}) or (${j.workDoneAt} is null and ${j.completeBy} < ${now}))`
              : undefined,
            filter.search
              ? ticket !== null
                ? eq(j.ticketNumber, ticket)
                : sql`${j.description} ilike ${`%${filter.search.replace(/[%_\\]/g, '\\$&')}%`}`
              : undefined,
            filter.cursor ? lt(j.ticketNumber, Number(filter.cursor)) : undefined,
          ),
        )
        .orderBy(desc(j.ticketNumber))
        .limit(filter.limit + 1);
      const page = rows.slice(0, filter.limit);
      return {
        items: await this.views(tx, page),
        nextCursor: rows.length > filter.limit ? String(page.at(-1)!.ticketNumber) : null,
      };
    });
  }

  async get(actor: Actor | null, jobId: string): Promise<MaintenanceJobDetail> {
    const staff = this.reader(actor);
    const growth = await this.entitlements.has(staff.companyId, 'maintenance');
    if (!growth) await this.entitlements.assert(staff.companyId, 'maintenance');
    return withCompany(this.database, staffContext(staff), (tx) => this.detail(tx, staff, jobId));
  }

  async attachmentDownload(actor: Actor | null, jobId: string, attachmentId: string) {
    const staff = this.reader(actor);
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select({ documentId: schema.maintenanceJobAttachment.documentId })
        .from(schema.maintenanceJobAttachment)
        .where(
          and(
            eq(schema.maintenanceJobAttachment.id, attachmentId),
            eq(schema.maintenanceJobAttachment.jobId, jobId),
          ),
        );
      return row?.documentId ?? null;
    });
    const url = documentId ? await this.documents.downloadUrl(staff.companyId, documentId) : null;
    if (!url) throw notFound('Attachment');
    return { url, expiresAt: new Date(this.clock.now().getTime() + 300_000) };
  }

  /** An upload for a repair (decision 2): staff and caretakers. */
  async createUpload(
    actor: Actor | null,
    declared: { contentType: string; sizeBytes: number; durationSeconds?: number | null },
  ) {
    const staff = staffActor(actor);
    if (
      !this.policy.can(staff, 'maintenance.report').allowed &&
      !this.policy.can(staff, 'maintenance.attend').allowed
    )
      throw forbidden();
    return this.documents.createMediaUpload(
      { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' },
      staff.personId,
      JOB_MEDIA_UPLOAD,
      declared,
    );
  }

  // Steps (plan 4.2; MI-04, MI-06) -------------------------------------------------------------

  async triage(
    actor: Actor | null,
    jobId: string,
    input: { priority: MaintenancePriority; category: MaintenanceCategory; note?: string | null },
  ) {
    return this.step(actor, jobId, 'maintenance.manage', async (tx, job, staff, now) => {
      this.move(job, 'triage', { priority: input.priority, category: input.category });
      const wasEmergency = job.priority === 'emergency';
      await this.applyTriage(tx, job, input.priority, input.category, now);
      await this.event(tx, job, 'triaged', staffOf(staff), {
        priority: input.priority,
        category: input.category,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      });
      if (input.priority === 'emergency' && !wasEmergency) await this.queueAlert(tx, job);
    });
  }

  async changePriority(
    actor: Actor | null,
    jobId: string,
    input: { priority: MaintenancePriority; reason: string },
  ) {
    return this.step(actor, jobId, 'maintenance.manage', async (tx, job, staff, now) => {
      if (!OPEN_MAINTENANCE_STATUSES.includes(job.status as MaintenanceJobStatus))
        throw conflict('maintenance_transition', 'Only an open job’s priority can change');
      const from = job.priority as MaintenancePriority | null;
      if (from === input.priority) return;
      const triaged = job.category !== null && job.status !== 'reported';
      await tx
        .update(schema.maintenanceJob)
        .set({
          priority: input.priority,
          ...(triaged
            ? this.targetsFor(
                job,
                input.priority,
                staffSettings(await companyRecord(tx, job.companyId)),
              )
            : {}),
          updatedAt: now,
        })
        .where(eq(schema.maintenanceJob.id, job.id));
      await this.event(tx, job, 'priority_changed', staffOf(staff), {
        priority: input.priority,
        from,
        to: input.priority,
        reason: input.reason.trim(),
      });
      if (input.priority === 'emergency') await this.queueAlert(tx, job);
    });
  }

  async assign(
    actor: Actor | null,
    jobId: string,
    input: {
      assignee: { kind: 'staff'; personId: string } | { kind: 'artisan'; artisanId: string };
      dueAt?: string | null;
      note?: string | null;
    },
  ) {
    return this.step(actor, jobId, 'maintenance.manage', async (tx, job, staff, now) => {
      this.move(job, 'assign');
      const dueAt = input.dueAt ? new Date(input.dueAt) : null;
      let name: string;
      if (input.assignee.kind === 'staff') {
        const personId = input.assignee.personId;
        const covering = await this.assignableStaff(tx, job);
        if (!covering.has(personId))
          throw invalid(
            'assignee_not_eligible',
            'Choose a caretaker or manager who works on this property',
          );
        name = covering.get(personId)!;
      } else {
        const [artisan] = await tx
          .select()
          .from(schema.artisan)
          .where(eq(schema.artisan.id, input.assignee.artisanId));
        if (!artisan || artisan.archivedAt) throw notFound('Artisan');
        name = artisan.name;
      }
      await this.endAssignment(tx, job, now, 'reassigned');
      await tx
        .update(schema.maintenanceJob)
        .set({
          status: 'assigned',
          assigneeKind: input.assignee.kind,
          assigneePersonId: input.assignee.kind === 'staff' ? input.assignee.personId : null,
          assigneeArtisanId: input.assignee.kind === ARTISAN_KIND ? input.assignee.artisanId : null,
          artisanResponse: null,
          respondedAt: job.respondedAt ?? now,
          updatedAt: now,
        })
        .where(eq(schema.maintenanceJob.id, job.id));
      await this.event(tx, job, 'assigned', staffOf(staff), {
        assigneeKind: input.assignee.kind,
        assigneeName: name,
        ...(dueAt ? { dueAt: dueAt.toISOString() } : {}),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      });
      const facts = await this.jobFacts(tx, job);
      if (input.assignee.kind === 'staff') {
        const count = await this.eventCount(tx, job.id, 'assigned');
        await this.tasks.create(tx, {
          companyId: job.companyId,
          propertyId: job.propertyId,
          unitId: job.unitId,
          tenantId: job.tenantId,
          kind: 'maintenance_attend',
          title: `Attend ${formatTicketNumber(job.ticketNumber)}: ${job.description.slice(0, 120)}`,
          jobId: job.id,
          recipientId: null,
          assigneePersonId: input.assignee.personId,
          dueAt: dueAt ?? job.completeBy ?? new Date(now.getTime() + 24 * HOUR),
          dedupeKey: `maintenance_attend:${job.id}:${count}`,
          createdBy: staff.personId,
        });
      } else {
        // The job sheet goes by WhatsApp or SMS (decision 6); its link is made as it is sent.
        await queueMessage(tx, job.companyId, {
          messageId: uuidv5(
            `${job.id}:sheet:${await this.eventCount(tx, job.id, 'assigned')}`,
            NAMESPACE,
          ),
          recipient: { type: 'artisan', artisanId: input.assignee.artisanId },
          purpose: 'job_sheet_link',
          body: `${facts.companyName} has a repair job for you at ${placeOf(facts)}: ${job.description.slice(0, 200)}. See it and reply at {{link}}`,
          link: { purpose: 'job_sheet', targetId: job.id },
          channels: ['whatsapp', 'sms'],
          propertyId: job.propertyId,
          related: { type: 'maintenance_job', id: job.id },
          requestedBy: staff.personId,
          templateParams: { artisan: name.slice(0, 60), job: job.description.slice(0, 120) },
        });
      }
      await this.tellTenant(
        tx,
        job,
        'assigned',
        'it has been assigned and someone will be in touch',
      );
    });
  }

  async unassign(actor: Actor | null, jobId: string, reason: string) {
    return this.step(actor, jobId, 'maintenance.manage', async (tx, job, staff, now) => {
      this.move(job, 'unassign');
      const name = await this.assigneeName(tx, job);
      await this.endAssignment(tx, job, now, 'unassigned');
      await tx
        .update(schema.maintenanceJob)
        .set({
          status: 'triaged',
          assigneeKind: null,
          assigneePersonId: null,
          assigneeArtisanId: null,
          artisanResponse: null,
          updatedAt: now,
        })
        .where(eq(schema.maintenanceJob.id, job.id));
      await this.event(tx, job, 'unassigned', staffOf(staff), {
        assigneeName: name ?? '',
        reason: reason.trim(),
      });
    });
  }

  async planVisit(
    actor: Actor | null,
    jobId: string,
    input: { visitAt: string; note?: string | null },
  ) {
    return this.step(actor, jobId, 'maintenance.manage', async (tx, job, staff, now) => {
      if (!['triaged', 'assigned', 'in_progress'].includes(job.status))
        throw conflict('maintenance_transition', 'A visit is planned for an open, triaged job');
      const visitAt = new Date(input.visitAt);
      await tx
        .update(schema.maintenanceJob)
        .set({ visitAt, updatedAt: now })
        .where(eq(schema.maintenanceJob.id, job.id));
      await this.event(tx, job, 'visit_planned', staffOf(staff), {
        visitAt: visitAt.toISOString(),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      });
      const tz = (await companyRecord(tx, job.companyId))?.timeZone ?? 'Africa/Accra';
      await this.tellTenant(
        tx,
        job,
        'visit_planned',
        `a visit is planned for ${visitAt.toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })} (${tz})`,
      );
    });
  }

  async start(
    actor: Actor | null,
    jobId: string,
    input: { uploadIds: readonly string[]; beforePhotoReason?: string | null },
  ) {
    const staff = staffActor(actor);
    const media = await this.stage(staff, input.uploadIds);
    return this.step(
      actor,
      jobId,
      'maintenance.attend',
      async (tx, job, _staff, now) => {
        await this.startWork(tx, job, media, input.beforePhotoReason ?? null, staffOf(staff), now);
      },
      media,
    );
  }

  /** Work started (staff or the artisan's sheet): before photos, or a reason for none. */
  async startWork(
    tx: Tx,
    job: JobRow,
    media: readonly StagedMedia[],
    beforePhotoReason: string | null,
    actor: JobActor,
    now: Date,
  ): Promise<void> {
    await this.recordMedia(tx, job, media, 'before', actor);
    const facts = await this.evidence(tx, job.id);
    this.move(job, 'start', { beforePhotos: facts.before, beforePhotoReason });
    await tx
      .update(schema.maintenanceJob)
      .set({
        status: 'in_progress',
        beforePhotoReason: facts.before > 0 ? null : (beforePhotoReason?.trim() ?? null),
        respondedAt: job.respondedAt ?? now,
        updatedAt: now,
      })
      .where(eq(schema.maintenanceJob.id, job.id));
    await this.event(tx, job, 'started', actor, {
      count: media.length,
      ...(facts.before === 0 && beforePhotoReason
        ? { beforePhotoReason: beforePhotoReason.trim() }
        : {}),
    });
    await this.tellTenant(tx, job, 'started', 'work on it has started');
  }

  async complete(
    actor: Actor | null,
    jobId: string,
    input: { uploadIds: readonly string[]; completionNote: string },
  ) {
    const staff = staffActor(actor);
    const media = await this.stage(staff, input.uploadIds);
    return this.step(
      actor,
      jobId,
      'maintenance.attend',
      async (tx, job, _staff, now) => {
        await this.completeWork(tx, job, media, input.completionNote, staffOf(staff), now);
      },
      media,
    );
  }

  /** Work done (staff or the artisan's sheet): an after photo and a note (MI-06). */
  async completeWork(
    tx: Tx,
    job: JobRow,
    media: readonly StagedMedia[],
    completionNote: string,
    actor: JobActor,
    now: Date,
  ): Promise<void> {
    await this.recordMedia(tx, job, media, 'after', actor);
    const facts = await this.evidence(tx, job.id);
    this.move(job, 'complete', { afterPhotos: facts.afterPhotos, completionNote });
    await tx
      .update(schema.maintenanceJob)
      .set({
        status: 'work_done',
        completionNote: completionNote.trim(),
        workDoneAt: now,
        tenantResponse: null,
        tenantResponseReason: null,
        tenantResponseAt: null,
        tenantResponseVia: null,
        updatedAt: now,
      })
      .where(eq(schema.maintenanceJob.id, job.id));
    await this.event(tx, job, 'work_done', actor, {
      completionNote: completionNote.trim(),
      count: media.length,
    });
    await this.tasks.closeOpen(
      tx,
      { jobId: job.id, kinds: ['maintenance_attend'] },
      'done',
      'Work done',
      actor.personId ?? null,
    );
    const ticket = formatTicketNumber(job.ticketNumber);
    await this.tellTenant(
      tx,
      job,
      'work_done',
      `the work is done. Please confirm in the app, or reply FIXED ${ticket}, or NOT FIXED ${ticket} and what is still wrong`,
    );
  }

  async recordResponse(
    actor: Actor | null,
    jobId: string,
    input: { response: 'confirmed' | 'disputed'; reason?: string | null },
  ) {
    return this.step(actor, jobId, 'maintenance.manage', async (tx, job, staff, now) => {
      if (!job.tenantId)
        throw conflict(
          'no_tenant',
          'This repair has no tenant to confirm it. Close it once you have checked the work.',
        );
      await this.respond(
        tx,
        job,
        input.response,
        input.reason ?? null,
        'staff',
        staffOf(staff),
        now,
      );
    });
  }

  /**
   * A job with no tenant (a common area or an empty unit) closes when staff have checked the work
   * (Work done → Closed); a tenant's job closes on their answer or after the auto-close days.
   */
  async close(actor: Actor | null, jobId: string, note?: string | null) {
    return this.step(actor, jobId, 'maintenance.manage', async (tx, job, staff, now) => {
      if (job.tenantId)
        throw conflict(
          'tenant_confirms',
          'The tenant confirms this repair. Record their answer, or it closes on its own after the auto-close days.',
        );
      this.move(job, 'confirm');
      await tx
        .update(schema.maintenanceJob)
        .set({ status: 'closed', closedAt: now, updatedAt: now })
        .where(eq(schema.maintenanceJob.id, job.id));
      await this.event(tx, job, 'closed', staffOf(staff), {
        via: 'staff',
        ...(note?.trim() ? { note: note.trim() } : {}),
      });
      await this.revokeSheets(tx, job.id, now, 'job_closed');
    });
  }

  /**
   * The tenant's answer to work done (decision 7): confirmed closes the job; disputed sends it back
   * to In progress with the reason, and tells the managers.
   */
  async respond(
    tx: Tx,
    job: JobRow,
    response: 'confirmed' | 'disputed',
    reason: string | null,
    via: 'app' | 'whatsapp' | 'sms' | 'staff',
    actor: JobActor,
    now: Date,
  ): Promise<void> {
    this.move(job, response === 'confirmed' ? 'confirm' : 'dispute', { reason });
    await tx
      .update(schema.maintenanceJob)
      .set({
        status: response === 'confirmed' ? 'closed' : 'in_progress',
        tenantResponse: response,
        tenantResponseReason: reason?.trim() || null,
        tenantResponseAt: now,
        tenantResponseVia: via,
        ...(response === 'confirmed' ? { closedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(schema.maintenanceJob.id, job.id));
    if (response === 'confirmed') {
      await this.event(tx, job, 'confirmed', actor, { via });
      await this.event(tx, job, 'closed', actor, { via });
      await this.revokeSheets(tx, job.id, now, 'job_closed');
    } else {
      await this.event(tx, job, 'disputed', actor, { reason: reason?.trim() ?? '', via });
      await this.notifyManagers(
        tx,
        job,
        `disputed:${job.id}:${now.getTime()}`,
        `${formatTicketNumber(job.ticketNumber)} is not fixed`,
        `The tenant says ${formatTicketNumber(job.ticketNumber)} is not fixed: "${(reason ?? '').slice(0, 500)}". It is back in progress.`,
      );
    }
  }

  async cancel(actor: Actor | null, jobId: string, reason: string) {
    return this.step(actor, jobId, 'maintenance.manage', async (tx, job, staff, now) => {
      this.move(job, 'cancel', { reason });
      await tx
        .update(schema.maintenanceJob)
        .set({ status: 'cancelled', cancelReason: reason.trim(), updatedAt: now })
        .where(eq(schema.maintenanceJob.id, job.id));
      await this.event(tx, job, 'cancelled', staffOf(staff), { reason: reason.trim() });
      await this.revokeSheets(tx, job.id, now, 'job_cancelled');
      await this.tasks.closeOpen(
        tx,
        { jobId: job.id, kinds: ['maintenance_attend'] },
        'cancelled',
        'The repair was cancelled',
        staff.personId,
      );
      await this.tellTenant(
        tx,
        job,
        'cancelled',
        `it was closed without work: ${reason.trim().slice(0, 200)}`,
      );
    });
  }

  async addMedia(
    actor: Actor | null,
    jobId: string,
    input: { stage: MaintenanceAttachmentStage; uploadIds: readonly string[] },
  ) {
    const staff = staffActor(actor);
    const media = await this.stage(staff, input.uploadIds);
    return this.step(
      actor,
      jobId,
      'maintenance.attend',
      async (tx, job) => {
        if (!OPEN_MAINTENANCE_STATUSES.includes(job.status as MaintenanceJobStatus))
          throw conflict('maintenance_closed', 'This job is closed; its files are fixed');
        await this.recordMedia(tx, job, media, input.stage, staffOf(staff));
        await this.event(tx, job, 'media_added', staffOf(staff), {
          count: media.length,
          stage: input.stage,
        });
      },
      media,
    );
  }

  async addNote(actor: Actor | null, jobId: string, note: string) {
    return this.step(actor, jobId, 'maintenance.attend', async (tx, job, staff) => {
      await this.event(tx, job, 'note', staffOf(staff), { note: note.trim() });
    });
  }

  // The tenant app (MI-01, CM-04; decision 3) -------------------------------------------------

  /**
   * A repair from the app: idempotent by the app's client id. On Starter (decision 1) it is
   * logged on the timeline and forwarded to the landlord. The caller (TenantRepairsService) has
   * checked, in the tenant's own scoped transaction, that the lease is theirs; this writes in the
   * company's system context, as the tenant (events record them).
   */
  async tenantReport(
    companyId: string,
    input: {
      readonly leaseId: string;
      readonly tenantId: string;
      readonly personId: string;
      readonly clientId: string;
      readonly category: MaintenanceCategory;
      readonly description: string;
      readonly emergency: boolean;
      readonly media: readonly StagedMedia[];
    },
  ): Promise<TenantRepairView> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [lease] = await tx
        .select({
          id: schema.lease.id,
          propertyId: schema.lease.propertyId,
          unitId: schema.lease.unitId,
          tenantId: schema.lease.tenantId,
          status: schema.lease.status,
        })
        .from(schema.lease)
        .where(and(eq(schema.lease.id, input.leaseId), eq(schema.lease.tenantId, input.tenantId)));
      if (!lease || ['draft', 'cancelled'].includes(lease.status)) throw notFound('Tenancy');
      if (!(await this.entitlements.hasIn(tx, companyId, 'maintenance')))
        return this.forward(tx, companyId, lease, input);
      const job = await this.report(tx, companyId, {
        propertyId: lease.propertyId,
        unitId: lease.unitId,
        leaseId: lease.id,
        tenantId: lease.tenantId,
        source: 'app',
        description: input.description,
        conversationId: null,
        messageIds: [],
        reportedBy: input.personId,
        category: input.category,
        emergencyFlag: input.emergency,
        clientId: input.clientId,
        media: input.media,
        actor: { kind: 'tenant', personId: input.personId },
      });
      const [view] = await this.tenantViews(tx, [job.jobId]);
      return view!;
    });
  }

  /** Starter (decision 1): the request goes to the landlord's people, on the tenant's timeline. */
  private async forward(
    tx: Tx,
    companyId: string,
    lease: { id: string; propertyId: string; unitId: string; tenantId: string },
    input: {
      clientId: string;
      category: MaintenanceCategory;
      description: string;
      emergency: boolean;
    },
  ): Promise<TenantRepairView> {
    const company = await companyRecord(tx, companyId);
    const [tenant] = await tx
      .select({ name: schema.tenant.displayName })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, lease.tenantId));
    const [unit] = await tx
      .select({ code: schema.unit.code })
      .from(schema.unit)
      .where(eq(schema.unit.id, lease.unitId));
    const people = company ? await membersWhoCan(tx, this.policy, company, 'company.update') : [];
    for (const personId of people)
      await queueMessage(tx, companyId, {
        messageId: uuidv5(`${input.clientId}:forward:${personId}`, NAMESPACE),
        recipient: { type: 'staff', personId },
        purpose: 'staff_notice',
        subject: `A repair request from ${tenant?.name ?? 'a tenant'}`,
        body: `${tenant?.name ?? 'A tenant'} (${unit?.code ?? 'their unit'}) asked for a repair in the app${input.emergency ? ' and said it is an emergency' : ''}: "${input.description.slice(0, 1500)}". Contact them by phone or WhatsApp.`,
        channels: ['email', 'sms'],
        propertyId: lease.propertyId,
        related: { type: 'tenant', id: lease.tenantId },
      });
    const now = this.clock.now();
    return {
      jobId: input.clientId,
      ticket: '',
      status: 'reported',
      statusLabel: 'Sent to your landlord',
      description: input.description,
      category: input.category,
      emergency: input.emergency,
      leaseId: lease.id,
      unitCode: unit?.code ?? null,
      visitAt: null,
      awaitingResponse: false,
      completionNote: null,
      steps: [{ kind: 'reported', at: now }],
      attachments: [],
      createdAt: now,
      forwarded: true,
    };
  }

  /** The tenant's repairs in their scoped transaction (RLS keeps them to their own). */
  async tenantRepairs(tx: Tx): Promise<TenantRepairView[]> {
    const rows = await tx
      .select({ id: schema.maintenanceJob.id })
      .from(schema.maintenanceJob)
      .orderBy(desc(schema.maintenanceJob.createdAt))
      .limit(100);
    return this.tenantViews(
      tx,
      rows.map((r) => r.id),
    );
  }

  /**
   * The tenant's answer from the app. The caller has checked, in the tenant's scoped transaction,
   * that the job is theirs; this writes in the company's system context, as the tenant.
   */
  async tenantRespond(
    companyId: string,
    jobId: string,
    tenantId: string,
    personId: string,
    input: { response: 'confirmed' | 'disputed'; reason?: string | null },
  ): Promise<TenantRepairView | null> {
    try {
      return await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
        const [job] = await tx
          .select()
          .from(schema.maintenanceJob)
          .where(
            and(eq(schema.maintenanceJob.id, jobId), eq(schema.maintenanceJob.tenantId, tenantId)),
          )
          .for('update');
        if (!job) return null;
        await this.respond(
          tx,
          job,
          input.response,
          input.reason ?? null,
          'app',
          { kind: 'tenant', personId },
          this.clock.now(),
        );
        const [view] = await this.tenantViews(tx, [jobId]);
        return view ?? null;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return conflictOf(error);
    }
  }

  /**
   * The bot's answer for a tenant on WhatsApp (decision 7), in the company's transaction: a job of
   * this tenant waiting for an answer. False when there is none (already answered).
   */
  async botRespond(
    tx: Tx,
    input: {
      readonly jobId: string;
      readonly tenantId: string;
      readonly response: 'confirmed' | 'disputed';
      readonly reason: string | null;
    },
  ): Promise<boolean> {
    const [job] = await tx
      .select()
      .from(schema.maintenanceJob)
      .where(
        and(
          eq(schema.maintenanceJob.id, input.jobId),
          eq(schema.maintenanceJob.tenantId, input.tenantId),
        ),
      )
      .for('update');
    if (!job || job.status !== 'work_done') return false;
    await this.respond(
      tx,
      job,
      input.response,
      input.reason,
      'whatsapp',
      { kind: 'tenant' },
      this.clock.now(),
    );
    return true;
  }

  /** "My repairs" for the bot (decision 14): the tenant's open jobs, newest first. */
  async openRepairsFor(tx: Tx, tenantId: string) {
    const rows = await tx
      .select({
        id: schema.maintenanceJob.id,
        n: schema.maintenanceJob.ticketNumber,
        status: schema.maintenanceJob.status,
      })
      .from(schema.maintenanceJob)
      .where(
        and(
          eq(schema.maintenanceJob.tenantId, tenantId),
          inArray(schema.maintenanceJob.status, [...OPEN_MAINTENANCE_STATUSES]),
        ),
      )
      .orderBy(desc(schema.maintenanceJob.ticketNumber))
      .limit(10);
    return rows.map((r) => ({
      jobId: r.id,
      ticket: formatTicketNumber(r.n),
      statusLabel: MAINTENANCE_JOB_STATUS_LABELS[r.status as MaintenanceJobStatus],
      awaitingResponse: r.status === 'work_done',
    }));
  }

  async tenantAttachmentDocument(tx: Tx, jobId: string, attachmentId: string) {
    const [row] = await tx
      .select({ documentId: schema.maintenanceJobAttachment.documentId })
      .from(schema.maintenanceJobAttachment)
      .where(
        and(
          eq(schema.maintenanceJobAttachment.id, attachmentId),
          eq(schema.maintenanceJobAttachment.jobId, jobId),
        ),
      );
    return row?.documentId ?? null;
  }

  async tenantViews(tx: Tx, ids: readonly string[]): Promise<TenantRepairView[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select()
      .from(schema.maintenanceJob)
      .where(inArray(schema.maintenanceJob.id, [...ids]))
      .orderBy(desc(schema.maintenanceJob.createdAt));
    const units = await this.unitCodes(tx, rows);
    const events = await tx
      .select({
        jobId: schema.maintenanceJobEvent.jobId,
        kind: schema.maintenanceJobEvent.kind,
        at: schema.maintenanceJobEvent.at,
      })
      .from(schema.maintenanceJobEvent)
      .where(
        and(
          inArray(schema.maintenanceJobEvent.jobId, [...ids]),
          inArray(schema.maintenanceJobEvent.kind, [...TENANT_STEPS, 'auto_closed']),
        ),
      )
      .orderBy(asc(schema.maintenanceJobEvent.at));
    const files = await tx
      .select({
        id: schema.maintenanceJobAttachment.id,
        jobId: schema.maintenanceJobAttachment.jobId,
        kind: schema.maintenanceJobAttachment.kind,
        stage: schema.maintenanceJobAttachment.stage,
        contentType: schema.document.contentType,
      })
      .from(schema.maintenanceJobAttachment)
      .innerJoin(
        schema.document,
        and(
          eq(schema.document.companyId, schema.maintenanceJobAttachment.companyId),
          eq(schema.document.id, schema.maintenanceJobAttachment.documentId),
        ),
      )
      .where(
        and(
          inArray(schema.maintenanceJobAttachment.jobId, [...ids]),
          // What the tenant sees of a job (0042): the report, before and after files.
          inArray(schema.maintenanceJobAttachment.stage, ['report', 'before', 'after']),
        ),
      );
    return rows.map((r) => ({
      jobId: r.id,
      ticket: formatTicketNumber(r.ticketNumber),
      status: r.status as MaintenanceJobStatus,
      statusLabel: MAINTENANCE_JOB_STATUS_LABELS[r.status as MaintenanceJobStatus],
      description: r.description,
      category: r.category as MaintenanceCategory | null,
      emergency: r.emergencyFlag || r.priority === 'emergency',
      leaseId: r.leaseId,
      unitCode: r.unitId ? (units.get(r.unitId) ?? null) : null,
      visitAt: r.visitAt,
      awaitingResponse: r.status === 'work_done',
      completionNote: r.completionNote,
      steps: events
        .filter((e) => e.jobId === r.id)
        .map((e) => ({
          kind: (e.kind === 'auto_closed' ? 'closed' : e.kind) as (typeof TENANT_STEPS)[number],
          at: e.at,
        })),
      attachments: files
        .filter((f) => f.jobId === r.id)
        .map((f) => ({
          id: f.id,
          kind: f.kind as MaintenanceAttachmentKind,
          stage: f.stage as MaintenanceAttachmentStage,
          contentType: f.contentType,
        })),
      createdAt: r.createdAt,
      forwarded: false,
    }));
  }

  // Scheduled work (plan 4.13) ------------------------------------------------------------------

  /**
   * `maintenance.emergency-alert` (decision 5): the property's managers and caretakers, on
   * WhatsApp (those who opted in) and by SMS, both at once, once each however often it runs.
   */
  async emergencyAlert(companyId: string, jobId: string): Promise<number> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [job] = await tx
        .select()
        .from(schema.maintenanceJob)
        .where(eq(schema.maintenanceJob.id, jobId));
      if (!job || job.status === 'closed' || job.status === 'cancelled') return 0;
      const facts = await this.jobFacts(tx, job);
      const people = await this.alertRecipients(tx, job);
      const ticket = formatTicketNumber(job.ticketNumber);
      let alerted = 0;
      for (const person of people) {
        const recorded = await this.event(
          tx,
          job,
          'alerted',
          { kind: 'system' },
          { channels: ['whatsapp', 'sms'], recipientName: person.name },
          `alert:${job.id}:${person.personId}`,
        );
        for (const channel of ['whatsapp', 'sms'] as const)
          await queueMessage(tx, companyId, {
            messageId: uuidv5(`${job.id}:alert:${person.personId}:${channel}`, NAMESPACE),
            recipient: { type: 'staff', personId: person.personId },
            purpose: 'maintenance_alert',
            body: `Emergency repair ${ticket} at ${placeOf(facts)}: ${job.description.slice(0, 300)}. Open the maintenance board now.`,
            channels: [channel],
            propertyId: job.propertyId,
            related: { type: 'maintenance_job', id: job.id },
            templateParams: { ticket, place: placeOf(facts).slice(0, 120) },
          });
        if (recorded) alerted += 1;
      }
      return alerted;
    });
  }

  /** `maintenance.sla-check` (decision 4): each warning once per job, target and stage. */
  async slaCheck(companyId: string): Promise<number> {
    const now = this.clock.now();
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const settings = staffSettings(await companyRecord(tx, companyId));
      const jobs = await tx
        .select()
        .from(schema.maintenanceJob)
        .where(
          and(
            inArray(schema.maintenanceJob.status, ['triaged', 'assigned', 'in_progress']),
            sql`${schema.maintenanceJob.priority} is not null`,
          ),
        );
      let warned = 0;
      for (const job of jobs) {
        const sent = new Set(
          (
            await tx
              .select({ key: schema.maintenanceJobEvent.dedupeKey })
              .from(schema.maintenanceJobEvent)
              .where(
                and(
                  eq(schema.maintenanceJobEvent.jobId, job.id),
                  eq(schema.maintenanceJobEvent.kind, 'sla_warned'),
                ),
              )
          ).flatMap((r) => (r.key ? [r.key] : [])),
        );
        const priority = job.priority as MaintenancePriority;
        for (const w of dueSlaWarnings({
          jobId: job.id,
          status: job.status as MaintenanceJobStatus,
          priority,
          reportedAt: job.createdAt,
          respondedAt: job.respondedAt,
          workDoneAt: job.workDoneAt,
          target: settings.targets[priority],
          now,
          sent,
        })) {
          const recorded = await this.event(
            tx,
            job,
            'sla_warned',
            { kind: 'system' },
            { target: w.target, stage: w.stage, dueAt: w.dueAt.toISOString() },
            w.key,
          );
          if (!recorded) continue;
          warned += 1;
          const ticket = formatTicketNumber(job.ticketNumber);
          const what = w.target === 'respond' ? 'response' : 'completion';
          await this.notifyManagers(
            tx,
            job,
            w.key,
            w.stage === 'missed'
              ? `${ticket}: the ${what} target was missed`
              : `${ticket}: the ${what} target is close`,
            `${MAINTENANCE_PRIORITY_LABELS[priority]} repair ${ticket}: the ${what} target ${w.stage === 'missed' ? 'was missed' : 'is about to be missed'} (due ${w.dueAt.toISOString()}). Open the maintenance board.`,
          );
        }
      }
      return warned;
    });
  }

  /** `maintenance.auto-close` (decision 7): work done with no reply for the company's days. */
  async autoClose(companyId: string): Promise<number> {
    const now = this.clock.now();
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const days = staffSettings(await companyRecord(tx, companyId)).autoCloseDays;
      const jobs = await tx
        .select()
        .from(schema.maintenanceJob)
        .where(eq(schema.maintenanceJob.status, 'work_done'))
        .for('update');
      let closed = 0;
      for (const job of jobs) {
        if (!job.workDoneAt || !autoCloseDue(job.workDoneAt, now, days)) continue;
        this.move(job, 'auto_close');
        await tx
          .update(schema.maintenanceJob)
          .set({ status: 'closed', closedAt: now, updatedAt: now })
          .where(eq(schema.maintenanceJob.id, job.id));
        await this.event(
          tx,
          job,
          'auto_closed',
          { kind: 'system' },
          { days },
          `auto_close:${job.id}`,
        );
        await this.revokeSheets(tx, job.id, now, 'job_closed');
        await this.tellTenant(
          tx,
          job,
          'closed',
          `it is closed, as we did not hear back within ${days} days`,
        );
        closed += 1;
      }
      return closed;
    });
  }

  // Shared with the job sheet (job-sheet.service.ts) -------------------------------------------

  async lockJob(tx: Tx, jobId: string): Promise<JobRow> {
    const [job] = await tx
      .select()
      .from(schema.maintenanceJob)
      .where(eq(schema.maintenanceJob.id, jobId))
      .for('update');
    if (!job) throw notFound('Repair');
    return job;
  }

  /** Records an event; false when its dedupe key was recorded already. */
  async event(
    tx: Tx,
    job: Pick<JobRow, 'id' | 'companyId' | 'propertyId'>,
    kind: string,
    actor: JobActor,
    data: Record<string, unknown> | null,
    dedupeKey: string | null = null,
  ): Promise<boolean> {
    const rows = await tx
      .insert(schema.maintenanceJobEvent)
      .values({
        companyId: job.companyId,
        propertyId: job.propertyId,
        jobId: job.id,
        kind,
        actorKind: actor.kind,
        actorPersonId: actor.kind === ARTISAN_KIND ? null : (actor.personId ?? null),
        actorArtisanId: actor.kind === ARTISAN_KIND ? (actor.artisanId ?? null) : null,
        data,
        dedupeKey,
        at: this.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: schema.maintenanceJobEvent.id });
    return rows.length > 0;
  }

  /** Records staged files on a job as its attachments of a stage. */
  async recordMedia(
    tx: Tx,
    job: Pick<JobRow, 'id' | 'companyId' | 'propertyId'>,
    media: readonly StagedMedia[],
    stage: MaintenanceAttachmentStage,
    actor: JobActor,
  ): Promise<void> {
    for (const m of media) {
      const documentId = await this.documents.recordStagedMedia(tx, m, 'maintenance_media');
      await tx.insert(schema.maintenanceJobAttachment).values({
        companyId: job.companyId,
        propertyId: job.propertyId,
        jobId: job.id,
        documentId,
        kind: m.kind,
        stage,
        addedByKind: actor.kind === 'system' ? 'staff' : actor.kind,
        addedBy:
          actor.kind === 'staff' || actor.kind === TENANT_KIND ? (actor.personId ?? null) : null,
        addedByArtisanId: actor.kind === ARTISAN_KIND ? (actor.artisanId ?? null) : null,
        sizeBytes: m.sizeBytes,
        durationSeconds: m.durationSeconds,
      });
    }
  }

  /** The job's place, property and company, for messages. */
  async jobFacts(tx: Tx, job: Pick<JobRow, 'companyId' | 'propertyId' | 'unitId'>) {
    const company = await companyRecord(tx, job.companyId);
    const [property] = await tx
      .select({ name: schema.property.name })
      .from(schema.property)
      .where(eq(schema.property.id, job.propertyId));
    const [unit] = job.unitId
      ? await tx
          .select({ code: schema.unit.code })
          .from(schema.unit)
          .where(eq(schema.unit.id, job.unitId))
      : [];
    return {
      companyName: company?.displayName ?? '',
      timeZone: company?.timeZone ?? 'Africa/Accra',
      propertyName: property?.name ?? '',
      unitCode: unit?.code ?? null,
    };
  }

  /** The artisan's links for a job stop working (unassigned, closed, cancelled). */
  async revokeSheets(tx: Tx, jobId: string, now: Date, reason: string, artisanId?: string) {
    await tx
      .update(schema.secureLink)
      .set({ revokedAt: now, revokeReason: reason })
      .where(
        and(
          eq(schema.secureLink.jobId, jobId),
          eq(schema.secureLink.purpose, 'job_sheet'),
          sql`${schema.secureLink.revokedAt} is null`,
          artisanId ? eq(schema.secureLink.artisanId, artisanId) : undefined,
        ),
      );
  }

  move(
    job: Pick<JobRow, 'status'>,
    action: MaintenanceJobAction,
    facts: MaintenanceStepFacts = {},
  ) {
    try {
      return nextMaintenanceStatus(job.status as MaintenanceJobStatus, action, facts);
    } catch (error) {
      return conflictOf(error);
    }
  }

  async evidence(tx: Tx, jobId: string) {
    const rows = await tx
      .select({
        stage: schema.maintenanceJobAttachment.stage,
        kind: schema.maintenanceJobAttachment.kind,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.maintenanceJobAttachment)
      .where(eq(schema.maintenanceJobAttachment.jobId, jobId))
      .groupBy(schema.maintenanceJobAttachment.stage, schema.maintenanceJobAttachment.kind);
    const count = (stage: string, kind?: string) =>
      rows
        .filter((r) => r.stage === stage && (!kind || r.kind === kind))
        .reduce((s, r) => s + Number(r.n), 0);
    return { before: count('before'), afterPhotos: count('after', 'image') };
  }

  /** Tells the tenant about a step (CM-04), on their channel with their consent. */
  async tellTenant(tx: Tx, job: JobRow, step: string, update: string): Promise<void> {
    if (!job.tenantId) return;
    const facts = await this.jobFacts(tx, job);
    const ticket = formatTicketNumber(job.ticketNumber);
    const n = await this.eventCount(tx, job.id, 'tenant_updated');
    const message: NewMessage = {
      messageId: uuidv5(`${job.id}:tenant:${step}:${n}`, NAMESPACE),
      recipient: { type: 'tenant', tenantId: job.tenantId },
      purpose: 'repair_update',
      subject: `Your repair ${ticket}`,
      body: `An update from ${facts.companyName} on your repair ${ticket}: ${update}.`,
      propertyId: job.propertyId,
      related: { type: 'maintenance_job', id: job.id },
      templateParams: { ticket, update: update.slice(0, 400) },
    };
    await queueMessage(tx, job.companyId, message);
    await this.event(tx, job, 'tenant_updated', { kind: 'system' }, { step });
  }

  // Internals ---------------------------------------------------------------------------------

  private reader(actor: Actor | null): StaffActor {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'maintenance.read');
    return staff;
  }

  /** Stages uploads outside any transaction (decision 2). */
  private async stage(staff: StaffActor, uploadIds: readonly string[]): Promise<StagedMedia[]> {
    const out: StagedMedia[] = [];
    for (const id of new Set(uploadIds))
      out.push(
        await this.documents.stageMediaUpload(
          { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' },
          staff.personId,
          id,
          JOB_MEDIA_UPLOAD,
        ),
      );
    return out;
  }

  private async write<T>(
    staff: StaffActor,
    fn: (tx: Tx) => Promise<T>,
    media: readonly StagedMedia[] = [],
  ): Promise<T> {
    let result: T;
    try {
      result = await withCompany(this.database, staffContext(staff), fn);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return conflictOf(error);
    }
    for (const m of media) await this.documents.discardStagedMedia(m);
    return result;
  }

  private async step(
    actor: Actor | null,
    jobId: string,
    action: PolicyAction,
    fn: (tx: Tx, job: JobRow, staff: StaffActor, now: Date) => Promise<void>,
    media: readonly StagedMedia[] = [],
  ): Promise<MaintenanceJobDetail> {
    const staff = staffActor(actor);
    this.policy.assert(staff, action);
    await this.entitlements.assert(staff.companyId, 'maintenance');
    await this.write(
      staff,
      async (tx) => {
        const job = await this.lockJob(tx, jobId);
        await fn(tx, job, staff, this.clock.now());
      },
      media,
    );
    return this.get(actor, jobId);
  }

  private async applyTriage(
    tx: Tx,
    job: JobRow,
    priority: MaintenancePriority,
    category: MaintenanceCategory,
    now: Date,
  ) {
    const settings = staffSettings(await companyRecord(tx, job.companyId));
    await tx
      .update(schema.maintenanceJob)
      .set({
        status: 'triaged',
        priority,
        category,
        ...this.targetsFor(job, priority, settings),
        updatedAt: now,
      })
      .where(eq(schema.maintenanceJob.id, job.id));
  }

  private targetsFor(
    job: Pick<JobRow, 'createdAt'>,
    priority: MaintenancePriority,
    settings: ReturnType<typeof maintenanceSettingsOf>,
  ) {
    const due = maintenanceDueTimes(job.createdAt, settings.targets[priority]);
    return { respondBy: due.respond, completeBy: due.complete };
  }

  private async queueAlert(tx: Tx, job: Pick<JobRow, 'id' | 'companyId'>) {
    await enqueueOutbox(tx, {
      companyId: job.companyId,
      type: MAINTENANCE_EMERGENCY_ALERT_JOB,
      payload: { jobId: job.id },
      idempotencyKey: `${MAINTENANCE_EMERGENCY_ALERT_JOB}:${job.id}`,
    });
  }

  /** The property's managers and caretakers (decision 5); with none, those who manage it. */
  private async alertRecipients(tx: Tx, job: JobRow) {
    const company = await companyRecord(tx, job.companyId);
    if (!company) return [];
    const actors = await memberActors(tx, company);
    const covered = await this.coveredBy(tx, actors, job.propertyId);
    let ids = covered
      .filter((a) => this.policy.can(a, 'maintenance.alert').allowed)
      .map((a) => a.personId);
    if (ids.length === 0) ids = await this.tasks.managersFor(tx, job.companyId, job.propertyId);
    const people = ids.length
      ? await tx
          .select({ id: schema.person.id, name: schema.person.name })
          .from(schema.person)
          .where(inArray(schema.person.id, [...new Set(ids)]))
      : [];
    return people.map((p) => ({ personId: p.id, name: p.name }));
  }

  private async coveredBy(tx: Tx, actors: readonly StaffActor[], propertyId: string) {
    const out: StaffActor[] = [];
    for (const a of actors) {
      const scope = scopeOf(a);
      if (!scope) {
        out.push(a);
        continue;
      }
      const covered = await tx.execute<{ scope: string[] | null }>(
        sql`select app.resolve_property_scope(${`{${scope.ownerIds.join(',')}}`}::uuid[],
              ${`{${scope.propertyIds.join(',')}}`}::uuid[])::text[] as scope`,
      );
      if ((covered.rows[0]?.scope ?? []).includes(propertyId)) out.push(a);
    }
    return out;
  }

  /** Who may be assigned in-house work: caretakers and managers covering the property. */
  private async assignableStaff(tx: Tx, job: JobRow): Promise<Map<string, string>> {
    const company = await companyRecord(tx, job.companyId);
    if (!company) return new Map();
    const actors = (
      await this.coveredBy(tx, await memberActors(tx, company), job.propertyId)
    ).filter((a) => this.policy.can(a, 'maintenance.attend').allowed);
    if (actors.length === 0) return new Map();
    const people = await tx
      .select({ id: schema.person.id, name: schema.person.name })
      .from(schema.person)
      .where(
        inArray(
          schema.person.id,
          actors.map((a) => a.personId),
        ),
      );
    return new Map(people.map((p) => [p.id, p.name]));
  }

  private async notifyManagers(tx: Tx, job: JobRow, key: string, subject: string, body: string) {
    const ids = await this.tasks.managersFor(tx, job.companyId, job.propertyId);
    for (const personId of ids)
      await queueMessage(tx, job.companyId, {
        messageId: uuidv5(`${key}:${personId}`, NAMESPACE),
        recipient: { type: 'staff', personId },
        purpose: 'staff_notice',
        subject,
        body,
        channels: ['email', 'sms'],
        propertyId: job.propertyId,
        related: { type: 'maintenance_job', id: job.id },
      });
  }

  /** Ends the current assignment: the staff task cancelled, or the artisan's sheet revoked. */
  private async endAssignment(tx: Tx, job: JobRow, now: Date, reason: string) {
    if (job.assigneeKind === 'staff')
      await this.tasks.closeOpen(
        tx,
        { jobId: job.id, kinds: ['maintenance_attend'] },
        'cancelled',
        reason === 'reassigned' ? 'Reassigned' : 'Unassigned',
        null,
      );
    if (job.assigneeKind === ARTISAN_KIND && job.assigneeArtisanId)
      await this.revokeSheets(tx, job.id, now, reason, job.assigneeArtisanId);
  }

  private async assigneeName(tx: Tx, job: JobRow): Promise<string | null> {
    if (job.assigneePersonId) {
      const [p] = await tx
        .select({ name: schema.person.name })
        .from(schema.person)
        .where(eq(schema.person.id, job.assigneePersonId));
      return p?.name ?? null;
    }
    if (job.assigneeArtisanId) {
      const [a] = await tx
        .select({ name: schema.artisan.name })
        .from(schema.artisan)
        .where(eq(schema.artisan.id, job.assigneeArtisanId));
      return a?.name ?? null;
    }
    return null;
  }

  private async eventCount(tx: Tx, jobId: string, kind: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.maintenanceJobEvent)
      .where(
        and(eq(schema.maintenanceJobEvent.jobId, jobId), eq(schema.maintenanceJobEvent.kind, kind)),
      );
    return Number(row?.n ?? 0);
  }

  private async unitCodes(tx: Tx, rows: readonly { unitId: string | null }[]) {
    const ids = [...new Set(rows.flatMap((r) => (r.unitId ? [r.unitId] : [])))];
    if (ids.length === 0) return new Map<string, string>();
    const units = await tx
      .select({ id: schema.unit.id, code: schema.unit.code })
      .from(schema.unit)
      .where(inArray(schema.unit.id, ids));
    return new Map(units.map((u) => [u.id, u.code]));
  }

  private async detail(tx: Tx, staff: StaffActor, jobId: string): Promise<MaintenanceJobDetail> {
    const [row] = await tx
      .select()
      .from(schema.maintenanceJob)
      .where(eq(schema.maintenanceJob.id, jobId));
    if (!row) throw notFound('Repair');
    const [view] = await this.views(tx, [row]);
    const attachments = await tx
      .select({
        id: schema.maintenanceJobAttachment.id,
        kind: schema.maintenanceJobAttachment.kind,
        stage: schema.maintenanceJobAttachment.stage,
        contentType: schema.document.contentType,
        sizeBytes: schema.maintenanceJobAttachment.sizeBytes,
        durationSeconds: schema.maintenanceJobAttachment.durationSeconds,
        createdAt: schema.maintenanceJobAttachment.createdAt,
        addedByKind: schema.maintenanceJobAttachment.addedByKind,
      })
      .from(schema.maintenanceJobAttachment)
      .innerJoin(
        schema.document,
        and(
          eq(schema.document.companyId, schema.maintenanceJobAttachment.companyId),
          eq(schema.document.id, schema.maintenanceJobAttachment.documentId),
        ),
      )
      .where(eq(schema.maintenanceJobAttachment.jobId, jobId))
      .orderBy(asc(schema.maintenanceJobAttachment.createdAt));
    const events = await tx
      .select({
        id: schema.maintenanceJobEvent.id,
        kind: schema.maintenanceJobEvent.kind,
        at: schema.maintenanceJobEvent.at,
        actorKind: schema.maintenanceJobEvent.actorKind,
        data: schema.maintenanceJobEvent.data,
        personName: schema.person.name,
        artisanName: schema.artisan.name,
      })
      .from(schema.maintenanceJobEvent)
      .leftJoin(schema.person, eq(schema.person.id, schema.maintenanceJobEvent.actorPersonId))
      .leftJoin(
        schema.artisan,
        and(
          eq(schema.artisan.companyId, schema.maintenanceJobEvent.companyId),
          eq(schema.artisan.id, schema.maintenanceJobEvent.actorArtisanId),
        ),
      )
      .where(eq(schema.maintenanceJobEvent.jobId, jobId))
      .orderBy(asc(schema.maintenanceJobEvent.at), asc(schema.maintenanceJobEvent.id));
    const tasks = await tx
      .select({
        id: schema.task.id,
        kind: schema.task.kind,
        status: schema.task.status,
        assigneePersonId: schema.task.assigneePersonId,
        assigneeName: schema.person.name,
        dueAt: schema.task.dueAt,
      })
      .from(schema.task)
      .leftJoin(schema.person, eq(schema.person.id, schema.task.assigneePersonId))
      .where(eq(schema.task.jobId, jobId))
      .orderBy(asc(schema.task.createdAt));
    const expenses = this.policy.can(staff, 'expense.read').allowed
      ? await expenseRows(tx, { jobId })
      : [];
    const status = row.status as MaintenanceJobStatus;
    const open = OPEN_MAINTENANCE_STATUSES.includes(status);
    const manage = this.policy.can(staff, 'maintenance.manage').allowed;
    const attend = this.policy.can(staff, 'maintenance.attend').allowed;
    return {
      ...view!,
      attachments: attachments.map((a) => ({
        ...a,
        kind: a.kind as MaintenanceAttachmentKind,
        stage: a.stage as MaintenanceAttachmentStage,
        addedByKind: a.addedByKind as 'staff' | 'artisan' | 'tenant' | 'message',
      })),
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind as MaintenanceEventKind,
        at: e.at,
        actorKind: e.actorKind as 'staff' | 'artisan' | 'tenant' | 'system',
        actorName: e.artisanName ?? e.personName ?? null,
        data: (e.data as Record<string, unknown> | null) ?? null,
      })),
      tasks: tasks.map((t) => ({
        id: t.id,
        kind: t.kind as TaskKind,
        status: t.status as TaskStatus,
        assignee: t.assigneePersonId
          ? { personId: t.assigneePersonId, name: t.assigneeName ?? '' }
          : null,
        dueAt: t.dueAt,
      })),
      beforePhotoReason: row.beforePhotoReason,
      completionNote: row.completionNote,
      tenantResponse:
        row.tenantResponse && row.tenantResponseAt
          ? {
              kind: row.tenantResponse as 'confirmed' | 'disputed',
              reason: row.tenantResponseReason,
              at: row.tenantResponseAt,
              via: (row.tenantResponseVia ?? 'staff') as 'app' | 'whatsapp' | 'sms' | 'staff',
            }
          : null,
      expenses,
      actions: {
        triage: manage && (status === 'reported' || status === 'triaged'),
        changePriority: manage && open,
        assign: manage && (status === 'triaged' || status === 'assigned'),
        unassign: manage && status === 'assigned',
        planVisit: manage && ['triaged', 'assigned', 'in_progress'].includes(status),
        start: attend && status === 'assigned',
        complete: attend && status === 'in_progress',
        recordResponse: manage && status === 'work_done' && row.tenantId !== null,
        close: manage && status === 'work_done' && row.tenantId === null,
        cancel: manage && (status === 'reported' || status === 'triaged'),
        addMedia: attend && open,
        addNote: attend,
        recordExpense: this.policy.can(staff, 'expense.record').allowed,
      },
    };
  }

  private async views(tx: Tx, rows: readonly JobRow[]): Promise<MaintenanceJobView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const facts = await tx.execute<{
      id: string;
      property_name: string;
      unit_code: string | null;
      tenant_name: string | null;
      attachments: number;
      person_name: string | null;
      artisan_name: string | null;
      cost: string | null;
    }>(sql`
      select j.id, p.name as property_name, u.code as unit_code, t.display_name as tenant_name,
             (select count(*)::int from maintenance_job_attachment a where a.company_id = j.company_id and a.job_id = j.id) as attachments,
             pe.name as person_name, ar.name as artisan_name,
             (select coalesce(sum(e.amount_minor), 0)::bigint from expense e
               where e.company_id = j.company_id and e.job_id = j.id
                 and not exists (select 1 from expense_reversal r where r.company_id = e.company_id and r.expense_id = e.id)) as cost
      from maintenance_job j
      join property p on p.company_id = j.company_id and p.id = j.property_id
      left join unit u on u.company_id = j.company_id and u.id = j.unit_id
      left join tenant t on t.company_id = j.company_id and t.id = j.tenant_id
      left join person pe on pe.id = j.assignee_person_id
      left join artisan ar on ar.company_id = j.company_id and ar.id = j.assignee_artisan_id
      where j.id = any(${`{${ids.join(',')}}`}::uuid[])`);
    const byId = new Map(facts.rows.map((f) => [f.id, f]));
    const now = this.clock.now();
    return rows.map((r) => {
      const f = byId.get(r.id);
      const status = r.status as MaintenanceJobStatus;
      const open = OPEN_MAINTENANCE_STATUSES.includes(status);
      const overdue: MaintenanceTargetKind | null =
        !open || !r.respondBy || !r.completeBy
          ? null
          : !r.respondedAt && r.respondBy < now
            ? 'respond'
            : !r.workDoneAt && r.completeBy < now
              ? 'complete'
              : null;
      return {
        id: r.id,
        ticket: formatTicketNumber(r.ticketNumber),
        ticketNumber: r.ticketNumber,
        status,
        statusLabel: MAINTENANCE_JOB_STATUS_LABELS[status],
        source: r.source as MaintenanceSource,
        description: r.description,
        property: { id: r.propertyId, name: f?.property_name ?? '' },
        unit: r.unitId ? { id: r.unitId, code: f?.unit_code ?? '' } : null,
        tenant: r.tenantId ? { id: r.tenantId, name: f?.tenant_name ?? '' } : null,
        leaseId: r.leaseId,
        conversationId: r.conversationId,
        attachmentCount: f?.attachments ?? 0,
        createdAt: r.createdAt,
        priority: r.priority as MaintenancePriority | null,
        category: r.category as MaintenanceCategory | null,
        emergencyFlag: r.emergencyFlag,
        assignee:
          r.assigneeKind === 'staff' && r.assigneePersonId
            ? { kind: 'staff', personId: r.assigneePersonId, name: f?.person_name ?? '' }
            : r.assigneeKind === ARTISAN_KIND && r.assigneeArtisanId
              ? {
                  kind: 'artisan',
                  artisanId: r.assigneeArtisanId,
                  name: f?.artisan_name ?? '',
                  response: r.artisanResponse as 'accepted' | 'declined' | null,
                }
              : null,
        targets:
          r.respondBy && r.completeBy
            ? {
                respondBy: r.respondBy,
                completeBy: r.completeBy,
                respondedAt: r.respondedAt,
                workDoneAt: r.workDoneAt,
                overdue,
              }
            : null,
        visitAt: r.visitAt,
        costMinor: Number(f?.cost ?? 0),
        closedAt: r.closedAt,
        updatedAt: r.updatedAt,
      };
    });
  }
}

const staffOf = (staff: StaffActor): JobActor => ({ kind: 'staff', personId: staff.personId });

/** The company's targets and auto-close days (decision 4 and 7), defaults applied. */
export const staffSettings = (company: { settings: unknown } | null) =>
  maintenanceSettingsOf(parseCompanySettings(company?.settings ?? {}));
