import { schema, sql, withCompany } from '@rent/db';
import { PdfRenderer } from '@rent/documents/render';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { CURRENT_NOTICE_CONSENT } from '@rent/domain/esign';
import { CURRENT_QUIT_ACK } from '@rent/domain/notices';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessagingConsentService } from '../src/messaging/consent.service';
import { MessagingService } from '../src/messaging/messaging.service';
import {
  asSuperuser,
  company,
  member,
  person,
  staff,
  startServerTest,
  type ServerTestContext,
} from './support';
import { billingServices, type BillingServices } from './support/billing';
import { PHONE, tokenIn } from './support/esign';
import { noticesServices, NoticesWorker, type NoticesServices } from './support/notices';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * M7 legal notices end to end on the services (plan section 6), on a fixed clock: the OQ-16 gate,
 * the earliest lawful date at the composer and again at issue, two-person approval for a notice to
 * quit, the frozen PDF and links on every channel, acknowledgement on the engine (no decline, the
 * notice consent, both hashes verified), the ladder to escalation with the service pack, decisions
 * 4 and 5, the s.23 bar, late service, immutability and corrections, tasks in scope, the timeline,
 * and isolation between companies. Real PostgreSQL with RLS.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let n: NoticesServices;
let worker: NoticesWorker;
let renderer: PdfRenderer;
let agencyId: string;
let otherId: string;
let admin: Awaited<ReturnType<typeof staffIn>>;
let managerOne: Awaited<ReturnType<typeof staffIn>>;
let managerTwo: Awaited<ReturnType<typeof staffIn>>;
let caretaker: Awaited<ReturnType<typeof staffIn>>;
let outsider: Awaited<ReturnType<typeof staffIn>>;
let units: Record<string, string>;
let propertyId: string;
let ownerId: string;

const HOUR = 3_600_000;
const TOTP_SECRET = 'notices-test-totp-secret-value';
const base32 = (text: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text)) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};
/** Monday 9 November 2026, 10:00 in Accra: inside the sending window (decision 11). */
const START = new Date('2026-11-09T10:00:00Z');
const today = () => toIsoDate(parseBusinessDate(ctx.clock.now().toISOString().slice(0, 10)));
const plus = (days: number) => toIsoDate(addDays(parseBusinessDate(today()), days));

let phoneSeq = 0;
const newPhone = () => `+2332009${String((phoneSeq += 1)).padStart(5, '0')}`;
let unitSeq = 0;
const nextUnit = () => Object.values(units)[unitSeq++]!;

/** A tenant with SMS consent and a lease recorded from paper; with or without the clause. */
async function leased(options: { clause?: boolean; unitId?: string } = {}) {
  const phone = newPhone();
  const { tenant } = await s.tenants.create(managerOne, {
    kind: 'individual',
    displayName: `Tenant ${phone.slice(-4)}`,
    phone,
    consent: { sms: true },
  });
  const start = plus(-60);
  const lease = await s.leases.recordPaper(managerOne, {
    unitId: options.unitId ?? nextUnit(),
    tenantId: tenant.id,
    startDate: start,
    endDate: toIsoDate(addDays(parseBusinessDate(start), 364)),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
    parties: [{ role: 'tenant', name: tenant.displayName }],
    scanUploadId: await uploadLeaseFile(ctx, s, managerOne),
    signedOn: start,
    ...(options.clause === false ? { servicePhones: [], serviceEmails: [] } : {}),
  });
  return { tenantId: tenant.id, leaseId: lease.id, phone, unitId: lease.unit.id };
}

const codeSentTo = (phone: string) => {
  const code = /^(\d{6}) is your code/.exec(s.sms.lastTo(phone)?.body ?? '')?.[1];
  if (!code) throw new Error('no code was texted');
  return code;
};

async function acknowledge(token: string, phone: string) {
  await s.signingPage.sendCode(token, PHONE);
  return s.signingPage.sign(token, PHONE, {
    code: codeSentTo(phone),
    method: 'typed',
    typedName: 'Tenant Name',
    consentVersion: CURRENT_NOTICE_CONSENT,
    consentAccepted: true,
  });
}

