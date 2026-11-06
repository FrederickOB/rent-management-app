import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
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
import { DomainError } from '@rent/domain/errors';
import { scopeOf, taskAssigneeOrder, type Actor, type StaffRole } from '@rent/domain/policy';
import type { CompanyKind } from '@rent/domain/policy';
import {
  checkTaskNote,
  checkTaskTransition,
  TASK_KIND_LABELS,
  type TaskKind,
  type TaskStatus,
} from '@rent/domain/tasks';
import type { Clock } from '../core/clock';
import { AppError, conflict, forbidden, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';

type StaffActor = Extract<Actor, { kind: 'staff' }>;
type TaskRow = typeof schema.task.$inferSelect;

export interface TaskView {
  readonly id: string;
  readonly kind: TaskKind;
  readonly kindLabel: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly property: { readonly id: string; readonly name: string };
  readonly unitCode: string | null;
  readonly tenantName: string | null;
  readonly relatedType: 'notice';
  readonly relatedId: string;
  readonly notice: {
    readonly id: string;
    readonly number: string | null;
    readonly typeLabel: string;
  } | null;
  readonly assignee: { readonly personId: string; readonly name: string } | null;
  readonly dueAt: Date;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly completedByName: string | null;
  readonly cancelledAt: Date | null;
  readonly mayComplete: boolean;
  readonly mayCancel: boolean;
}

export interface NewTask {
  readonly companyId: string;
  readonly propertyId: string;
  readonly unitId: string | null;
  readonly tenantId: string | null;
  readonly kind: TaskKind;
  readonly title: string;
  readonly noticeId: string;
  readonly recipientId: string | null;
  readonly assigneePersonId: string | null;
  readonly dueAt: Date;
  /** Makes the task once however often the job that asks for it runs. */
  readonly dedupeKey: string;
  readonly createdBy: string | null;
}

/** How a module names the record a task is about, for the task lists (tasks never read it). */
export type RelatedDescriber = (
  tx: Tx,
  ids: readonly string[],
) => Promise<Map<string, { readonly number: string | null; readonly typeLabel: string }>>;

const staffOf = (actor: Actor | null): StaffActor => {
  if (!actor || actor.kind !== 'staff') throw forbidden();
  return actor;
};

const domainConflict = (error: unknown): never => {
  if (error instanceof DomainError) throw conflict(error.code.replace(/\./g, '_'), error.message);
  throw error;
};

/**
 * Staff tasks (CF-06; M7 plan 4.1, layer 2): an assignee, a due time and a related record.
 * Notices create them (in-person reminders, posting on the premises, physical service). A task goes
 * to the property's caretaker, or its manager when it has none. Caretakers see the tasks of their
 * properties (Row Level Security) and complete their own; managers and admins any in their scope.
 * Every change is audited by the database (0037).
 */
@Injectable()
export class TasksService {
  private readonly describers = new Map<string, RelatedDescriber>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** A module that makes tasks names its records for the lists (the notices module). */
  useRelated(type: 'notice', describer: RelatedDescriber): void {
    this.describers.set(type, describer);
  }

  /**
   * Who a property's task goes to (plan section 3): its caretaker, else its manager, else an agency
   * admin or the landlord, among active members whose scope covers the property.
   */
  async assigneeFor(tx: Tx, companyId: string, propertyId: string): Promise<string | null> {
    const members = await this.coveringMembers(tx, companyId, propertyId);
    return (
      members.reduce<{ personId: string; order: number } | null>(
        (best, m) => (best && best.order <= m.order ? best : m),
        null,
      )?.personId ?? null
    );
  }

  /**
   * Who manages a property, for staff alerts about it (review S8): its property managers in scope;
   * with none, the agency's admins; for a landlord, the owner users.
   */
  async managersFor(tx: Tx, companyId: string, propertyId: string): Promise<string[]> {
    const members = (await this.coveringMembers(tx, companyId, propertyId)).filter(
      (m) => m.order > 0,
    );
    const first = Math.min(...members.map((m) => m.order));
    return [...new Set(members.filter((m) => m.order === first).map((m) => m.personId))];
  }

  /** Active members whose scope covers the property, with their task order (taskAssigneeOrder). */
  private async coveringMembers(
    tx: Tx,
    companyId: string,
    propertyId: string,
  ): Promise<{ personId: string; order: number }[]> {
    const [company] = await tx
      .select({ kind: schema.company.kind })
      .from(schema.company)
      .where(eq(schema.company.id, companyId));
    if (!company || company.kind === 'platform') return [];
    const members = await tx
      .select({
        personId: schema.membership.personId,
        role: schema.membership.role,
        scope: schema.membership.scope,
        createdAt: schema.membership.createdAt,
      })
      .from(schema.membership)
      .where(
        and(eq(schema.membership.companyId, companyId), eq(schema.membership.status, 'active')),
      )
      .orderBy(asc(schema.membership.createdAt));
    const out: { personId: string; order: number }[] = [];
    for (const m of members) {
      const order = taskAssigneeOrder(m.role as StaffRole, company.kind as CompanyKind);
      if (order === null) continue;
      const scope = scopeOf({
        kind: 'staff',
        personId: m.personId,
        companyId,
        companyKind: company.kind as CompanyKind,
        membershipId: '',
        role: m.role as StaffRole,
        nominatedApprover: false,
        scope: (m.scope ?? {}) as { owners?: string[]; properties?: string[] },
        authMethod: 'password_totp',
      });
      if (scope) {
        const covered = await tx.execute<{ scope: string[] | null }>(
          sql`select app.resolve_property_scope(${`{${scope.ownerIds.join(',')}}`}::uuid[],
                ${`{${scope.propertyIds.join(',')}}`}::uuid[])::text[] as scope`,
        );
        if (!(covered.rows[0]?.scope ?? []).includes(propertyId)) continue;
      }
      out.push({ personId: m.personId, order });
    }
    return out;
  }

  /** Makes a task in the caller's transaction, once per dedupe key. */
  async create(
    tx: Tx,
    input: NewTask,
  ): Promise<{ readonly taskId: string; readonly created: boolean }> {
    const now = this.clock.now();
    const inserted = await tx
      .insert(schema.task)
      .values({
        companyId: input.companyId,
        propertyId: input.propertyId,
        unitId: input.unitId,
        tenantId: input.tenantId,
        kind: input.kind,
        title: input.title.slice(0, 200),
        relatedType: 'notice',
        noticeId: input.noticeId,
        recipientId: input.recipientId,
        assigneePersonId: input.assigneePersonId,
        dueAt: input.dueAt,
        dedupeKey: input.dedupeKey,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [schema.task.companyId, schema.task.dedupeKey] })
      .returning({ id: schema.task.id });
    if (inserted[0]) return { taskId: inserted[0].id, created: true };
    const [existing] = await tx
      .select({ id: schema.task.id })
      .from(schema.task)
      .where(eq(schema.task.dedupeKey, input.dedupeKey));
    if (!existing) throw new Error('task not recorded');
    return { taskId: existing.id, created: false };
  }

  /**
   * Closes a notice's open tasks of some kinds, in the caller's transaction: done when the work
   * was recorded (service), cancelled when it is no longer needed (the tenant acknowledged, the
   * notice closed). `recipientIds` narrows it to one party's tasks (its recipients'), with the
   * notice-wide ones.
   */
  async closeOpen(
    tx: Tx,
    where: {
      readonly noticeId: string;
      readonly kinds: readonly TaskKind[];
      readonly recipientIds?: readonly string[] | null;
    },
    status: 'done' | 'cancelled',
    note: string,
    by: string | null,
  ): Promise<number> {
    const now = this.clock.now();
    const rows = await tx
      .update(schema.task)
      .set(
        status === 'done'
          ? { status: 'done', completedAt: now, completedBy: by, note, updatedAt: now }
          : { status: 'cancelled', cancelledAt: now, cancelledBy: by, note, updatedAt: now },
      )
      .where(
        and(
          eq(schema.task.noticeId, where.noticeId),
          eq(schema.task.status, 'open'),
          inArray(schema.task.kind, [...where.kinds]),
          where.recipientIds
            ? or(
                isNull(schema.task.recipientId),
                where.recipientIds.length
                  ? inArray(schema.task.recipientId, [...where.recipientIds])
                  : undefined,
              )
            : undefined,
        ),
      )
      .returning({ id: schema.task.id });
    return rows.length;
  }

  /** Whether a notice has an open task of this kind (review S7: no duplicate service work). */
  async hasOpen(tx: Tx, noticeId: string, kind: TaskKind): Promise<boolean> {
    const [row] = await tx
      .select({ id: schema.task.id })
      .from(schema.task)
      .where(
        and(
          eq(schema.task.noticeId, noticeId),
          eq(schema.task.kind, kind),
          eq(schema.task.status, 'open'),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** A notice's tasks, in the caller's (staff) transaction. */
  async forNotice(tx: Tx, actor: Actor, noticeId: string): Promise<TaskView[]> {
    const rows = await tx
      .select()
      .from(schema.task)
      .where(eq(schema.task.noticeId, noticeId))
      .orderBy(asc(schema.task.createdAt));
    return this.views(tx, actor, rows);
  }

  // Staff ------------------------------------------------------------------------------------------

  async list(
    actor: Actor | null,
    filter: { mine?: boolean; status?: TaskStatus; kind?: TaskKind; propertyId?: string },
  ): Promise<TaskView[]> {
    const staff = staffOf(actor);
    this.policy.assert(staff, 'tasks.read');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const t = schema.task;
      const rows = await tx
        .select()
        .from(t)
        .where(
          and(
            filter.mine ? eq(t.assigneePersonId, staff.personId) : undefined,
            filter.status ? eq(t.status, filter.status) : undefined,
            filter.kind ? eq(t.kind, filter.kind) : undefined,
            filter.propertyId ? eq(t.propertyId, filter.propertyId) : undefined,
          ),
        )
        .orderBy(sql`case when ${t.status} = 'open' then 0 else 1 end`, asc(t.dueAt))
        .limit(500);
      return this.views(tx, staff, rows);
    });
  }

  async get(actor: Actor | null, taskId: string): Promise<TaskView> {
    const staff = staffOf(actor);
    this.policy.assert(staff, 'tasks.read');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await this.row(tx, taskId);
      return (await this.views(tx, staff, [row]))[0]!;
    });
  }

  async complete(actor: Actor | null, taskId: string, note?: string | null): Promise<TaskView> {
    return this.close(actor, taskId, 'done', note ?? null, false);
  }

  async cancel(actor: Actor | null, taskId: string, note: string): Promise<TaskView> {
    return this.close(actor, taskId, 'cancelled', note, true);
  }

  async note(actor: Actor | null, taskId: string, note: string): Promise<TaskView> {
    const staff = staffOf(actor);
    this.policy.assert(staff, 'tasks.read');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await this.row(tx, taskId, true);
      this.policy.assert(staff, 'tasks.complete', {
        kind: 'task',
        assigneePersonId: row.assigneePersonId,
      });
      if (row.status !== 'open') throw conflict('task_closed', 'The task is closed');
      let text: string | null;
      try {
        text = checkTaskNote(note, true);
      } catch (error) {
        throw new AppError(400, 'task_note_invalid', (error as Error).message);
      }
      await tx
        .update(schema.task)
        .set({ note: text, updatedAt: this.clock.now() })
        .where(eq(schema.task.id, taskId));
      return (await this.views(tx, staff, [await this.row(tx, taskId)]))[0]!;
    });
  }

  private async close(
    actor: Actor | null,
    taskId: string,
    to: 'done' | 'cancelled',
    note: string | null,
    noteRequired: boolean,
  ): Promise<TaskView> {
    const staff = staffOf(actor);
    this.policy.assert(staff, 'tasks.read');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await this.row(tx, taskId, true);
      this.policy.assert(staff, 'tasks.complete', {
        kind: 'task',
        assigneePersonId: row.assigneePersonId,
      });
      // A caretaker may complete their own task but never cancel one (CF-06).
      if (to === 'cancelled') this.policy.assert(staff, 'tasks.manage');
      try {
        checkTaskTransition(row.status as TaskStatus, to);
      } catch (error) {
        domainConflict(error);
      }
      let text: string | null;
      try {
        text = checkTaskNote(note, noteRequired);
      } catch (error) {
        throw new AppError(400, 'task_note_invalid', (error as Error).message);
      }
      const now = this.clock.now();
      await tx
        .update(schema.task)
        .set(
          to === 'done'
            ? {
                status: 'done',
                completedAt: now,
                completedBy: staff.personId,
                note: text ?? row.note,
                updatedAt: now,
              }
            : {
                status: 'cancelled',
                cancelledAt: now,
                cancelledBy: staff.personId,
                note: text,
                updatedAt: now,
              },
        )
        .where(eq(schema.task.id, taskId));
      return (await this.views(tx, staff, [await this.row(tx, taskId)]))[0]!;
    });
  }

  private async row(tx: Tx, taskId: string, lock = false): Promise<TaskRow> {
    const query = tx.select().from(schema.task).where(eq(schema.task.id, taskId));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound('Task');
    return row;
  }

  private async views(tx: Tx, actor: Actor, rows: readonly TaskRow[]): Promise<TaskView[]> {
    if (rows.length === 0) return [];
    const ids = (pick: (r: TaskRow) => string | null) => [
      ...new Set(rows.map(pick).filter((v): v is string => v !== null)),
    ];
    const properties = await tx
      .select({ id: schema.property.id, name: schema.property.name })
      .from(schema.property)
      .where(
        inArray(
          schema.property.id,
          ids((r) => r.propertyId),
        ),
      );
    const unitIds = ids((r) => r.unitId);
    const units = unitIds.length
      ? await tx
          .select({ id: schema.unit.id, code: schema.unit.code })
          .from(schema.unit)
          .where(inArray(schema.unit.id, unitIds))
      : [];
    const tenantIds = ids((r) => r.tenantId);
    const tenants = tenantIds.length
      ? await tx
          .select({ id: schema.tenant.id, name: schema.tenant.displayName })
          .from(schema.tenant)
          .where(inArray(schema.tenant.id, tenantIds))
      : [];
    const personIds = [...ids((r) => r.assigneePersonId), ...ids((r) => r.completedBy)];
    const people = personIds.length
      ? await tx
          .select({ id: schema.person.id, name: schema.person.name })
          .from(schema.person)
          .where(inArray(schema.person.id, personIds))
      : [];
    const noticeIds = ids((r) => r.noticeId);
    const describer = this.describers.get('notice');
    const notices = describer && noticeIds.length ? await describer(tx, noticeIds) : new Map();
    const name = (id: string | null) =>
      id ? (people.find((p) => p.id === id)?.name ?? null) : null;
    return rows.map((r) => {
      const related = r.noticeId ? notices.get(r.noticeId) : undefined;
      return {
        id: r.id,
        kind: r.kind as TaskKind,
        kindLabel: TASK_KIND_LABELS[r.kind as TaskKind],
        title: r.title,
        status: r.status as TaskStatus,
        property: {
          id: r.propertyId,
          name: properties.find((p) => p.id === r.propertyId)?.name ?? '',
        },
        unitCode: r.unitId ? (units.find((u) => u.id === r.unitId)?.code ?? null) : null,
        tenantName: r.tenantId ? (tenants.find((t) => t.id === r.tenantId)?.name ?? null) : null,
        relatedType: 'notice',
        relatedId: r.noticeId!,
        notice: r.noticeId && related ? { id: r.noticeId, ...related } : null,
        assignee: r.assigneePersonId
          ? { personId: r.assigneePersonId, name: name(r.assigneePersonId) ?? '' }
          : null,
        dueAt: r.dueAt,
        note: r.note,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        completedByName: name(r.completedBy),
        cancelledAt: r.cancelledAt,
        mayComplete:
          r.status === 'open' &&
          this.policy.can(actor, 'tasks.complete', {
            kind: 'task',
            assigneePersonId: r.assigneePersonId,
          }).allowed,
        // Review C2: cancelling needs tasks.manage (managers, admins and landlords).
        mayCancel: r.status === 'open' && this.policy.can(actor, 'tasks.manage').allowed,
      };
    });
  }
}
