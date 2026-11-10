import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import { DomainError } from '@rent/domain/errors';
import {
  checkInspectionRooms,
  checkInspectionSubmittable,
  conditionWorsened,
  defaultInspectionRooms,
  type InspectionCondition,
  type InspectionKind,
  type InspectionRoom,
  type InspectionStatus,
} from '@rent/domain/maintenance';
import type { Actor } from '@rent/domain/policy';
import { UNIT_TYPES, type UnitType } from '@rent/domain/portfolio';
import { staffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import { maintenanceCheckConflict } from '../core/db-errors';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import {
  DocumentsService,
  INSPECTION_PHOTO_UPLOAD,
  type StagedMedia,
} from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';

type StaffActor = Extract<Actor, { kind: 'staff' }>;
type InspectionRow = typeof schema.inspection.$inferSelect;
type ItemRow = typeof schema.inspectionItem.$inferSelect;

/** The move-in report is rendered and sent for signature by the moveout module (plan 4.13). */
export const INSPECTION_RENDER_REPORT_JOB = 'inspection.render-report';

export interface InspectionPhotoView {
  readonly id: string;
  readonly contentType: string;
  readonly takenAt: Date;
}

export interface InspectionItemView {
  readonly id: string;
  readonly roomKey: string;
  readonly roomLabel: string;
  readonly itemKey: string;
  readonly itemLabel: string;
  readonly condition: InspectionCondition | null;
  readonly note: string | null;
  readonly photos: readonly InspectionPhotoView[];
  readonly moveIn: {
    readonly itemId: string;
    readonly condition: InspectionCondition | null;
    readonly note: string | null;
    readonly photos: readonly InspectionPhotoView[];
  } | null;
  readonly worsened: boolean;
}

export interface InspectionView {
  readonly id: string;
  readonly kind: InspectionKind;
  readonly status: InspectionStatus;
  readonly property: { readonly id: string; readonly name: string };
  readonly unit: { readonly id: string; readonly code: string };
  readonly leaseId: string | null;
  readonly tenant: { readonly id: string; readonly name: string } | null;
  readonly performedByName: string | null;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly corrects: { readonly id: string } | null;
  readonly correctedBy: { readonly id: string } | null;
  readonly moveInInspectionId: string | null;
  readonly itemCount: number;
  readonly itemsDone: number;
}

/**
 * The move-in report seen with an inspection: the moveout module, which signs it, supplies it
 * (registered at start, as tax registers its hooks with billing).
 */
export type MoveInReportReader = (tx: Tx, inspectionId: string) => Promise<unknown | null>;

const domainInvalid = (error: unknown): never => {
  if (error instanceof DomainError) {
    const code = error.code.replace(/\./g, '_');
    if (error.code === 'inspection.submitted') throw conflict(code, error.message);
    throw invalid(code, error.message);
  }
  throw maintenanceCheckConflict(error) ?? error;
};

/**
 * Inspections (MI-10; decision 10; plan 4.6): routine, move-in and move-out, room by room, from the
 * company's checklist for the unit type (or the default). Each item records a condition, a note
 * and photos stamped with the server's time. A submitted inspection is frozen (0041); a correction
 * is a new inspection that names it. A move-out inspection shows the move-in result beside each
 * item. Routine inspections are Growth; move-in and move-out are on every plan (decision 1).
 */
@Injectable()
export class InspectionsService {
  private moveInReports: MoveInReportReader | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  useMoveInReports(reader: MoveInReportReader): void {
    this.moveInReports = reader;
  }

  // Templates ----------------------------------------------------------------------------------

  async templates(actor: Actor | null) {
    const staff = this.reader(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx.select().from(schema.inspectionTemplate);
      return UNIT_TYPES.map((unitType) => {
        const own = rows.find((r) => r.unitType === unitType);
        return {
          unitType,
          rooms: own ? (own.rooms as InspectionRoom[]) : defaultInspectionRooms(unitType),
          customised: !!own,
          updatedAt: own?.updatedAt ?? null,
        };
      });
    });
  }

  async updateTemplate(actor: Actor | null, unitType: UnitType, rooms: readonly InspectionRoom[]) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'maintenance.manage');
    let checked: InspectionRoom[];
    try {
      checked = checkInspectionRooms(rooms);
    } catch (error) {
      return domainInvalid(error);
    }
    const now = this.clock.now();
    await withCompany(this.database, staffContext(staff), (tx) =>
      tx
        .insert(schema.inspectionTemplate)
        .values({
          companyId: staff.companyId,
          unitType,
          rooms: checked,
          updatedBy: staff.personId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.inspectionTemplate.companyId, schema.inspectionTemplate.unitType],
          set: { rooms: checked, updatedBy: staff.personId, updatedAt: now },
        }),
    );
    return (await this.templates(actor)).find((t) => t.unitType === unitType)!;
  }

  async resetTemplate(actor: Actor | null, unitType: UnitType) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'maintenance.manage');
    await withCompany(this.database, staffContext(staff), (tx) =>
      tx.delete(schema.inspectionTemplate).where(eq(schema.inspectionTemplate.unitType, unitType)),
    );
    return (await this.templates(actor)).find((t) => t.unitType === unitType)!;
  }

  // Inspections ----------------------------------------------------------------------------------

  async list(
    actor: Actor | null,
    filter: {
      unitId?: string;
      leaseId?: string;
      propertyId?: string;
      kind?: InspectionKind;
      status?: InspectionStatus;
    },
  ): Promise<InspectionView[]> {
    const staff = this.reader(actor);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const i = schema.inspection;
      const rows = await tx
        .select()
        .from(i)
        .where(
          and(
            filter.unitId ? eq(i.unitId, filter.unitId) : undefined,
            filter.leaseId ? eq(i.leaseId, filter.leaseId) : undefined,
            filter.propertyId ? eq(i.propertyId, filter.propertyId) : undefined,
            filter.kind ? eq(i.kind, filter.kind) : undefined,
            filter.status ? eq(i.status, filter.status) : undefined,
          ),
        )
        .orderBy(desc(i.startedAt))
        .limit(200);
      return this.views(tx, rows);
    });
  }

  async get(actor: Actor | null, inspectionId: string) {
    const staff = this.reader(actor);
    return withCompany(this.database, staffContext(staff), (tx) =>
      this.detail(tx, staff, inspectionId),
    );
  }

  /**
   * Starts an inspection from the unit type's checklist, in the caller's transaction or its own.
   * A move-out inspection finds the lease's move-in inspection and pairs each item with it.
   */
  async start(
    actor: Actor | null,
    input: {
      unitId: string;
      kind: InspectionKind;
      leaseId?: string | null;
      correctsInspectionId?: string | null;
    },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'inspection.perform');
    if (input.kind === 'routine') await this.entitlements.assert(staff.companyId, 'maintenance');
    const id = await this.write(staff, (tx) =>
      this.startIn(tx, staff.companyId, staff.personId, input),
    );
    return this.get(actor, id);
  }

  /** The inspection itself, written in the caller's transaction (the moveout module uses it). */
  async startIn(
    tx: Tx,
    companyId: string,
    personId: string | null,
    input: {
      unitId: string;
      kind: InspectionKind;
      leaseId?: string | null;
      correctsInspectionId?: string | null;
    },
  ): Promise<string> {
    const [unit] = await tx
      .select({
        id: schema.unit.id,
        propertyId: schema.unit.propertyId,
        unitType: schema.unit.unitType,
        bedrooms: schema.unit.bedrooms,
      })
      .from(schema.unit)
      .where(eq(schema.unit.id, input.unitId));
    if (!unit) throw notFound('Unit');
    let tenantId: string | null = null;
    if (input.leaseId) {
      const [lease] = await tx
        .select({ unitId: schema.lease.unitId, tenantId: schema.lease.tenantId })
        .from(schema.lease)
        .where(eq(schema.lease.id, input.leaseId));
      if (!lease || lease.unitId !== unit.id) throw notFound('Lease');
      tenantId = lease.tenantId;
    } else if (input.kind !== 'routine')
      throw invalid('lease_required', 'A move-in or move-out inspection is for a lease');
    if (input.correctsInspectionId) {
      const [old] = await tx
        .select()
        .from(schema.inspection)
        .where(eq(schema.inspection.id, input.correctsInspectionId));
      if (!old || old.unitId !== unit.id) throw notFound('Inspection');
      if (old.status !== 'submitted')
        throw conflict('inspection_open', 'Only a submitted inspection is corrected');
      if (old.kind !== input.kind || old.leaseId !== (input.leaseId ?? null))
        throw invalid('inspection_correction', 'A correction keeps the kind and lease it corrects');
    }
    let moveIn: InspectionRow | undefined;
    if (input.kind === 'move_out' && input.leaseId)
      moveIn = await this.latestMoveIn(tx, input.leaseId);
    const [own] = await tx
      .select({ rooms: schema.inspectionTemplate.rooms })
      .from(schema.inspectionTemplate)
      .where(eq(schema.inspectionTemplate.unitType, unit.unitType));
    const rooms = own
      ? (own.rooms as InspectionRoom[])
      : defaultInspectionRooms(unit.unitType as UnitType, unit.bedrooms);
    const now = this.clock.now();
    const [row] = await tx
      .insert(schema.inspection)
      .values({
        companyId,
        propertyId: unit.propertyId,
        unitId: unit.id,
        leaseId: input.leaseId ?? null,
        tenantId,
        kind: input.kind,
        unitType: unit.unitType,
        performedBy: personId,
        startedAt: now,
        correctsInspectionId: input.correctsInspectionId ?? null,
        moveInInspectionId: moveIn?.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const moveInItems = moveIn
      ? await tx
          .select()
          .from(schema.inspectionItem)
          .where(eq(schema.inspectionItem.inspectionId, moveIn.id))
      : [];
    let position = 0;
    const values = rooms.flatMap((r) =>
      r.items.map((item) => {
        position += 1;
        const pair = moveInItems.find((m) => m.roomKey === r.key && m.itemKey === item.key);
        return {
          companyId,
          propertyId: unit.propertyId,
          inspectionId: row!.id,
          position,
          roomKey: r.key,
          roomLabel: r.label,
          itemKey: item.key,
          itemLabel: item.label,
          moveInItemId: pair?.id ?? null,
          createdAt: now,
          updatedAt: now,
        };
      }),
    );
    if (values.length) await tx.insert(schema.inspectionItem).values(values);
    return row!.id;
  }

  async updateItem(
    actor: Actor | null,
    inspectionId: string,
    itemId: string,
    input: { condition?: InspectionCondition | null; note?: string | null },
  ): Promise<InspectionItemView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'inspection.perform');
    await this.write(staff, async (tx) => {
      const inspection = await this.row(tx, inspectionId, true);
      this.assertOpen(inspection);
      const item = await this.item(tx, inspectionId, itemId);
      await tx
        .update(schema.inspectionItem)
        .set({
          ...(input.condition !== undefined ? { condition: input.condition } : {}),
          ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
          updatedBy: staff.personId,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.inspectionItem.id, item.id));
    });
    return this.itemView(actor, inspectionId, itemId);
  }

  async createUpload(
    actor: Actor | null,
    declared: { contentType: string; sizeBytes: number; durationSeconds?: number | null },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'inspection.perform');
    return this.documents.createMediaUpload(
      { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' },
      staff.personId,
      INSPECTION_PHOTO_UPLOAD,
      declared,
    );
  }

  async addPhotos(
    actor: Actor | null,
    inspectionId: string,
    itemId: string,
    uploadIds: readonly string[],
  ): Promise<InspectionItemView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'inspection.perform');
    const media: StagedMedia[] = [];
    for (const id of new Set(uploadIds))
      media.push(
        await this.documents.stageMediaUpload(
          { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' },
          staff.personId,
          id,
          INSPECTION_PHOTO_UPLOAD,
        ),
      );
    await this.write(staff, async (tx) => {
      const inspection = await this.row(tx, inspectionId, true);
      this.assertOpen(inspection);
      const item = await this.item(tx, inspectionId, itemId);
      for (const m of media) {
        const documentId = await this.documents.recordStagedMedia(tx, m, 'inspection_photo');
        // The server's time, never the photo's own date (decision 10).
        await tx.insert(schema.inspectionPhoto).values({
          companyId: staff.companyId,
          propertyId: inspection.propertyId,
          inspectionId,
          itemId: item.id,
          documentId,
          addedBy: staff.personId,
          takenAt: this.clock.now(),
        });
      }
    });
    for (const m of media) await this.documents.discardStagedMedia(m);
    return this.itemView(actor, inspectionId, itemId);
  }

  /**
   * Submits: every item needs a condition; the inspection is then frozen. A move-in inspection
   * becomes the move-in report, rendered and sent for signature (TL-08, `inspection.render-report`).
   */
  async submit(actor: Actor | null, inspectionId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'inspection.perform');
    await this.write(staff, async (tx) => {
      const inspection = await this.row(tx, inspectionId, true);
      this.assertOpen(inspection);
      const items = await tx
        .select()
        .from(schema.inspectionItem)
        .where(eq(schema.inspectionItem.inspectionId, inspectionId));
      try {
        checkInspectionSubmittable(
          items.map((i) => ({
            roomKey: i.roomKey,
            itemKey: i.itemKey,
            condition: i.condition as InspectionCondition | null,
          })),
        );
      } catch (error) {
        domainInvalid(error);
      }
      const now = this.clock.now();
      await tx
        .update(schema.inspection)
        .set({ status: 'submitted', submittedAt: now, submittedBy: staff.personId, updatedAt: now })
        .where(eq(schema.inspection.id, inspectionId));
      if (inspection.kind === 'move_in')
        await enqueueOutbox(tx, {
          companyId: staff.companyId,
          type: INSPECTION_RENDER_REPORT_JOB,
          payload: { inspectionId, requestedBy: staff.personId },
          idempotencyKey: `${INSPECTION_RENDER_REPORT_JOB}:${inspectionId}`,
        });
    });
    return this.get(actor, inspectionId);
  }

  async photoUrl(actor: Actor | null, inspectionId: string, photoId: string) {
    const staff = this.reader(actor);
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select({ documentId: schema.inspectionPhoto.documentId })
        .from(schema.inspectionPhoto)
        .where(
          and(
            eq(schema.inspectionPhoto.id, photoId),
            eq(schema.inspectionPhoto.inspectionId, inspectionId),
          ),
        );
      return row?.documentId ?? null;
    });
    const url = documentId
      ? await this.documents.downloadUrl(staff.companyId, documentId, undefined, {
          viewer: staff.personId,
        })
      : null;
    if (!url) throw notFound('Photo');
    return { url, expiresAt: new Date(this.clock.now().getTime() + 300_000) };
  }

  // For the moveout module ----------------------------------------------------------------------

  /** The lease's latest submitted move-in inspection that nothing corrected. */
  async latestMoveIn(tx: Tx, leaseId: string): Promise<InspectionRow | undefined> {
    const rows = await tx
      .select()
      .from(schema.inspection)
      .where(
        and(
          eq(schema.inspection.leaseId, leaseId),
          eq(schema.inspection.kind, 'move_in'),
          eq(schema.inspection.status, 'submitted'),
          sql`not exists (select 1 from inspection c where c.company_id = ${schema.inspection.companyId}
                and c.corrects_inspection_id = ${schema.inspection.id} and c.status = 'submitted')`,
        ),
      )
      .orderBy(desc(schema.inspection.submittedAt))
      .limit(1);
    return rows[0];
  }

  /** An inspection's rows and photos (for the report and the settlement), in the caller's tx. */
  async contents(tx: Tx, inspectionId: string) {
    const inspection = await this.row(tx, inspectionId);
    const items = await tx
      .select()
      .from(schema.inspectionItem)
      .where(eq(schema.inspectionItem.inspectionId, inspectionId))
      .orderBy(asc(schema.inspectionItem.position));
    const photos = await tx
      .select({
        id: schema.inspectionPhoto.id,
        itemId: schema.inspectionPhoto.itemId,
        documentId: schema.inspectionPhoto.documentId,
        takenAt: schema.inspectionPhoto.takenAt,
        contentType: schema.document.contentType,
        sha256: schema.document.sha256,
      })
      .from(schema.inspectionPhoto)
      .innerJoin(
        schema.document,
        and(
          eq(schema.document.companyId, schema.inspectionPhoto.companyId),
          eq(schema.document.id, schema.inspectionPhoto.documentId),
        ),
      )
      .where(eq(schema.inspectionPhoto.inspectionId, inspectionId))
      .orderBy(asc(schema.inspectionPhoto.takenAt));
    return { inspection, items, photos };
  }

  // Internals ---------------------------------------------------------------------------------

  private reader(actor: Actor | null): StaffActor {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'inspection.read');
    return staff;
  }

  private assertOpen(inspection: InspectionRow) {
    if (inspection.status === 'submitted')
      throw conflict(
        'inspection_submitted',
        'This inspection was submitted and is frozen. Start a correction instead.',
      );
  }

  private async row(tx: Tx, inspectionId: string, lock = false): Promise<InspectionRow> {
    const query = tx.select().from(schema.inspection).where(eq(schema.inspection.id, inspectionId));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound('Inspection');
    return row;
  }

  private async item(tx: Tx, inspectionId: string, itemId: string): Promise<ItemRow> {
    const [item] = await tx
      .select()
      .from(schema.inspectionItem)
      .where(
        and(
          eq(schema.inspectionItem.id, itemId),
          eq(schema.inspectionItem.inspectionId, inspectionId),
        ),
      );
    if (!item) throw notFound('Item');
    return item;
  }

  private async write<T>(staff: StaffActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await withCompany(this.database, staffContext(staff), fn);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return domainInvalid(error);
    }
  }

  private async itemView(actor: Actor | null, inspectionId: string, itemId: string) {
    const detail = await this.get(actor, inspectionId);
    const item = detail.items.find((i) => i.id === itemId);
    if (!item) throw notFound('Item');
    return item;
  }

  private async detail(tx: Tx, staff: StaffActor, inspectionId: string) {
    const inspection = await this.row(tx, inspectionId);
    const [view] = await this.views(tx, [inspection]);
    const { items, photos } = await this.contents(tx, inspectionId);
    const pairedIds = items.flatMap((i) => (i.moveInItemId ? [i.moveInItemId] : []));
    const moveInItems = pairedIds.length
      ? await tx
          .select()
          .from(schema.inspectionItem)
          .where(inArray(schema.inspectionItem.id, pairedIds))
      : [];
    const moveInPhotos = inspection.moveInInspectionId
      ? (await this.contents(tx, inspection.moveInInspectionId)).photos
      : [];
    const photoView = (p: (typeof photos)[number]): InspectionPhotoView => ({
      id: p.id,
      contentType: p.contentType,
      takenAt: p.takenAt,
    });
    const perform = this.policy.can(staff, 'inspection.perform').allowed;
    const open = inspection.status === 'in_progress';
    const [corrected] = await tx
      .select({ id: schema.inspection.id })
      .from(schema.inspection)
      .where(eq(schema.inspection.correctsInspectionId, inspectionId));
    return {
      ...view!,
      items: items.map((i): InspectionItemView => {
        const pair = i.moveInItemId ? moveInItems.find((m) => m.id === i.moveInItemId) : undefined;
        const condition = i.condition as InspectionCondition | null;
        return {
          id: i.id,
          roomKey: i.roomKey,
          roomLabel: i.roomLabel,
          itemKey: i.itemKey,
          itemLabel: i.itemLabel,
          condition,
          note: i.note,
          photos: photos.filter((p) => p.itemId === i.id).map(photoView),
          moveIn: pair
            ? {
                itemId: pair.id,
                condition: pair.condition as InspectionCondition | null,
                note: pair.note,
                photos: moveInPhotos.filter((p) => p.itemId === pair.id).map(photoView),
              }
            : null,
          worsened:
            inspection.kind === 'move_out' && condition !== null
              ? conditionWorsened(
                  (pair?.condition as InspectionCondition | null) ?? null,
                  condition,
                )
              : false,
        };
      }),
      moveInReport:
        inspection.kind === 'move_in' && inspection.status === 'submitted' && this.moveInReports
          ? await this.moveInReports(tx, inspectionId)
          : null,
      actions: {
        edit: perform && open,
        submit: perform && open,
        correct: perform && !open && !corrected,
      },
    };
  }

  private async views(tx: Tx, rows: readonly InspectionRow[]): Promise<InspectionView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const facts = await tx.execute<{
      id: string;
      property_name: string;
      unit_code: string;
      tenant_name: string | null;
      performer: string | null;
      items: number;
      done: number;
      corrected_by: string | null;
    }>(sql`
      select i.id, p.name as property_name, u.code as unit_code, t.display_name as tenant_name,
             pe.name as performer,
             (select count(*)::int from inspection_item x where x.company_id = i.company_id and x.inspection_id = i.id) as items,
             (select count(*)::int from inspection_item x where x.company_id = i.company_id and x.inspection_id = i.id and x.condition is not null) as done,
             (select c.id from inspection c where c.company_id = i.company_id and c.corrects_inspection_id = i.id limit 1) as corrected_by
      from inspection i
      join property p on p.company_id = i.company_id and p.id = i.property_id
      join unit u on u.company_id = i.company_id and u.id = i.unit_id
      left join tenant t on t.company_id = i.company_id and t.id = i.tenant_id
      left join person pe on pe.id = i.performed_by
      where i.id = any(${`{${ids.join(',')}}`}::uuid[])`);
    const byId = new Map(facts.rows.map((f) => [f.id, f]));
    return rows.map((r) => {
      const f = byId.get(r.id);
      return {
        id: r.id,
        kind: r.kind as InspectionKind,
        status: r.status as InspectionStatus,
        property: { id: r.propertyId, name: f?.property_name ?? '' },
        unit: { id: r.unitId, code: f?.unit_code ?? '' },
        leaseId: r.leaseId,
        tenant: r.tenantId ? { id: r.tenantId, name: f?.tenant_name ?? '' } : null,
        performedByName: f?.performer ?? null,
        startedAt: r.startedAt,
        submittedAt: r.submittedAt,
        corrects: r.correctsInspectionId ? { id: r.correctsInspectionId } : null,
        correctedBy: f?.corrected_by ? { id: f.corrected_by } : null,
        moveInInspectionId: r.moveInInspectionId,
        itemCount: f?.items ?? 0,
        itemsDone: f?.done ?? 0,
      };
    });
  }
}