async function issuedDemand(lease: Awaited<ReturnType<typeof leased>>) {
  // M7 review M2 checks a rent demand against the ledger (fixture change approved by the founder,
  // 2026-11-04): the lease is billed from its start, so its first invoices are overdue, and the
  // demand names them and what they still owe, as compose suggests.
  await asSuperuser(ctx, 'update lease set billing_start_date = start_date where id = $1', [
    lease.leaseId,
  ]);
  await b.invoicing.onLeaseSigned(agencyId, lease.leaseId);
  const check = await n.notices.compose(managerOne, {
    type: 'rent_demand',
    leaseId: lease.leaseId,
  });
  const draft = await n.notices.create(managerOne, {
    type: 'rent_demand',
    leaseId: lease.leaseId,
    fields: check.prefill.suggestedFields,
  });
  await n.notices.issue(managerOne, draft.id);
  await worker.run(agencyId);
  return n.notices.get(managerOne, draft.id);
}

beforeAll(async () => {
  ctx = await startServerTest();
  ctx.clock.set(START);
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  n = noticesServices(ctx, s, b);
  renderer = await PdfRenderer.launch({ poolSize: 1 });
  worker = new NoticesWorker(ctx, s, n, (html) => renderer.render(html));
  agencyId = await company(ctx, 'agency', 'Notices Agency');
  otherId = await company(ctx, 'agency', 'Other Agency');
  admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  managerOne = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Manager One');
  managerTwo = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Manager Two');
  outsider = await staffIn(ctx, otherId, 'agency', 'property_manager', 'Outsider');
  ownerId = (await s.owners.create(admin, { kind: 'individual', displayName: 'Owner' })).id;
  ({ propertyId, units } = await propertyWithUnits(s, managerOne, {
    areaCode: 'ACC',
    propertyPart: 'NOT',
    ownerId,
    units: [{ unitType: 'apartment', count: 20, bedrooms: 2 }],
  }));
  caretaker = await staffIn(ctx, agencyId, 'agency', 'caretaker', 'Kojo', {
    properties: [propertyId],
  });
}, 180_000);

afterAll(async () => {
  await renderer?.close();
  await ctx?.close();
});

describe('LN-01 notices to quit: OQ-16, the earliest lawful date and two-person approval', () => {
  it('refuses a notice to quit until a company admin accepts the risk (OQ-16)', async () => {
    const lease = await leased();
    await expect(
      n.notices.create(managerOne, {
        type: 'notice_to_quit',
        subtype: 'arrears',
        leaseId: lease.leaseId,
        fields: { particulars: 'Rent unpaid', effectiveDate: plus(40) },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'notice_quit_not_enabled' });
    await expect(
      n.acks.grantQuit(managerOne, { statementVersion: CURRENT_QUIT_ACK, typedName: 'Manager' }),
    ).rejects.toMatchObject({ status: 403 });
    const ack = await n.acks.grantQuit(admin, {
      statementVersion: CURRENT_QUIT_ACK,
      typedName: 'Admin Person',
    });
    expect(ack).toMatchObject({ enabled: true, current: { typedName: 'Admin Person' } });
  });

  it('★ shows the earliest date with every warning, and refuses a date before it at the composer', async () => {
    const lease = await leased();
    const check = await n.notices.compose(managerOne, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: lease.leaseId,
      fields: { particulars: 'Rent unpaid', effectiveDate: plus(10) },
    });
    expect(check.earliest).toMatchObject({ earliestDate: plus(30), periodSource: 'contractual' });
    expect(check.blockers.map((b) => b.code)).toContain('notice.effective_date_too_early');
    expect(check.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        'statutory_minimum_unverified',
        'statutory_minimum_not_set',
        'counsel_wording_outstanding',
      ]),
    );
    const draft = await n.notices.create(managerOne, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: lease.leaseId,
      fields: { particulars: 'Rent unpaid', effectiveDate: plus(10) },
    });
    await expect(n.notices.submit(managerOne, draft.id)).rejects.toMatchObject({
      status: 409,
      code: 'notice_effective_date_too_early',
    });
    await expect(n.notices.issue(managerOne, draft.id)).rejects.toMatchObject({
      code: 'notice_two_person_required',
    });
  });

  it('never lets the initiator approve, and issues once a second person approves', async () => {
    const lease = await leased();
    const draft = await n.notices.create(managerOne, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: lease.leaseId,
      fields: { particulars: 'Rent unpaid since August', effectiveDate: plus(40) },
    });
    const submitted = await n.notices.submit(managerOne, draft.id);
    expect(submitted.status).toBe('pending_approval');
    expect(submitted.approval?.request.actionType).toBe('notice.issue_quit');
    const requestId = submitted.approvalRequestId!;
    await expect(
      s.approvals.decide(managerOne, requestId, { decision: 'approve' }),
    ).rejects.toMatchObject({ status: 403 });
    await s.approvals.decide(managerTwo, requestId, { decision: 'approve' });
    const issued = await n.notices.get(managerOne, draft.id);
    expect(issued.status).toBe('sent');
    expect(issued.number).toMatch(/^N-\d{6}$/);
    expect(issued.ruleVersions.map((r) => r.key)).toContain(
      'notice_to_quit.statutory_min_days.residential',
    );
    // Decision 10: posted on the premises whether or not the tenant signs.
    expect(issued.tasks.map((t) => t.kind)).toContain('notice_post_on_premises');
    // Plan 4.8: an issued notice is never edited.
    await expect(
      n.notices.update(managerOne, draft.id, { fields: { particulars: 'Changed' } }),
    ).rejects.toMatchObject({ code: 'notice_frozen' });
  });

  it('★ sends a notice whose date stopped holding during approval back to draft, with the reason', async () => {
    const lease = await leased();
    const draft = await n.notices.create(managerOne, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: lease.leaseId,
      fields: { particulars: 'Rent unpaid', effectiveDate: plus(31) },
    });
    const submitted = await n.notices.submit(managerOne, draft.id);
    ctx.clock.advance(3 * 24 * HOUR);
    try {
      await s.approvals.decide(managerTwo, submitted.approvalRequestId!, { decision: 'approve' });
      const back = await n.notices.get(managerOne, draft.id);
      expect(back.status).toBe('draft');
      expect(back.number).toBeNull();
      expect(back.events.map((e) => e.kind)).toContain('returned_to_draft');
      expect(back.blockers.map((x) => x.code)).toContain('notice.effective_date_too_early');
    } finally {
      ctx.clock.set(START);
    }
  });
});

