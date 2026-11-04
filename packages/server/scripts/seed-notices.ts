import { and, asc, eq, inArray, schema, sql, withCompany, type Database } from '@rent/db';
import { PdfRenderer } from '@rent/documents/render';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { CURRENT_NOTICE_CONSENT } from '@rent/domain/esign';
import { CURRENT_QUIT_ACK, type NoticeType } from '@rent/domain/notices';
import type { Actor } from '@rent/domain/policy';
import { InMemoryEmail, InMemorySms, type StoragePort } from '@rent/integrations';
import type { ApprovalsService } from '../src/approvals';
import type { AuditService } from '../src/audit';
import type { Clock } from '../src/core/clock';
import type { AppConfig } from '../src/core/config';
import { DOCUMENT_RENDERED_EVENT, type DocumentsService } from '../src/documents';
import {
  NOTICE_SIGNING_EVENT,
  SIGNING_FINALISE_JOB,
  SigningPageService,
  type EsignService,
} from '../src/esign';
import type {
  NoticeAcknowledgementsService,
  NoticesService,
  NoticeTrackingService,
} from '../src/notices';
import { NOTICE_ESCALATE_JOB } from '../src/notices';
import type { LeasesService, TenantsService } from '../src/tenancy';

/**
 * The M7 demo data (plan 4.13), for the agency on Growth (Abokobi Homes, also on Growth, has not
 * accepted the OQ-16 statement, and the Starter landlord has no notices):
 * - the agency's OQ-16 acknowledgement;
 * - a notice to quit to the tenant 95 days in arrears (ACC-LEG-B2-02), issued six days ago on two
 *   people's approval, posted on the premises, unsigned, escalated with its service pack, its
 *   outcome still to record;
 * - a rent demand to the tenant 45 days in arrears, acknowledged;
 * - a breach notice to the commercial tenant, acknowledged by one of its two signatories;
 * - a building-wide fire-safety notice at ACC-OSU, partly acknowledged;
 * - a rent review corrected by a later one;
 * - one Rent Officer assessment, and a paper lease with no electronic-service clause;
 * - the caretaker Kojo's open tasks on ACC-LEG.
 *
 * Notices go through the real services: approval, issue, the frozen PDF (rendered here), the links,
 * the ladder on a clock moved back and forward, acknowledgement on the signing page with a code
 * read from an in-memory SMS port (nothing is sent), and the service pack. Each step looks for
 * what it would make first, so a second run makes nothing new.
 */
export interface NoticesSeedDeps {
  readonly database: Database;
  readonly config: AppConfig;
  readonly clock: Clock & { offsetMs: number };
  readonly storage: StoragePort;
  readonly notices: NoticesService;
  readonly tracking: NoticeTrackingService;
  readonly acks: NoticeAcknowledgementsService;
  readonly approvals: ApprovalsService;
  readonly tenants: TenantsService;
  readonly leases: LeasesService;
  readonly esign: EsignService;
  readonly documents: DocumentsService;
  readonly audit: AuditService;
  readonly agency: string;
  readonly actor: (companyId: string, signIn: string) => Promise<Actor>;
  readonly paperScan: Buffer;
}

const HOUR = 3_600_000;
const DEVICE = { ip: '198.51.100.20', userAgent: 'Demo seed (Accra dataset)' };

