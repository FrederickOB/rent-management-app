import { and, eq, schema, sql, withCompany, type Database } from '@rent/db';
import type { MaintenanceCategory, MaintenancePriority } from '@rent/domain/maintenance';
import type { Actor } from '@rent/domain/policy';
import type { StoragePort } from '@rent/integrations';
import type { ApprovalsService } from '../src/approvals';
import type { AppConfig } from '../src/core/config';
import type {
  ArtisansService,
  ExpensesService,
  InspectionsService,
  MaintenanceService,
} from '../src/maintenance';
import type { MoveInReportService, MoveOutService } from '../src/moveout';

/**
 * The M8 demo data (plan 4.14). The agency (Growth): jobs in every state, one emergency with its
 * alerts, one artisan job with its job sheet, one disputed completion, jobs with expenses, a move-in
 * report sent for signature, one move-out in progress with a deduction and its photo, and one early
 * end settled through the new flow with its refund paid, each on a tenancy of its own. The Starter
 * landlord: one app repair forwarded (its only tenancy is the tenant app's demo, so it gets no
 * move-out). Everything goes through the real services;
 * each step looks for what it would make first, so a second run makes nothing new.
 */
export interface MaintenanceSeedDeps {
  readonly database: Database;
  readonly config: AppConfig;
  readonly storage: StoragePort;
  readonly maintenance: MaintenanceService;
  readonly artisans: ArtisansService;
  readonly expenses: ExpensesService;
  readonly inspections: InspectionsService;
  readonly reports: MoveInReportService;
  readonly moveOuts: MoveOutService;
  readonly approvals: ApprovalsService;
  readonly agency: string;
  readonly landlord: string;
  readonly actor: (companyId: string, signIn: string) => Promise<Actor>;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 7)]);
const PDF = Buffer.from('%PDF-1.4\n% demo receipt\n');