describe('LN-02 and LN-04 issue, links and acknowledgement', () => {
  it('★ freezes the PDF, sends links, refuses a decline, and verifies both hashes once signed', async () => {
    const lease = await leased();
    const notice = await issuedDemand(lease);
    expect(notice.document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(notice.recipients[0]!.channels).toEqual(
      expect.arrayContaining([
        { channel: 'sms', mode: 'service', reason: null },
        { channel: 'email', mode: 'withheld', reason: 'no_address' },
      ]),
    );
    const token = tokenIn(s.sms.lastTo(lease.phone)?.body);
    const page = await s.signingPage.open(token, PHONE);
    expect(page).toMatchObject({
      screen: 'sign',
      subject: 'notice',
      canDecline: false,
      consent: { version: CURRENT_NOTICE_CONSENT },
      notice: { number: notice.number },
    });
    expect(page.consent!.text).toMatch(/does not mean that I agree/);
    await expect(s.signingPage.decline(token, PHONE, 'I disagree')).rejects.toMatchObject({
      status: 409,
      code: 'notice_not_declinable',
    });
    // Decision 6: a handover link does not replace the one sent by message.
    const handover = await n.notices.handoverLink(managerOne, notice.id, notice.recipients[0]!.id);
    expect((await s.signingPage.open(tokenIn(handover.url), PHONE)).screen).toBe('sign');
    expect((await s.signingPage.open(token, PHONE)).screen).toBe('sign');
    await acknowledge(token, lease.phone);
    await worker.run(agencyId);
    const signed = await n.notices.get(managerOne, notice.id);
    expect(signed.status).toBe('signed');
    expect(signed.recipients[0]!.signedAt).not.toBeNull();
    expect(signed.document.signedSha256).toMatch(/^[0-9a-f]{64}$/);
    const requests = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) => s.esign.noticeRequests(tx, notice.id),
    );
    expect(await s.esign.verify(agencyId, requests[0]!.request.id)).toEqual({
      frozen: true,
      signed: true,
      audited: true,
    });
    // LN-05: the ladder stops once signed.
    ctx.clock.advance(25 * HOUR);
    try {
      const before = s.sms.sent.length;
      await n.tracking.runLadder(agencyId);
      await worker.run(agencyId);
      expect(s.sms.sent.filter((m) => m.to === lease.phone).length).toBe(
        s.sms.sent.slice(0, before).filter((m) => m.to === lease.phone).length,
      );
    } finally {
      ctx.clock.set(START);
    }
  });
});