export async function ensureNotices(deps: NoticesSeedDeps): Promise<Record<string, string>> {
  const { agency } = deps;
  const admin = await deps.actor(agency, 'agency.admin@demo.invalid');
  const managerOne = await deps.actor(agency, 'manager.one@demo.invalid');
  const managerTwo = await deps.actor(agency, 'manager.two@demo.invalid');
  const kojo = await deps.actor(agency, '+233200000011');
  const sms = new InMemorySms();
  const page = new SigningPageService(
    deps.database,
    deps.config,
    deps.clock,
    sms,
    new InMemoryEmail(),
    deps.documents,
    deps.audit,
    deps.esign,
  );
  const renderer = await PdfRenderer.launch({ poolSize: 1 });
  const render = (html: string) => renderer.render(html);
  const out: Record<string, string> = {};
  const sys = <T>(fn: Parameters<typeof withCompany<T>>[2]) =>
    withCompany(deps.database, { companyId: agency, actorKind: 'system' }, fn);

  /** Renders, opens and finalises what is waiting, as the worker would, once each. */
  const done = new Set<string>();
  async function settle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      let worked = false;
      const pending = await sys((tx) =>
        tx
          .select({ id: schema.documentRenderRequest.id })
          .from(schema.documentRenderRequest)
          .where(eq(schema.documentRenderRequest.status, 'pending')),
      );
      for (const r of pending) {
        await deps.documents.renderRequested(agency, r.id, render);
        worked = true;
      }
      const events = await sys((tx) =>
        tx
          .select({
            id: schema.outboxEvent.id,
            type: schema.outboxEvent.type,
            payload: schema.outboxEvent.payload,
          })
          .from(schema.outboxEvent)
          .where(
            inArray(schema.outboxEvent.type, [
              DOCUMENT_RENDERED_EVENT,
              SIGNING_FINALISE_JOB,
              NOTICE_SIGNING_EVENT,
              NOTICE_ESCALATE_JOB,
            ]),
          )
          .orderBy(asc(schema.outboxEvent.createdAt), asc(schema.outboxEvent.id)),
      );
      for (const e of events) {
        if (done.has(e.id)) continue;
        done.add(e.id);
        const p = e.payload as Record<string, string>;
        if (e.type === DOCUMENT_RENDERED_EVENT) {
          await deps.esign.onDocumentRendered(agency, p.renderRequestId!);
          if (await deps.tracking.onDocumentRendered(agency, p.renderRequestId!)) worked = true;
        } else if (e.type === SIGNING_FINALISE_JOB) {
          if ((await deps.esign.finalise(agency, p.signingRequestId!, render)) === 'completed')
            worked = true;
        } else if (e.type === NOTICE_SIGNING_EVENT) {
          await deps.tracking.onSigningEvent(agency, p as never);
        } else if (e.type === NOTICE_ESCALATE_JOB) {
          await deps.tracking.escalate(agency, p.noticeId!);
          worked = true;
        }
      }
      if (!worked) return;
    }
  }

  /** The current lease on a unit, with its tenant. */
  async function leaseOn(unitCode: string) {
    const rows = await sys((tx) =>
      tx.execute<{ id: string; tenant_id: string; unit_id: string; property_id: string }>(
        sql`select l.id, l.tenant_id, l.unit_id, l.property_id from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
            where u.code = ${unitCode} and l.status in ('signed', 'active', 'ending', 'holding_over')
            order by l.start_date desc limit 1`,
      ),
    );
    const row = rows.rows[0];
    if (!row) throw new Error(`no lease on ${unitCode}`);
    return row;
  }

  async function existing(type: NoticeType, where: { leaseId?: string; propertyId?: string }) {
    const rows = await sys((tx) =>
      tx
        .select({ id: schema.notice.id, status: schema.notice.status })
        .from(schema.notice)
        .where(
          and(
            eq(schema.notice.type, type),
            where.leaseId ? eq(schema.notice.leaseId, where.leaseId) : undefined,
            where.propertyId ? eq(schema.notice.propertyId, where.propertyId) : undefined,
            sql`${schema.notice.status} not in ('draft', 'cancelled', 'pending_approval')`,
          ),
        )
        .orderBy(asc(schema.notice.createdAt)),
    );
    return rows[0] ?? null;
  }

  /** Acknowledges as one recipient, on a handover link, with the code from the in-memory port. */
  async function acknowledge(noticeId: string, recipientIndex: number) {
    const detail = await deps.notices.get(managerOne, noticeId);
    const recipient = detail.recipients[recipientIndex]!;
    const link = await deps.notices.handoverLink(managerOne, noticeId, recipient.id);
    const token = /\/l\/([A-Za-z0-9_-]{43})/.exec(link.url)![1]!;
    await page.open(token, DEVICE);
    const sent = await page.sendCode(token, DEVICE);
    const code = /^(\d{6}) is your code/.exec(sms.sent.at(-1)?.body ?? '')?.[1];
    if (!code || sent.channel !== 'sms') throw new Error('no code for the demo acknowledgement');
    await page.sign(token, DEVICE, {
      code,
      method: 'typed',
      typedName: recipient.name.replace(' (demo)', ''),
      consentVersion: CURRENT_NOTICE_CONSENT,
      consentAccepted: true,
    });
    await settle();
  }

  /** Moves the seed's clock to `at` (it only ever runs behind or at now). */
  const at = (instant: Date) => {
    deps.clock.offsetMs = Math.min(0, instant.getTime() - Date.now());
  };
  // Ten o'clock in Accra (UTC+0), inside the sending window (decision 11).
  const tenToday = new Date(`${new Date().toISOString().slice(0, 10)}T10:00:00Z`);
  const daysAgo = (days: number, hours = 0) =>
    new Date(tenToday.getTime() - days * 24 * HOUR + hours * HOUR);
  // A ladder step falls due a moment after the issue time; run each a few minutes after it.
  const step = (days: number, hours: number) =>
    new Date(daysAgo(days, hours).getTime() + 5 * 60_000);

  try {
    // 1. OQ-16: the agency's admin accepts the statement.
    const ack = await deps.acks.quitAcknowledgement(admin);
    if (!ack.enabled) {
      at(daysAgo(10));
      await deps.acks.grantQuit(admin, {
        statementVersion: CURRENT_QUIT_ACK,
        typedName: 'Efua Agency-Admin',
      });
      out.acknowledgement = 'accepted';
    } else out.acknowledgement = 'already accepted';

    // 2. A paper lease with no electronic-service clause (decision 4), on ACC-LEG-B2-04.
    out.noClauseLease = await ensureNoClauseLease(deps, managerOne);

    // 3. The commercial tenant's second authorised signatory (decision 7).
    const pharmacy = await leaseOn('ACC-OSU-G-01');
    const contacts = await sys((tx) =>
      tx
        .select({ name: schema.tenantContact.name })
        .from(schema.tenantContact)
        .where(
          and(
            eq(schema.tenantContact.tenantId, pharmacy.tenant_id),
            eq(schema.tenantContact.kind, 'signatory'),
          ),
        ),
    );
    if (!contacts.some((c) => c.name === 'Kweku Pharmacy-Director (demo)'))
      await deps.tenants.addContact(managerOne, pharmacy.tenant_id, {
        kind: 'signatory',
        name: 'Kweku Pharmacy-Director (demo)',
        phone: '+233200000052',
        consent: { sms: true },
      } as never);

    // 4. A Rent Officer assessment on ACC-LEG-B2-03, five months ago (decision 3).
    const partial = await leaseOn('ACC-LEG-B2-03');
    const assessments = await deps.acks.assessments(managerOne, partial.unit_id);
    if (assessments.assessments.length === 0) {
      at(daysAgo(0));
      await deps.acks.recordAssessment(managerOne, partial.unit_id, {
        assessedOn: toIsoDate(
          addDays(parseBusinessDate(tenToday.toISOString().slice(0, 10)), -150),
        ),
        reference: 'RO/ACC/2026/0412',
      });
    }

    // 5. The notice to quit to the tenant 95 days in arrears, issued six days ago (an approval
    // lasts seven, and the database checks its expiry against its own clock). It is escalated on
    // day five here, through the escalation job itself, so its service pack is ready for the demo;
    // the ladder's own day-7 step finds it escalated already.
    const arrears95 = await leaseOn('ACC-LEG-B2-02');
    if (!(await existing('notice_to_quit', { leaseId: arrears95.id }))) {
      at(daysAgo(6));
      const issueDate = toIsoDate(
        addDays(parseBusinessDate(tenToday.toISOString().slice(0, 10)), -6),
      );
      const draft = await deps.notices.create(managerOne, {
        type: 'notice_to_quit',
        subtype: 'arrears',
        leaseId: arrears95.id,
        fields: {
          particulars: 'Rent has not been paid for more than three months.',
          effectiveDate: toIsoDate(addDays(parseBusinessDate(issueDate), 45)),
        },
      });
      const submitted = await deps.notices.submit(managerOne, draft.id);
      await deps.approvals.decide(managerTwo, submitted.approvalRequestId!, {
        decision: 'approve',
      });
      await settle();
      at(step(6, 24));
      await deps.tracking.runLadder(agency);
      at(daysAgo(6, 26));
      await deps.notices.recordService(kojo, draft.id, {
        method: 'posted_on_premises',
        servedAt: new Date(Date.now() + deps.clock.offsetMs).toISOString(),
        servedByPersonId: kojo.kind === 'staff' ? kojo.personId : null,
        witnessName: 'Kwame Monthly (demo)',
        notes: 'Posted on the door of ACC-LEG-B2-02.',
      });
      for (const hours of [72, 120]) {
        at(step(6, hours));
        await deps.tracking.runLadder(agency);
        await settle();
      }
      at(daysAgo(6, 122));
      await deps.tracking.escalate(agency, draft.id);
      await settle();
      out.noticeToQuit = (await deps.notices.get(managerOne, draft.id)).status;
    } else out.noticeToQuit = 'already there';

    // 6. A rent demand to the tenant 45 days in arrears, issued two days ago and acknowledged.
    const arrears45 = await leaseOn('ACC-LEG-B2-01');
    if (!(await existing('rent_demand', { leaseId: arrears45.id }))) {
      at(daysAgo(2));
      const issueDate = toIsoDate(
        addDays(parseBusinessDate(tenToday.toISOString().slice(0, 10)), -2),
      );
      const compose = await deps.notices.compose(managerOne, {
        type: 'rent_demand',
        leaseId: arrears45.id,
      });
      const arrears = compose.prefill.arrears;
      const draft = await deps.notices.create(managerOne, {
        type: 'rent_demand',
        leaseId: arrears45.id,
        fields: {
          arrearsMinor: Math.max(arrears?.amountMinor ?? 0, 100),
          arrearsAsOf: issueDate,
          invoiceIds: arrears?.invoices.length
            ? arrears.invoices.map((i) => i.id)
            : ['demo-arrears'],
          payBy: toIsoDate(addDays(parseBusinessDate(issueDate), 14)),
        },
      });
      await deps.notices.issue(managerOne, draft.id);
      await settle();
      at(daysAgo(1));
      await acknowledge(draft.id, 0);
      out.rentDemand = (await deps.notices.get(managerOne, draft.id)).status;
    } else out.rentDemand = 'already there';

    // 7. A breach notice to the commercial tenant, acknowledged by one of its two signatories.
    if (!(await existing('breach', { leaseId: pharmacy.id }))) {
      at(daysAgo(3));
      const issueDate = toIsoDate(
        addDays(parseBusinessDate(tenToday.toISOString().slice(0, 10)), -3),
      );
      const draft = await deps.notices.create(managerOne, {
        type: 'breach',
        subtype: 'damage',
        leaseId: pharmacy.id,
        fields: {
          particulars: 'Shelving was fixed to the shop front without consent, damaging the render.',
          remedyBy: toIsoDate(addDays(parseBusinessDate(issueDate), 21)),
        },
      });
      await deps.notices.issue(managerOne, draft.id);
      await settle();
      at(daysAgo(2));
      await acknowledge(draft.id, 0);
      out.breach = (await deps.notices.get(managerOne, draft.id)).status;
    } else out.breach = 'already there';

    // 8. A building-wide fire-safety notice at ACC-OSU, acknowledged by some tenants only.
    if (!(await existing('building_wide', { propertyId: pharmacy.property_id }))) {
      at(daysAgo(1));
      const draft = await deps.notices.create(managerOne, {
        type: 'building_wide',
        subtype: 'fire_safety',
        propertyId: pharmacy.property_id,
        fields: {
          propertyId: pharmacy.property_id,
          title: 'Fire drill and extinguisher check',
          particulars:
            'Every occupant gathers at the car park when the alarm sounds. Extinguishers are checked floor by floor.',
          startDate: toIsoDate(addDays(parseBusinessDate(tenToday.toISOString().slice(0, 10)), 6)),
        },
      });
      await deps.notices.issue(managerOne, draft.id);
      await settle();
      const detail = await deps.notices.get(managerOne, draft.id);
      const individual = detail.recipients.findIndex(
        (r) => r.kind !== 'signatory' && r.phoneMasked,
      );
      if (individual >= 0) await acknowledge(draft.id, individual);
      out.buildingWide = `${(await deps.notices.get(managerOne, draft.id)).signedRecipients} of ${detail.recipients.length} acknowledged`;
    } else out.buildingWide = 'already there';

    // 9. A rent review corrected by a later one (plan 4.8).
    const expiring = await leaseOn('ACC-ELG-B1-01');
    if (!(await existing('rent_review', { leaseId: expiring.id }))) {
      at(daysAgo(4));
      const issueDate = toIsoDate(
        addDays(parseBusinessDate(tenToday.toISOString().slice(0, 10)), -4),
      );
      const first = await deps.notices.create(managerOne, {
        type: 'rent_review',
        leaseId: expiring.id,
        fields: {
          currentRentMinor: 200_000,
          newRentMinor: 220_000,
          effectiveDate: toIsoDate(addDays(parseBusinessDate(issueDate), 40)),
          reason: 'Annual review (the first notice gave the wrong amount).',
        },
      });
      await deps.notices.issue(managerOne, first.id);
      await settle();
      at(daysAgo(3));
      const correction = await deps.notices.correct(managerOne, first.id);
      await deps.notices.update(managerOne, correction.id, {
        fields: {
          ...(correction.fields as Record<string, unknown>),
          newRentMinor: 210_000,
          reason: 'Annual review, as agreed at the meeting.',
        },
      });
      await deps.notices.issue(managerOne, correction.id);
      await settle();
      out.correction = `${(await deps.notices.get(managerOne, first.id)).number} superseded by ${(await deps.notices.get(managerOne, correction.id)).number}`;
    } else out.correction = 'already there';
  } finally {
    deps.clock.offsetMs = 0;
    await renderer.close();
  }
  return out;
}