export async function ensureMaintenance(deps: MaintenanceSeedDeps): Promise<string[]> {
  const { agency, landlord } = deps;
  const manager = await deps.actor(agency, 'manager.one@demo.invalid');
  const managerTwo = await deps.actor(agency, 'manager.two@demo.invalid');
  const accountant = await deps.actor(agency, 'accountant@demo.invalid');
  const kojo = await deps.actor(agency, '+233200000011');
  const out: string[] = [];

  const ids = await withCompany(
    deps.database,
    { companyId: agency, actorKind: 'system' },
    async (tx) => {
      const units = await tx.execute<{ code: string; id: string; property_id: string }>(
        sql`select code, id, property_id from unit where code in ('ACC-LEG-B1-01', 'ACC-LEG-B2-01', 'ACC-LEG-B2-03', 'ACC-LEG-B1-05', 'ACC-LEG-B1-06', 'ACC-OSU-G-01')`,
      );
      const leases = await tx.execute<{ code: string; id: string }>(
        sql`select u.code, l.id from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
          where l.status in ('active', 'ending', 'holding_over', 'terminated', 'ended')
            and u.code in ('ACC-LEG-B1-01', 'ACC-LEG-B1-05', 'ACC-LEG-B1-06')`,
      );
      return {
        unit: new Map(units.rows.map((u) => [u.code, u])),
        lease: new Map(leases.rows.map((l) => [l.code, l.id])),
      };
    },
  );
  const unit = (code: string) => ids.unit.get(code)!;
  const upload = async (
    create: () => Promise<{ uploadId: string; fields: Record<string, string> }>,
    body: Buffer,
    contentType: string,
  ) => {
    const u = await create();
    await deps.storage.put({
      bucket: deps.config.S3_BUCKET_FILES,
      key: u.fields.key!,
      body,
      contentType,
    });
    return u.uploadId;
  };
  const photo = (who: Actor = manager) =>
    upload(
      () =>
        deps.maintenance.createUpload(who, { contentType: 'image/jpeg', sizeBytes: JPEG.length }),
      JPEG,
      'image/jpeg',
    );

  // Jobs, one per state, by description (the seed's own key) -------------------------------------
  const existing = async (description: string) =>
    withCompany(deps.database, { companyId: agency, actorKind: 'system' }, async (tx) => {
      const [row] = await tx
        .select({ id: schema.maintenanceJob.id })
        .from(schema.maintenanceJob)
        .where(eq(schema.maintenanceJob.description, description));
      return row?.id ?? null;
    });
  const log = async (
    description: string,
    unitCode: string | null,
    category: MaintenanceCategory | null,
    priority: MaintenancePriority | null,
  ) => {
    const found = await existing(description);
    if (found) return { id: found, created: false };
    const property = unitCode ? unit(unitCode).property_id : unit('ACC-LEG-B1-01').property_id;
    const job = await deps.maintenance.logRepair(manager, {
      propertyId: property,
      unitId: unitCode ? unit(unitCode).id : null,
      description,
      category,
      priority,
      uploadIds: [await photo()],
      messageIds: [],
    });
    return { id: job.id, created: true };
  };

  await log('The bathroom light flickers (demo)', 'ACC-LEG-B2-03', null, null);
  await log('Gate lock is stiff (demo)', null, 'carpentry', 'routine');
  const cancelled = await log(
    'Reported twice: window latch (demo)',
    'ACC-LEG-B2-01',
    'carpentry',
    'routine',
  );
  if (cancelled.created) await deps.maintenance.cancel(manager, cancelled.id, 'A duplicate report');

  const emergency = await log(
    'Water pouring through the ceiling (demo)',
    'ACC-LEG-B1-01',
    'plumbing',
    'emergency',
  );
  if (emergency.created) {
    await deps.maintenance.emergencyAlert(agency, emergency.id);
    await deps.maintenance.assign(manager, emergency.id, {
      assignee: { kind: 'staff', personId: (kojo as { personId: string }).personId },
    });
    await deps.maintenance.start(kojo, emergency.id, {
      uploadIds: [],
      beforePhotoReason: 'Emergency: no time',
    });
  }

  const disputed = await log(
    'Kitchen tap still dripping (demo)',
    'ACC-LEG-B2-01',
    'plumbing',
    'urgent',
  );
  if (disputed.created) {
    await deps.maintenance.assign(manager, disputed.id, {
      assignee: { kind: 'staff', personId: (kojo as { personId: string }).personId },
    });
    await deps.maintenance.start(kojo, disputed.id, { uploadIds: [await photo(kojo)] });
    await deps.maintenance.complete(kojo, disputed.id, {
      uploadIds: [await photo(kojo)],
      completionNote: 'Replaced the washer',
    });
    await deps.maintenance.recordResponse(manager, disputed.id, {
      response: 'disputed',
      reason: 'It still drips at night',
    });
  }

  const done = await log(
    'Repaint the hall after damp (demo)',
    'ACC-LEG-B2-03',
    'painting',
    'routine',
  );
  if (done.created) {
    await deps.maintenance.assign(manager, done.id, {
      assignee: { kind: 'staff', personId: (kojo as { personId: string }).personId },
    });
    await deps.maintenance.start(kojo, done.id, { uploadIds: [await photo(kojo)] });
    await deps.maintenance.complete(kojo, done.id, {
      uploadIds: [await photo(kojo)],
      completionNote: 'Two coats on the hall wall',
    });
  }
  const closed = await log('Blocked drain in the compound (demo)', null, 'plumbing', 'urgent');
  if (closed.created) {
    await deps.maintenance.assign(manager, closed.id, {
      assignee: { kind: 'staff', personId: (kojo as { personId: string }).personId },
    });
    await deps.maintenance.start(kojo, closed.id, { uploadIds: [await photo(kojo)] });
    await deps.maintenance.complete(kojo, closed.id, {
      uploadIds: [await photo(kojo)],
      completionNote: 'Cleared and flushed',
    });
    await deps.maintenance.close(manager, closed.id, 'Checked on the walk-round');
    for (const [supplier, amount, paidBy] of [
      ['Ato Drains (demo)', 45_000, 'unpaid'],
      ['Accra Hardware (demo)', 12_500, 'owner'],
    ] as const)
      await deps.expenses.record(accountant, {
        propertyId: unit('ACC-LEG-B1-01').property_id,
        category: 'repairs',
        supplierName: supplier,
        amountMinor: amount,
        expenseDate: new Date().toISOString().slice(0, 10),
        paidBy,
        jobId: closed.id,
        receiptUploadId: await upload(
          () =>
            deps.expenses.createUpload(accountant, {
              contentType: 'application/pdf',
              sizeBytes: PDF.length,
            }),
          PDF,
          'application/pdf',
        ),
      });
  }

  // An artisan and their job sheet (decision 6) --------------------------------------------------
  const artisans = await deps.artisans.list(manager, {});
  const artisan =
    artisans.find((a) => a.name === 'Kwabena Plumbing (demo)') ??
    (await deps.artisans.create(manager, {
      name: 'Kwabena Plumbing (demo)',
      phone: '+233200000071',
      trades: ['plumbing', 'borehole'],
      consent: { whatsapp: true, sms: true },
    }));
  const sheet = await log(
    'Borehole pump not starting (demo)',
    'ACC-OSU-G-01',
    'borehole',
    'urgent',
  );
  if (sheet.created)
    await deps.maintenance.assign(managerTwo, sheet.id, {
      assignee: { kind: 'artisan', artisanId: artisan.id },
    });
  out.push(`  The board: 9 demo jobs in every state; ${artisan.name} has the borehole job sheet.`);

  // The move-in report on Kwame's lease (TL-08) ----------------------------------------------------
  const kwame = ids.lease.get('ACC-LEG-B1-01');
  if (kwame) {
    const inspections = await deps.inspections.list(manager, { leaseId: kwame, kind: 'move_in' });
    if (inspections.length === 0) {
      const started = await deps.inspections.start(manager, {
        unitId: unit('ACC-LEG-B1-01').id,
        kind: 'move_in',
        leaseId: kwame,
      });
      for (const item of started.items)
        await deps.inspections.updateItem(manager, started.id, item.id, {
          condition: item.itemKey === 'walls' ? 'fair' : 'good',
        });
      await deps.inspections.submit(manager, started.id);
      await deps.reports.render(agency, started.id, (manager as { personId: string }).personId);
    }
    out.push('  The move-in report for ACC-LEG-B1-01 is out for signature.');
  }

  // A move-out in progress, with a deduction and its photo (MI-11) ---------------------------------
  const akua = ids.lease.get('ACC-LEG-B1-05');
  if (akua && (await deps.moveOuts.list(manager, { leaseId: akua })).length === 0) {
    const planned = await deps.moveOuts.plan(manager, akua, {
      plannedDate: new Date().toISOString().slice(0, 10),
      reason: 'end_of_term',
    });
    const withInspection = await deps.moveOuts.startInspection(manager, planned.id);
    const inspection = await deps.inspections.get(manager, withInspection.inspectionId!);
    const item = inspection.items[0]!;
    const photoId = (
      await deps.inspections.addPhotos(manager, inspection.id, item.id, [
        await upload(
          () =>
            deps.inspections.createUpload(manager, {
              contentType: 'image/jpeg',
              sizeBytes: JPEG.length,
            }),
          JPEG,
          'image/jpeg',
        ),
      ])
    ).photos[0]!.id;
    await deps.inspections.updateItem(manager, inspection.id, item.id, {
      condition: 'damaged',
      note: 'Hole in the wall by the door',
    });
    const held = await withCompany(
      deps.database,
      { companyId: agency, actorKind: 'system' },
      async (tx) =>
        0 -
        Number(
          (
            await tx.execute<{ n: string }>(
              sql`select coalesce(sum(amount_minor), 0)::bigint as n from journal_line where account_code = '2100' and lease_id = ${akua}`,
            )
          ).rows[0]!.n,
        ),
    );
    if (held > 0) {
      await deps.moveOuts.addDeduction(manager, planned.id, {
        kind: 'damage',
        amountMinor: Math.min(40_000, held),
        reason: 'Plaster and paint the wall by the door',
        inspectionItemIds: [item.id],
        photoIds: [photoId],
      });
      out.push('  A move-out drafted on ACC-LEG-B1-05, with a deduction and its photo.');
    } else out.push('  A move-out inspected on ACC-LEG-B1-05 (no deposit held, so no deduction).');
  }

  // An early end settled through the new flow, its refund paid -------------------------------------
  const settle = async (
    actor: Actor,
    approver: Actor,
    companyId: string,
    leaseId: string,
    label: string,
  ) => {
    const existingOut = await deps.moveOuts.list(actor, { leaseId });
    if (existingOut.length > 0) return;
    const planned = await deps.moveOuts.plan(actor, leaseId, {
      plannedDate: new Date().toISOString().slice(0, 10),
      reason: 'tenant_notice',
    });
    const submitted = await deps.moveOuts.submit(actor, planned.id);
    const requestId = submitted.approval!.request.id;
    try {
      await deps.approvals.decide(approver, requestId, { decision: 'approve' });
    } catch {
      // A sole landlord confirms after the cooling-off (OQ-29); the move-out waits for it.
      out.push(`  ${label}: the settlement waits for the cooling-off (OQ-29).`);
      return;
    }
    const approved = await deps.moveOuts.get(actor, planned.id);
    if (approved.status === 'approved' && (approved.statement?.refundMinor ?? 0) > 0) {
      const proof = await upload(
        () =>
          deps.moveOuts.createRefundUpload(approver, {
            contentType: 'application/pdf',
            sizeBytes: PDF.length,
          }),
        PDF,
        'application/pdf',
      );
      await deps.moveOuts.recordRefundPaid(approver, planned.id, {
        paidOn: new Date().toISOString().slice(0, 10),
        paidFrom: 'owner_account',
        reference: 'DEMO-REFUND',
        proofUploadId: proof,
      });
    }
    const final = await deps.moveOuts.get(actor, planned.id);
    out.push(`  ${label}: settled through the move-out flow (${final.statusLabel}).`);
  };
  const adwoa = ids.lease.get('ACC-LEG-B1-06');
  if (adwoa) await settle(manager, accountant, agency, adwoa, 'An early end on ACC-LEG-B1-06');

  // The Starter landlord: a full deposit refund, and an app repair forwarded ----------------------
  const tema = await withCompany(
    deps.database,
    { companyId: landlord, actorKind: 'system' },
    async (tx) => {
      const [row] = await tx
        .select({ id: schema.lease.id, tenantId: schema.lease.tenantId })
        .from(schema.lease)
        .innerJoin(
          schema.unit,
          and(
            eq(schema.unit.companyId, schema.lease.companyId),
            eq(schema.unit.id, schema.lease.unitId),
          ),
        )
        .where(
          and(
            eq(schema.unit.code, 'TEM-EST-B1-01'),
            sql`${schema.lease.status} in ('active', 'ending', 'holding_over', 'terminated', 'ended')`,
          ),
        );
      return row ?? null;
    },
  );
  if (tema) {
    const person = await withCompany(
      deps.database,
      { companyId: landlord, actorKind: 'system' },
      async (tx) => {
        const [t] = await tx
          .select({ personId: schema.tenant.personId })
          .from(schema.tenant)
          .where(eq(schema.tenant.id, tema.tenantId));
        return t?.personId ?? null;
      },
    );
    if (person)
      await deps.maintenance
        .tenantReport(landlord, {
          leaseId: tema.id,
          tenantId: tema.tenantId,
          personId: person,
          clientId: '0195f0a2-0000-7000-8000-00000000d3e0',
          category: 'electrical',
          description: 'The outside light has stopped working (demo)',
          emergency: false,
          media: [],
        })
        .catch(() => undefined);
    out.push('  The Starter landlord: an app repair forwarded by email and SMS.');
  }
  return out;
}