describe('LN-05 the ladder', () => {
  it('★ takes an unsigned notice through every step to escalation, once each, with the service pack', async () => {
    const lease = await leased();
    const draft = await n.notices.create(managerOne, {
      type: 'breach',
      subtype: 'noise',
      leaseId: lease.leaseId,
      fields: { particulars: 'Loud music after midnight', remedyBy: plus(10) },
    });
    await n.notices.issue(managerOne, draft.id);
    await worker.run(agencyId);
    const kinds = async () =>
      (await n.notices.get(managerOne, draft.id)).events.map((e) => [e.kind, e.data?.step ?? null]);
    try {
      for (const hours of [24, 72, 120, 168]) {
        ctx.clock.set(new Date(START.getTime() + hours * HOUR));
        await n.tracking.runLadder(agencyId);
        await n.tracking.runLadder(agencyId);
        await worker.run(agencyId);
      }
      const events = await kinds();
      for (const step of [
        'reminder_1',
        'reminder_2',
        'manager_alert',
        'caretaker_task',
        'escalate',
      ])
        expect(
          events.filter(([, s]) => s === step),
          step,
        ).toHaveLength(1);
      const escalated = await n.notices.get(managerOne, draft.id);
      expect(escalated.status).toBe('escalated');
      expect(escalated.document.servicePackReady).toBe(true);
      expect(escalated.tasks.map((t) => t.kind)).toEqual(
        expect.arrayContaining(['notice_in_person_reminder', 'notice_physical_service']),
      );
      // CF-06: the caretaker of the property gets the tasks, and sees only theirs.
      const mine = await n.tasks.list(caretaker, { mine: true });
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((t) => t.property.id === propertyId && t.mayComplete)).toBe(true);
      await n.tasks.complete(caretaker, mine[0]!.id, 'Spoke to the tenant');
    } finally {
      ctx.clock.set(START);
    }
  });

  it('holds tenant reminders for the sending window, and pauses and resumes', async () => {
    const lease = await leased();
    const notice = await issuedDemand(lease);
    try {
      // 24 hours after a 10:00 issue is 10:00; at 21:00 the window is shut.
      ctx.clock.set(new Date(START.getTime() + 35 * HOUR));
      expect((await n.tracking.runLadder(agencyId)).fired).toBe(0);
      await n.notices.controlLadder(managerOne, notice.id, 'pause', 'Tenant travelling');
      ctx.clock.set(new Date(START.getTime() + 46 * HOUR));
      expect((await n.tracking.runLadder(agencyId)).fired).toBe(0);
      await n.notices.controlLadder(managerOne, notice.id, 'resume', 'Back home');
      expect((await n.tracking.runLadder(agencyId)).fired).toBeGreaterThan(0);
    } finally {
      ctx.clock.set(START);
    }
  });
});

describe('Decisions 4 and 5, the s.23 bar and late service', () => {
  it('sends a courtesy copy and plans physical service without the electronic-service clause', async () => {
    const lease = await leased({ clause: false });
    const draft = await n.notices.create(managerOne, {
      type: 'breach',
      subtype: 'damage',
      leaseId: lease.leaseId,
      fields: { particulars: 'Broken window', remedyBy: plus(7) },
    });
    await n.notices.issue(managerOne, draft.id);
    await worker.run(agencyId);
    const notice = await n.notices.get(managerOne, draft.id);
    expect(notice.electronicService).toBe(false);
    expect(notice.recipients[0]).toMatchObject({ physicalServicePlanned: true });
    expect(notice.recipients[0]!.channels).toContainEqual({
      channel: 'sms',
      mode: 'courtesy',
      reason: null,
    });
    expect(notice.tasks.map((t) => t.kind)).toContain('notice_physical_service');
    expect(s.sms.lastTo(lease.phone)?.body).toMatch(/courtesy copy/);
  });

  it('refuses a notice to quit inside 24 months of a Rent Officer assessment (s.23)', async () => {
    const lease = await leased();
    await n.acks.recordAssessment(managerOne, lease.unitId, {
      assessedOn: plus(-100),
      reference: 'RO/ACC/2026/14',
    });
    const check = await n.notices.compose(managerOne, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: lease.leaseId,
      fields: { particulars: 'Rent unpaid', effectiveDate: plus(60) },
    });
    expect(check.quitBar).toMatchObject({ barred: true });
    expect(check.blockers.map((x) => x.code)).toContain('notice.quit_barred');
    expect(check.warnings.map((w) => w.code)).toContain('assessment_bar_unverified');
  });

  it('flags a notice served too late for its date (plan 4.3)', async () => {
    const lease = await leased({ clause: false });
    const draft = await n.notices.create(managerOne, {
      type: 'rent_review',
      leaseId: lease.leaseId,
      fields: {
        currentRentMinor: 150_000,
        newRentMinor: 165_000,
        effectiveDate: plus(30),
        reason: 'Annual review',
      },
    });
    await n.notices.issue(managerOne, draft.id);
    // Served in person five days after issue: the 30-day period then ends five days too late.
    ctx.clock.set(new Date(START.getTime() + 5 * 24 * HOUR));
    try {
      await n.notices.recordService(managerOne, draft.id, {
        method: 'handed_to_tenant',
        servedAt: ctx.clock.now().toISOString(),
        servedByName: 'Kojo Caretaker',
      });
    } finally {
      ctx.clock.set(START);
    }
    const flagged = await n.notices.get(managerOne, draft.id);
    expect(flagged.servedTooLate).toBe(true);
    expect(flagged.servedTooLateDetail).toMatchObject({ shortByDays: 5 });
  });
});