/** A paper lease whose tenant named no address for electronic service (decision 4). */
async function ensureNoClauseLease(deps: NoticesSeedDeps, manager: Actor): Promise<string> {
  const unit = 'ACC-LEG-B2-04';
  const rows = await withCompany(
    deps.database,
    { companyId: deps.agency, actorKind: 'system' },
    (tx) =>
      tx.execute<{ id: string }>(
        sql`select l.id from lease l join unit u on u.company_id = l.company_id and u.id = l.unit_id
          where u.code = ${unit} and l.status <> 'cancelled' limit 1`,
      ),
  );
  if (rows.rows[0]) return `${unit} already let`;
  const [unitRow] = await withCompany(
    deps.database,
    { companyId: deps.agency, actorKind: 'system' },
    (tx) => tx.select({ id: schema.unit.id }).from(schema.unit).where(eq(schema.unit.code, unit)),
  );
  const { tenant } = await deps.tenants.create(manager, {
    kind: 'individual',
    displayName: 'Yaw No-Clause (demo)',
    phone: '+233200000051',
    consent: { sms: true },
  } as never);
  const today = new Date().toISOString().slice(0, 10);
  const start = toIsoDate(addDays(parseBusinessDate(today), -40));
  const upload = await deps.leases.createUpload(manager, {
    contentType: 'application/pdf',
    sizeBytes: deps.paperScan.length,
  });
  await deps.storage.put({
    bucket: deps.config.S3_BUCKET_FILES,
    key: upload.fields.key!,
    body: deps.paperScan,
    contentType: 'application/pdf',
  });
  await deps.leases.recordPaper(manager, {
    unitId: unitRow!.id,
    tenantId: tenant.id,
    startDate: start,
    endDate: toIsoDate(addDays(parseBusinessDate(start), 364)),
    monthlyRentMinor: 70_000,
    cycle: 'monthly',
    noticeDays: 30,
    parties: [{ role: 'tenant', name: 'Yaw No-Clause (demo)', paperSignedOn: start }],
    scanUploadId: upload.uploadId,
    signedOn: start,
    servicePhones: [],
    serviceEmails: [],
  } as never);
  return `${unit} let to Yaw No-Clause (demo), no electronic-service clause`;
}