describe('LN-03 corrections, closure, the timeline and isolation', () => {
  it('★ corrects an issued notice with a new one that closes it as superseded', async () => {
    const lease = await leased();
    const original = await issuedDemand(lease);
    const correction = await n.notices.correct(managerOne, original.id);
    expect(correction.corrects).toMatchObject({ id: original.id, number: original.number });
    await n.notices.issue(managerOne, correction.id);
    const old = await n.notices.get(managerOne, original.id);
    expect(old).toMatchObject({ status: 'closed', outcome: 'superseded' });
    expect(old.correctedBy?.id).toBe(correction.id);
    await expect(
      n.notices.close(managerOne, correction.id, 'paid', 'Paid in full'),
    ).resolves.toMatchObject({ status: 'closed', outcome: 'paid' });
  });

  it('puts every status change on the tenant timeline', async () => {
    const lease = await leased();
    const notice = await issuedDemand(lease);
    const timeline = await s.tenants.timeline(managerOne, lease.tenantId);
    const sent = timeline.find((e) => e.action === 'notice.sent');
    expect(sent?.data).toMatchObject({ noticeId: notice.id, number: notice.number });
  });

  it("never shows a company another's notices", async () => {
    const lease = await leased();
    const notice = await issuedDemand(lease);
    await expect(n.notices.get(outsider, notice.id)).rejects.toMatchObject({ status: 404 });
    expect((await n.notices.list(outsider, {})).map((x) => x.id)).not.toContain(notice.id);
    const rows = await withCompany(
      ctx.database,
      { companyId: otherId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ id: schema.noticeEvent.id })
          .from(schema.noticeEvent)
          .where(sql`${schema.noticeEvent.noticeId} = ${notice.id}`),
    );
    expect(rows).toEqual([]);
  });
});

describe('LN-05 and CF-06 scope inside one company (plan 4.11)', () => {
  let otherProperty: string;
  let otherUnits: string[];
  let abena: Awaited<ReturnType<typeof staffIn>>;
  let accountant: Awaited<ReturnType<typeof staffIn>>;

  beforeAll(async () => {
    const other = await propertyWithUnits(s, managerOne, {
      areaCode: 'ACC',
      propertyPart: 'NOB',
      ownerId,
      units: [{ unitType: 'apartment', count: 4, bedrooms: 1 }],
    });
    otherProperty = other.propertyId;
    otherUnits = Object.values(other.units);
    abena = await staffIn(ctx, agencyId, 'agency', 'caretaker', 'Abena', {
      properties: [otherProperty],
    });
    accountant = await staffIn(ctx, agencyId, 'agency', 'accountant', 'Accountant');
  });

  it("lets a caretaker read and serve their property's notices and tasks, and nothing on another", async () => {
    const mineLease = await leased({ clause: false });
    const theirsLease = await leased({ clause: false, unitId: otherUnits[0]! });
    const breach = (leaseId: string) =>
      n.notices.create(managerOne, {
        type: 'breach',
        subtype: 'damage',
        leaseId,
        fields: { particulars: 'Broken louvres', remedyBy: plus(7) },
      });
    const mine = await breach(mineLease.leaseId);
    const theirs = await breach(theirsLease.leaseId);
    await n.notices.issue(managerOne, mine.id);
    await n.notices.issue(managerOne, theirs.id);
    await worker.run(agencyId);

    // The positive case: Kojo reads his property's notice and records its service.
    expect((await n.notices.get(caretaker, mine.id)).id).toBe(mine.id);
    const listed = (await n.notices.list(caretaker, {})).map((x) => x.id);
    expect(listed).toContain(mine.id);
    expect(listed).not.toContain(theirs.id);
    await n.notices.recordService(caretaker, mine.id, {
      method: 'posted_on_premises',
      servedAt: ctx.clock.now().toISOString(),
      servedByName: 'Kojo Caretaker',
    });
    // Abena's property is not his: not found, not forbidden, so it does not leak.
    await expect(n.notices.get(caretaker, theirs.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      n.notices.recordService(caretaker, theirs.id, {
        method: 'posted_on_premises',
        servedAt: ctx.clock.now().toISOString(),
        servedByName: 'Kojo Caretaker',
      }),
    ).rejects.toMatchObject({ status: 404 });
    // Caretakers neither draft nor issue.
    await expect(
      n.notices.create(caretaker, {
        type: 'breach',
        subtype: 'damage',
        leaseId: mineLease.leaseId,
        fields: { particulars: 'x', remedyBy: plus(7) },
      }),
    ).rejects.toMatchObject({ status: 403 });

    // CF-06: each caretaker gets the physical-service task for their own property.
    const kojoTasks = await n.tasks.list(caretaker, { mine: true });
    const abenaTasks = await n.tasks.list(abena, { mine: true });
    expect(kojoTasks.some((t) => t.notice?.id === mine.id)).toBe(true);
    expect(kojoTasks.some((t) => t.notice?.id === theirs.id)).toBe(false);
    const abenaTask = abenaTasks.find((t) => t.notice?.id === theirs.id)!;
    expect(abenaTask).toMatchObject({ property: { id: otherProperty }, mayComplete: true });
    expect((await n.tasks.list(caretaker, {})).map((t) => t.id)).not.toContain(abenaTask.id);
    await expect(n.tasks.complete(caretaker, abenaTask.id, 'Not mine')).rejects.toMatchObject({
      status: 404,
    });
    await expect(n.tasks.complete(abena, abenaTask.id, 'Posted it')).resolves.toMatchObject({
      status: 'done',
    });
  });

  it('lets an accountant read notices but change nothing', async () => {
    const lease = await leased();
    const notice = await issuedDemand(lease);
    expect((await n.notices.get(accountant, notice.id)).id).toBe(notice.id);
    await expect(
      n.notices.controlLadder(accountant, notice.id, 'pause', 'No'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(n.notices.close(accountant, notice.id, 'paid', 'No')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('LN-07 a company tenant acknowledges once for all its signatories', () => {
  it('★ stops the ladder for every signatory when one of them signs', async () => {
    const [first, second] = [newPhone(), newPhone()];
    const { tenant } = await s.tenants.create(managerOne, {
      kind: 'company',
      displayName: 'Signatories Ltd',
      legalName: 'Signatories Limited',
    });
    for (const [name, phone] of [
      ['Director One', first],
      ['Director Two', second],
    ] as const)
      await s.tenants.addContact(managerOne, tenant.id, {
        kind: 'signatory',
        name,
        phone,
        consent: { sms: true },
      });
    const start = plus(-60);
    const lease = await s.leases.recordPaper(managerOne, {
      unitId: nextUnit(),
      tenantId: tenant.id,
      startDate: start,
      endDate: toIsoDate(addDays(parseBusinessDate(start), 364)),
      monthlyRentMinor: 400_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Signatories Limited' }],
      scanUploadId: await uploadLeaseFile(ctx, s, managerOne),
      signedOn: start,
      servicePhones: [first, second],
      serviceEmails: [],
    });
    const draft = await n.notices.create(managerOne, {
      type: 'breach',
      subtype: 'other',
      leaseId: lease.id,
      fields: { particulars: 'Storage in the corridor', remedyBy: plus(10) },
    });
    await n.notices.issue(managerOne, draft.id);
    await worker.run(agencyId);
    const issued = await n.notices.get(managerOne, draft.id);
    expect(issued.recipients.map((r) => r.kind)).toEqual(['signatory', 'signatory']);
    expect(issued.recipients.every((r) => r.channels.some((c) => c.mode === 'service'))).toBe(true);

    await acknowledge(tokenIn(s.sms.lastTo(first)?.body), first);
    await worker.run(agencyId);
    const signed = await n.notices.get(managerOne, draft.id);
    expect(signed.status).toBe('signed');
    expect(signed.recipients.map((r) => r.acknowledged)).toEqual([true, true]);
    // The other director's link still opens, read-only: the company has acknowledged.
    const other = await s.signingPage.open(tokenIn(s.sms.lastTo(second)?.body), PHONE);
    expect(other.screen).toBe('copy');

    const sentTo = (phone: string) => s.sms.sent.filter((m) => m.to === phone).length;
    const before = [sentTo(first), sentTo(second)];
    try {
      for (const hours of [24, 72]) {
        ctx.clock.set(new Date(START.getTime() + hours * HOUR));
        await n.tracking.runLadder(agencyId);
        await worker.run(agencyId);
      }
      expect([sentTo(first), sentTo(second)]).toEqual(before);
    } finally {
      ctx.clock.set(START);
    }
  });
});

describe('LN-05 cancelling the ladder', () => {
  it('sends no further reminders once cancelled, and records who cancelled it and why', async () => {
    const lease = await leased();
    const notice = await issuedDemand(lease);
    await n.notices.controlLadder(managerOne, notice.id, 'cancel', 'Paid at the office');
    try {
      for (const hours of [24, 72, 120, 168]) {
        ctx.clock.set(new Date(START.getTime() + hours * HOUR));
        await n.tracking.runLadder(agencyId);
        await worker.run(agencyId);
      }
    } finally {
      ctx.clock.set(START);
    }
    const after = await n.notices.get(managerOne, notice.id);
    expect(after.status).toBe('sent');
    // The job runs for the whole company; this notice took no step at all.
    expect(after.events.map((e) => e.kind)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(reminded|manager_alerted|task_created|escalated)$/),
      ]),
    );
    expect(after.events.find((e) => e.kind === 'ladder_cancelled')).toMatchObject({
      actorName: 'Manager One',
      data: { reason: 'Paid at the office' },
    });
  });
});

describe('Decision 5, an opt-out withholds the channel', () => {
  it('withholds SMS after the tenant opts out, records why, and plans physical service', async () => {
    const lease = await leased();
    const consent = new MessagingConsentService(
      ctx.database,
      ctx.clock,
      ctx.config,
      s.policy,
      s.tenants,
    );
    // STOP on each channel the tenant can be reached on; the clause never overrides an opt-out.
    await consent.record(managerOne, lease.tenantId, { channel: 'sms', action: 'withdraw' });
    await consent.record(managerOne, lease.tenantId, { channel: 'whatsapp', action: 'withdraw' });
    const before = s.sms.sent.filter((m) => m.to === lease.phone).length;
    const notice = await issuedDemand(lease);
    expect(notice.recipients[0]!.channels).toEqual(
      expect.arrayContaining([
        { channel: 'sms', mode: 'withheld', reason: 'opted_out' },
        { channel: 'whatsapp', mode: 'withheld', reason: 'opted_out' },
      ]),
    );
    expect(notice.events.filter((e) => e.kind === 'channel_withheld').length).toBeGreaterThan(0);
    expect(notice.recipients[0]!.physicalServicePlanned).toBe(true);
    expect(notice.tasks.map((t) => t.kind)).toContain('notice_physical_service');
    expect(s.sms.sent.filter((m) => m.to === lease.phone).length).toBe(before);
  });
});

describe('LN-03 delivery reports and the audit log', () => {
  it('records the channel that confirmed delivery, at server time, and audits each status change', async () => {
    const lease = await leased();
    const notice = await issuedDemand(lease);
    const recipient = notice.recipients[0]!;
    const [message] = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ id: schema.message.id })
          .from(schema.message)
          .where(
            sql`${schema.message.relatedType} = 'notice_recipient' and ${schema.message.relatedId} = ${recipient.id}`,
          ),
    );
    // As Nest wires it in the worker: on the one shared clock (M6).
    const messaging = new MessagingService(
      ctx.database,
      s.sms,
      s.email,
      ctx.config,
      s.tenants,
      s.idChecks,
      null,
      null,
      s.documents,
      ctx.clock,
    );
    ctx.clock.advance(HOUR);
    try {
      await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
        messaging.reportToRelated(tx, agencyId, message!.id, crypto.randomUUID(), {
          status: 'delivered',
          channel: 'sms',
        }),
      );
      await worker.run(agencyId);
      const delivered = await n.notices.get(managerOne, notice.id);
      expect(delivered.status).toBe('delivered');
      expect(delivered.recipients[0]).toMatchObject({
        deliveredVia: 'sms',
        deliveredAt: ctx.clock.now(),
      });
    } finally {
      ctx.clock.set(START);
    }
    const audit = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ action: schema.auditEvent.action, data: schema.auditEvent.data })
          .from(schema.auditEvent)
          .where(sql`${schema.auditEvent.recordId} = ${notice.id}`),
    );
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['notice.issued', 'notice.frozen']));
    const statuses = audit
      .filter((a) => a.action === 'notice.update')
      .map((a) => (a.data as { after?: { status?: string } }).after?.status);
    expect(statuses).toEqual(expect.arrayContaining(['sent', 'delivered']));
  });
});

describe('OQ-29 and plan decision 14: single-user companies and the plan', () => {
  it('holds a sole landlord’s notice to quit for the cooling-off period, then issues it on a fresh code', async () => {
    const landlordId = await company(ctx, 'landlord', 'Solo Notices Landlord');
    const soloId = await person(ctx, 'Solo landlord', { totpSecret: TOTP_SECRET });
    const solo = staff(
      landlordId,
      'landlord',
      soloId,
      await member(ctx, landlordId, soloId, 'owner'),
      'owner',
    );
    const { units: soloUnits } = await propertyWithUnits(s, solo, {
      areaCode: 'TEM',
      propertyPart: 'SOL',
      units: [{ unitType: 'apartment', count: 1, bedrooms: 2 }],
    });
    const phone = newPhone();
    const { tenant } = await s.tenants.create(solo, {
      kind: 'individual',
      displayName: 'Solo Tenant',
      phone,
      consent: { sms: true },
    });
    const start = plus(-60);
    const lease = await s.leases.recordPaper(solo, {
      unitId: Object.values(soloUnits)[0]!,
      tenantId: tenant.id,
      startDate: start,
      endDate: toIsoDate(addDays(parseBusinessDate(start), 364)),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Solo Tenant' }],
      scanUploadId: await uploadLeaseFile(ctx, s, solo),
      signedOn: start,
    });
    await n.acks.grantQuit(solo, { statementVersion: CURRENT_QUIT_ACK, typedName: 'Solo' });
    const draft = await n.notices.create(solo, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: lease.id,
      fields: { particulars: 'Rent unpaid', effectiveDate: plus(45) },
    });
    const submitted = await n.notices.submit(solo, draft.id);
    expect(submitted.approval?.request).toMatchObject({
      mode: 'single_user',
      status: 'cooling_off',
    });
    const requestId = submitted.approvalRequestId!;
    await expect(
      s.approvals.decide(solo, requestId, {
        decision: 'self_confirm',
        code: await generate({ secret: base32(TOTP_SECRET) }),
      }),
    ).rejects.toThrow(/cooling-off/);
    expect((await n.notices.get(solo, draft.id)).status).toBe('pending_approval');

    // Ends before both clocks: the database's (the approval trigger checks now()) and the
    // service's, which this test drives from START. Using only now() failed once the real date
    // passed START + 24 hours (founder-approved setup fix, M11, 2026-11-10).
    await asSuperuser(
      ctx,
      "update approval_request set cooling_off_until = least(now() - interval '1 minute', $2::timestamptz) where id = $1",
      [requestId, new Date(ctx.clock.now().getTime() + 24 * HOUR)],
    );
    ctx.clock.advance(24 * HOUR + 60_000);
    try {
      await s.approvals.decide(solo, requestId, {
        decision: 'self_confirm',
        code: await generate({ secret: base32(TOTP_SECRET) }),
      });
      const issued = await n.notices.get(solo, draft.id);
      expect(issued.status).toBe('sent');
      expect(issued.approval?.request).toMatchObject({
        status: 'approved',
        closeReason: 'self_confirmed_after_cooling_off',
      });
    } finally {
      ctx.clock.set(START);
    }
  });

  it('keeps notices from a company on Starter (decision 14)', async () => {
    const starterId = await company(ctx, 'landlord', 'Starter Landlord');
    await asSuperuser(ctx, "update company set plan = 'starter' where id = $1", [starterId]);
    const owner = await staffIn(ctx, starterId, 'landlord', 'owner', 'Starter owner');
    await expect(n.notices.list(owner, {})).rejects.toMatchObject({
      status: 403,
      code: 'not_on_plan',
    });
    await expect(n.notices.summary(owner)).rejects.toMatchObject({ code: 'not_on_plan' });
  });
});
