import { createHash } from 'node:crypto';
import { schema, sql, withCompany } from '@rent/db';
import { PdfRenderer } from '@rent/documents/render';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { CURRENT_NOTICE_CONSENT } from '@rent/domain/esign';
import { CURRENT_QUIT_ACK } from '@rent/domain/notices';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noticeCheckConflict } from '../src/core/db-errors';
import { asSuperuser, company, startServerTest, type ServerTestContext } from './support';
import { billedLease, billingServices, type BillingServices } from './support/billing';
import { PHONE, tokenIn } from './support/esign';
import { messagingServices, receive, type MessagingServices } from './support/messaging';
import { noticesServices, NoticesWorker, type NoticesServices } from './support/notices';
import {
  propertyWithUnits,
  SAMPLE_PDF,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M7 review's backend findings (docs/plans/M7.md section 9.3), each proved on the services, on
 * a fixed clock, with real PostgreSQL and RLS: lease signing apart from notices (M1), money checked
 * against the ledger (M2), a late close keeping the acknowledgement (M3), co-tenants (MF-4), the
 * occupants' address (MF-5), honest reminders (MF-6), the timeline (MF-7, D-A), service after close
 * (MF-8), and the should-fix items and notes. The tests the review asked for beside the weak ones
 * are here too.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let n: NoticesServices;
let m: MessagingServices;
let worker: NoticesWorker;
let renderer: PdfRenderer;
let agencyId: string;
let otherId: string;
let admin: Awaited<ReturnType<typeof staffIn>>;
let managerOne: Awaited<ReturnType<typeof staffIn>>;
let managerTwo: Awaited<ReturnType<typeof staffIn>>;
let accountant: Awaited<ReturnType<typeof staffIn>>;
let caretaker: Awaited<ReturnType<typeof staffIn>>;
let other: Awaited<ReturnType<typeof staffIn>>;
let propertyId: string;
let units: string[];
let ownerId: string;

const HOUR = 3_600_000;
/**
 * A Monday at 10:00 in Accra, inside the sending window (decision 11): the Monday nearest the real
 * date. The service runs on this test clock, but approval requests expire by the database's real
 * clock (now()). A fixed day (9 November 2026) failed once the real date passed it by a week
 * (founder-approved setup fix, 2026-11-19; what the tests check is unchanged).
 */
const START = (() => {
  const now = Date.now();
  const today = new Date(now);
  const monday = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 10),
  );
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  if (now - monday.getTime() > 84 * HOUR) monday.setUTCDate(monday.getUTCDate() + 7);
  return monday;
})();
const today = () => toIsoDate(parseBusinessDate(ctx.clock.now().toISOString().slice(0, 10)));
const plus = (days: number) => toIsoDate(addDays(parseBusinessDate(today()), days));
const at = (hours: number) => ctx.clock.set(new Date(START.getTime() + hours * HOUR));

let phoneSeq = 0;
const newPhone = () => `+2332008${String((phoneSeq += 1)).padStart(5, '0')}`;
let unitSeq = 0;
const nextUnit = () => units[unitSeq++]!;

async function tenantWith(options: { consent?: boolean } = {}) {
  const phone = newPhone();
  const { tenant } = await s.tenants.create(managerOne, {
    kind: 'individual',
    displayName: `Tenant ${phone.slice(-4)}`,
    phone,
    consent: options.consent === false ? {} : { sms: true },
  });
  return { tenantId: tenant.id, phone, name: tenant.displayName };
}

/** A paper lease, with or without the e-service clause and with any co-tenant parties. */
async function leased(
  options: {
    clause?: boolean;
    consent?: boolean;
    coTenants?: { name: string; phone: string }[];
    unitId?: string;
  } = {},
) {
  const t = await tenantWith(options);
  const contacts: { id: string; phone: string }[] = [];
  for (const c of options.coTenants ?? []) {
    const contact = await s.tenants.addContact(managerOne, t.tenantId, {
      kind: 'next_of_kin',
      name: c.name,
      phone: c.phone,
      consent: { sms: true },
    });
    contacts.push({ id: contact.id, phone: c.phone });
  }
  const start = plus(-60);
  const lease = await s.leases.recordPaper(managerOne, {
    unitId: options.unitId ?? nextUnit(),
    tenantId: t.tenantId,
    startDate: start,
    endDate: toIsoDate(addDays(parseBusinessDate(start), 364)),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
    parties: [
      { role: 'tenant', name: t.name },
      ...(options.coTenants ?? []).map((c, i) => ({
        role: 'tenant' as const,
        name: c.name,
        tenantContactId: contacts[i]!.id,
      })),
    ],
    scanUploadId: await uploadLeaseFile(ctx, s, managerOne),
    signedOn: start,
    ...(options.clause === false
      ? { servicePhones: [], serviceEmails: [] }
      : { servicePhones: [t.phone, ...contacts.map((c) => c.phone)] }),
  });
  return { ...t, leaseId: lease.id, unitId: lease.unit.id, contacts };
}

/** A lease billed from two months ago: its first invoices are overdue (review M2). */
async function owing() {
  const t = await tenantWith();
  const start = toIsoDate(addMonths(parseBusinessDate(today()), -2));
  const lease = await billedLease(ctx, s, b, managerOne, {
    unitId: nextUnit(),
    tenantId: t.tenantId,
    startDate: start,
    endDate: toIsoDate(addDays(addMonths(parseBusinessDate(start), 12), -1)),
    monthlyRentMinor: 120_000,
    cycle: 'monthly',
    signedOn: start,
    billingStartDate: start,
  });
  return { ...t, leaseId: lease.id, unitId: lease.unit.id };
}

/** A rent demand drafted from the ledger's arrears, as the composer suggests it. */
async function demandDraft(leaseId: string) {
  const check = await n.notices.compose(managerOne, { type: 'rent_demand', leaseId });
  return n.notices.create(managerOne, {
    type: 'rent_demand',
    leaseId,
    fields: check.prefill.suggestedFields,
  });
}

const breach = (leaseId: string, by = managerOne) =>
  n.notices.create(by, {
    type: 'breach',
    subtype: 'noise',
    leaseId,
    fields: { particulars: 'Loud music after midnight', remedyBy: plus(10) },
  });

async function issued(leaseId: string) {
  const draft = await breach(leaseId);
  await n.notices.issue(managerOne, draft.id);
  await worker.run(agencyId);
  return n.notices.get(managerOne, draft.id);
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

/** The notice link last texted to a phone. */
const linkTo = (phone: string) =>
  tokenIn(
    [...s.sms.sent].reverse().find((x) => x.to === phone && /\/l\//.test(x.body))?.body ?? '',
  );

const sys = (companyId = agencyId) => ({ companyId, actorKind: 'system' as const });

beforeAll(async () => {
  ctx = await startServerTest();
  ctx.clock.set(START);
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  n = noticesServices(ctx, s, b);
  m = messagingServices(ctx, s, b);
  renderer = await PdfRenderer.launch({ poolSize: 1 });
  worker = new NoticesWorker(ctx, s, n, (html) => renderer.render(html));
  agencyId = await company(ctx, 'agency', 'Review Agency');
  otherId = await company(ctx, 'landlord', 'Review Landlord');
  admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  managerOne = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Manager One');
  managerTwo = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Manager Two');
  accountant = await staffIn(ctx, agencyId, 'agency', 'accountant', 'Accountant');
  other = await staffIn(ctx, otherId, 'landlord', 'owner', 'Other Landlord');
  ownerId = (await s.owners.create(admin, { kind: 'individual', displayName: 'Owner' })).id;
  const property = await propertyWithUnits(s, managerOne, {
    areaCode: 'ACC',
    propertyPart: 'REV',
    ownerId,
    units: [{ unitType: 'apartment', count: 90, bedrooms: 2 }],
  });
  propertyId = property.propertyId;
  units = Object.values(property.units);
  caretaker = await staffIn(ctx, agencyId, 'agency', 'caretaker', 'Kojo', {
    properties: [propertyId],
  });
  await n.acks.grantQuit(admin, { statementVersion: CURRENT_QUIT_ACK, typedName: 'Admin Person' });
}, 180_000);

afterAll(async () => {
  await renderer?.close();
  await ctx?.close();
});

describe('M7 review M1: lease signing never reads a notice’s requests', () => {
  it('keeps a notice served under a lease off that lease’s signing panel and signed copy', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    await acknowledge(linkTo(lease.phone), lease.phone);
    await worker.run(agencyId);
    expect((await n.notices.get(managerOne, notice.id)).document.signedSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    await withCompany(ctx.database, sys(), async (tx) => {
      expect(await s.esign.progressForLease(tx, lease.leaseId)).toBeNull();
      expect(await s.esign.leaseDocumentId(tx, lease.leaseId, 'signed')).toBeNull();
      expect(await s.esign.openRequestFor(tx, lease.leaseId)).toBeNull();
    });
  });
});

describe('M7 review M2: what a notice says about money and the lease matches the records', () => {
  it('★ issues a rent demand only for real, open, overdue invoices, for what the ledger says', async () => {
    const lease = await owing();
    const check = await n.notices.compose(managerOne, {
      type: 'rent_demand',
      leaseId: lease.leaseId,
    });
    const arrears = check.prefill.arrears!;
    expect(arrears.invoices.length).toBeGreaterThan(0);
    expect(arrears.amountMinor).toBe(
      arrears.invoices.reduce((sum, i) => sum + i.outstandingMinor, 0),
    );
    expect(arrears.asOf).toBe(today());
    const typed = await n.notices.create(managerOne, {
      type: 'rent_demand',
      leaseId: lease.leaseId,
      fields: { ...check.prefill.suggestedFields, invoiceIds: ['not-an-invoice'] },
    });
    await expect(n.notices.issue(managerOne, typed.id)).rejects.toMatchObject({
      status: 409,
      code: 'notice_arrears_invoice_unknown',
    });
    const more = await n.notices.create(managerOne, {
      type: 'rent_demand',
      leaseId: lease.leaseId,
      fields: { ...check.prefill.suggestedFields, arrearsMinor: arrears.amountMinor + 1 },
    });
    await expect(n.notices.submit(managerOne, more.id)).rejects.toMatchObject({
      status: 409,
      code: 'notice_arrears_mismatch',
    });
    const right = await demandDraft(lease.leaseId);
    expect(right.blockers).toEqual([]);
    await n.notices.issue(managerOne, right.id);
    expect((await n.notices.get(managerOne, right.id)).status).toBe('sent');
  });

  it('refuses a rent review whose current rent, or a non-renewal whose end date, is not the lease’s', async () => {
    const lease = await leased();
    const review = await n.notices.create(managerOne, {
      type: 'rent_review',
      leaseId: lease.leaseId,
      fields: {
        currentRentMinor: 140_000,
        newRentMinor: 165_000,
        effectiveDate: plus(40),
        reason: 'Annual review',
      },
    });
    await expect(n.notices.issue(managerOne, review.id)).rejects.toMatchObject({
      code: 'notice_current_rent_mismatch',
    });
    const suggested = await n.notices.compose(managerOne, {
      type: 'rent_review',
      leaseId: lease.leaseId,
    });
    expect(suggested.prefill.suggestedFields).toMatchObject({ currentRentMinor: 150_000 });
    const ending = await n.notices.create(managerOne, {
      type: 'non_renewal',
      leaseId: lease.leaseId,
      fields: { leaseEndDate: plus(100), effectiveDate: plus(330) },
    });
    await expect(n.notices.issue(managerOne, ending.id)).rejects.toMatchObject({
      code: 'notice_lease_end_mismatch',
    });
  });
});

describe('M7 review M3: a close right after the last signature keeps the acknowledgement', () => {
  it('★ finalises the request its rule already counts as complete, and the hashes verify', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    await acknowledge(linkTo(lease.phone), lease.phone);
    // Closed before the worker finalises the signature.
    await n.notices.close(managerOne, notice.id, 'complied', 'The tenant complied');
    await worker.run(agencyId);
    const closed = await n.notices.get(managerOne, notice.id);
    expect(closed).toMatchObject({ status: 'closed', outcome: 'complied' });
    expect(closed.document.signedSha256).toMatch(/^[0-9a-f]{64}$/);
    const [request] = await withCompany(ctx.database, sys(), (tx) =>
      s.esign.noticeRequests(tx, notice.id),
    );
    expect(request!.request.status).toBe('completed');
    expect(await s.esign.verify(agencyId, request!.request.id)).toEqual({
      frozen: true,
      signed: true,
      audited: true,
    });
  });
});

describe('M7 review MF-4: co-tenants are served and acknowledge for themselves', () => {
  it('★ serves each tenant party with a ladder of their own, and is signed only when every one has signed', async () => {
    const coPhone = newPhone();
    const lease = await leased({ coTenants: [{ name: 'Kwabena Co-Tenant', phone: coPhone }] });
    const notice = await issued(lease.leaseId);
    expect(notice.recipients.map((r) => [r.kind, r.name])).toEqual([
      ['tenant', lease.name],
      ['co_tenant', 'Kwabena Co-Tenant'],
    ]);
    expect(notice.recipients.every((r) => r.channels.some((c) => c.mode === 'service'))).toBe(true);
    const requests = await withCompany(ctx.database, sys(), (tx) =>
      s.esign.noticeRequests(tx, notice.id),
    );
    expect(requests).toHaveLength(2);

    await acknowledge(linkTo(lease.phone), lease.phone);
    await worker.run(agencyId);
    const half = await n.notices.get(managerOne, notice.id);
    expect(half.status).not.toBe('signed');
    expect(half.recipients.map((r) => r.acknowledged)).toEqual([true, false]);
    try {
      at(25);
      const before = s.sms.sent.filter((x) => x.to === coPhone).length;
      const tenantBefore = s.sms.sent.filter((x) => x.to === lease.phone).length;
      await n.tracking.runLadder(agencyId);
      await worker.run(agencyId);
      expect(s.sms.sent.filter((x) => x.to === coPhone).length).toBe(before + 1);
      expect(s.sms.sent.filter((x) => x.to === lease.phone).length).toBe(tenantBefore);
    } finally {
      ctx.clock.set(START);
    }
    await acknowledge(linkTo(coPhone), coPhone);
    await worker.run(agencyId);
    expect((await n.notices.get(managerOne, notice.id)).status).toBe('signed');
  });
});

describe('M7 review MF-5: a building-wide notice names no tenant', () => {
  it('addresses the occupants and leaves out every recipient’s name (Act 843)', async () => {
    const one = await leased();
    const two = await leased();
    const draft = await n.notices.create(managerOne, {
      type: 'building_wide',
      subtype: 'fire_safety',
      propertyId,
      fields: {
        propertyId,
        title: 'Fire drill',
        particulars: 'Gather at the car park when the alarm sounds.',
        startDate: plus(5),
      },
    });
    await n.notices.issue(managerOne, draft.id);
    await worker.run(agencyId);
    const { html } = await n.notices.preview(managerOne, draft.id);
    expect(html).toContain('The occupants of');
    expect(html).not.toContain(one.name);
    expect(html).not.toContain(two.name);
    const [render] = await withCompany(ctx.database, sys(), async (tx) => {
      const notice = await tx
        .select({ renderRequestId: schema.notice.renderRequestId })
        .from(schema.notice)
        .where(sql`${schema.notice.id} = ${draft.id}`);
      return tx
        .select({ data: schema.documentRenderRequest.data })
        .from(schema.documentRenderRequest)
        .where(sql`${schema.documentRenderRequest.id} = ${notice[0]!.renderRequestId}`);
    });
    expect(JSON.stringify(render!.data)).not.toContain(one.name);
  });
});

describe('M7 review MF-6: a reminder is recorded as sent only when it was', () => {
  it('records "reminder not sent" for a recipient no channel can reach, and the status stays sent', async () => {
    const lease = await leased({ clause: false, consent: false });
    const notice = await issued(lease.leaseId);
    expect(notice.recipients[0]!.channels.every((c) => c.mode === 'withheld')).toBe(true);
    try {
      at(25);
      await n.tracking.runLadder(agencyId);
    } finally {
      ctx.clock.set(START);
    }
    const after = await n.notices.get(managerOne, notice.id);
    expect(after.events.map((e) => e.kind)).toContain('reminder_not_sent');
    expect(after.events.map((e) => e.kind)).not.toContain('reminded');
    expect(after.status).toBe('sent');
  });
});

describe('M7 review MF-7 and D-A: the tenant timeline', () => {
  it('★ shows every status change of a notice, the steps before issue and the ladder’s controls included', async () => {
    const lease = await leased();
    const draft = await n.notices.create(accountant, {
      type: 'rent_review',
      leaseId: lease.leaseId,
      fields: {
        currentRentMinor: 150_000,
        newRentMinor: 165_000,
        effectiveDate: plus(40),
        reason: 'Annual review',
      },
    });
    await n.notices.submit(accountant, draft.id);
    await n.notices.returnToDraft(accountant, draft.id);
    const submitted = await n.notices.submit(accountant, draft.id);
    await s.approvals.decide(managerOne, submitted.approvalRequestId!, { decision: 'approve' });
    await worker.run(agencyId);
    await s.signingPage.open(linkTo(lease.phone), PHONE);
    await worker.run(agencyId);
    try {
      at(25);
      await n.tracking.runLadder(agencyId);
      await worker.run(agencyId);
      await n.notices.controlLadder(managerOne, draft.id, 'pause', 'Tenant travelling');
      at(30);
      await n.notices.controlLadder(managerOne, draft.id, 'resume', 'Back home');
      at(31);
      await n.notices.recordService(caretaker, draft.id, {
        method: 'handed_to_tenant',
        servedAt: ctx.clock.now().toISOString(),
        servedByName: 'Kojo Caretaker',
      });
      await acknowledge(linkTo(lease.phone), lease.phone);
      await worker.run(agencyId);
      await n.notices.close(managerOne, draft.id, 'complied', 'Agreed the new rent');
    } finally {
      ctx.clock.set(START);
    }
    const discarded = await breach(lease.leaseId);
    await n.notices.discard(managerOne, discarded.id);
    const actions = new Set(
      (await s.tenants.timeline(managerOne, lease.tenantId))
        .filter((e) => e.action.startsWith('notice.'))
        .map((e) => e.action),
    );
    for (const kind of [
      'submitted',
      'returned_to_draft',
      'approved',
      'sent',
      'opened',
      'reminded',
      'ladder_paused',
      'ladder_resumed',
      'served',
      'signed',
      'closed',
      'cancelled',
    ])
      expect(actions.has(`notice.${kind}`), kind).toBe(true);
  });

  it('shows the rest of the kinds: delivered, escalated, the ladder cancelled and a notice received', async () => {
    // On a property of its own, so the building-wide notices of the other tests go to no one new.
    const own = await propertyWithUnits(s, managerOne, {
      areaCode: 'ACC',
      propertyPart: 'RVK',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const lease = await leased({ unitId: Object.values(own.units)[0]! });
    const notice = await issued(lease.leaseId);
    const sent = [...s.sms.sent].reverse().find((x) => x.to === lease.phone)!;
    await receive(
      ctx,
      m,
      'sms_status',
      JSON.stringify({
        messageId: sent.providerMessageId,
        status: 'Delivered',
        updateTime: ctx.clock.now().toISOString(),
      }),
    );
    await worker.run(agencyId);
    try {
      at(168);
      await n.tracking.runLadder(agencyId);
      await worker.run(agencyId);
    } finally {
      ctx.clock.set(START);
    }
    const second = await issued(lease.leaseId);
    await n.notices.controlLadder(managerOne, second.id, 'cancel', 'Settled at the office');
    const upload = await n.notices.createUpload(managerOne, {
      purpose: 'received_notice',
      contentType: 'application/pdf',
      sizeBytes: SAMPLE_PDF.length,
    });
    await ctx.storage.put({
      bucket: ctx.config.S3_BUCKET_FILES,
      key: upload.fields.key!,
      body: SAMPLE_PDF,
      contentType: 'application/pdf',
    });
    await n.notices.recordReceived(managerOne, {
      leaseId: lease.leaseId,
      subtype: 'intention_to_vacate',
      receivedOn: today(),
      receivedVia: 'in_person',
      uploadId: upload.uploadId,
    });
    expect((await n.notices.get(managerOne, notice.id)).status).toBe('escalated');
    const actions = new Set(
      (await s.tenants.timeline(managerOne, lease.tenantId)).map((e) => e.action),
    );
    for (const kind of ['delivered', 'escalated', 'ladder_cancelled', 'received'])
      expect(actions.has(`notice.${kind}`), kind).toBe(true);
  });

  it('puts a building-wide notice’s events on every recipient’s timeline', async () => {
    const one = await leased();
    const two = await leased();
    const draft = await n.notices.create(managerOne, {
      type: 'building_wide',
      subtype: 'major_works',
      propertyId,
      fields: {
        propertyId,
        title: 'Water off',
        particulars: 'The water is off on Saturday morning.',
        startDate: plus(3),
      },
    });
    await n.notices.issue(managerOne, draft.id);
    await worker.run(agencyId);
    await n.notices.close(managerOne, draft.id, 'complied', 'Works done');
    for (const tenantId of [one.tenantId, two.tenantId]) {
      const mine = (await s.tenants.timeline(managerOne, tenantId)).filter(
        (e) => e.recordId === draft.id,
      );
      expect(mine.map((e) => e.action)).toEqual(
        expect.arrayContaining(['notice.sent', 'notice.closed']),
      );
    }
  });
});

describe('M7 review MF-8: service recorded after a notice closes', () => {
  it('keeps the record and its late-service flag on a closed notice, with no error', async () => {
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
    await n.notices.close(managerOne, draft.id, 'withdrawn', 'Served too late, will reissue');
    try {
      at(5 * 24);
      await n.notices.recordService(managerOne, draft.id, {
        method: 'handed_to_tenant',
        servedAt: ctx.clock.now().toISOString(),
        servedByName: 'Kojo Caretaker',
      });
    } finally {
      ctx.clock.set(START);
    }
    const closed = await n.notices.get(managerOne, draft.id);
    expect(closed.status).toBe('closed');
    expect(closed.serviceRecords).toHaveLength(1);
    expect(closed.servedTooLate).toBe(true);
    expect(noticeCheckConflict({ code: 'RA070' })).toMatchObject({
      status: 409,
      code: 'notice_frozen',
    });
  });
});

describe('M7 review S3 and S4 (D-B): pause and resume', () => {
  it('moves the remaining steps on by the time paused, so a resume fires nothing overdue', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    const fired = async () =>
      (await n.notices.get(managerOne, notice.id)).events.filter((e) => e.kind === 'reminded')
        .length;
    try {
      at(2);
      await n.notices.controlLadder(managerOne, notice.id, 'pause', 'Tenant in hospital');
      at(26);
      await n.notices.controlLadder(managerOne, notice.id, 'resume', 'Tenant home');
      // Reminder 1 was 22 hours away at the pause, so it falls due 22 hours after the resume.
      at(27);
      await n.tracking.runLadder(agencyId);
      expect(await fired()).toBe(0);
      at(48);
      await n.tracking.runLadder(agencyId);
      expect(await fired()).toBe(1);
      const detail = await n.notices.get(managerOne, notice.id);
      expect(detail.ladder.steps.find((x) => x.key === 'reminder_1')!.dueAt).toEqual(
        new Date(START.getTime() + 48 * HOUR),
      );
    } finally {
      ctx.clock.set(START);
    }
  });

  it('never escalates a cancelled ladder, and escalates a paused one when it resumes', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    try {
      at(168);
      await n.tracking.runLadder(agencyId);
      // The escalation was asked for; the ladder is paused before the job runs.
      await n.notices.controlLadder(managerOne, notice.id, 'pause', 'Talking to the tenant');
      await worker.run(agencyId);
      expect((await n.notices.get(managerOne, notice.id)).status).not.toBe('escalated');
      await n.notices.controlLadder(managerOne, notice.id, 'resume', 'No agreement');
      await worker.run(agencyId);
      expect((await n.notices.get(managerOne, notice.id)).status).toBe('escalated');

      const second = await issued((await leased()).leaseId);
      at(168 + 168);
      await n.tracking.runLadder(agencyId);
      await n.notices.controlLadder(managerOne, second.id, 'cancel', 'Paid in full');
      await worker.run(agencyId);
      expect((await n.notices.get(managerOne, second.id)).status).not.toBe('escalated');
    } finally {
      ctx.clock.set(START);
    }
  });
});

describe('M7 review S5 and S11: going back to draft', () => {
  it('answers a named 409 when someone else cannot take a notice back', async () => {
    const lease = await leased();
    const draft = await breach(lease.leaseId, accountant);
    await n.notices.submit(accountant, draft.id);
    await expect(n.notices.returnToDraft(managerOne, draft.id)).rejects.toMatchObject({
      status: 409,
      code: 'notice_return_refused',
    });
    expect((await n.notices.get(managerOne, draft.id)).status).toBe('pending_approval');
  });

  it('returns a rejected notice to draft once, with its reason, and keeps the last approval', async () => {
    const lease = await leased();
    const draft = await breach(lease.leaseId, accountant);
    const submitted = await n.notices.submit(accountant, draft.id);
    await s.approvals.decide(managerOne, submitted.approvalRequestId!, {
      decision: 'reject',
      reason: 'Wrong tenant',
    });
    await n.tracking.runLadder(agencyId);
    await n.notices.update(accountant, draft.id, {});
    await n.tracking.runLadder(agencyId);
    const back = await n.notices.get(managerOne, draft.id);
    expect(back.status).toBe('draft');
    expect(back.events.filter((e) => e.kind === 'returned_to_draft')).toHaveLength(1);
    expect(back.returnedReason).toMatchObject({ code: 'approval.rejected' });
    expect(back.lastApproval).toMatchObject({
      id: submitted.approvalRequestId,
      actionType: 'notice.issue',
      status: 'rejected',
      decidedByName: 'Manager One',
    });
    expect(back.approval).toBeNull();
  });
});

describe('M7 review S6 and S10: corrections', () => {
  it('allows one live correction, and refuses to issue one whose original has closed', async () => {
    const lease = await leased();
    const original = await issued(lease.leaseId);
    const correction = await n.notices.correct(managerOne, original.id);
    await expect(n.notices.correct(managerOne, original.id)).rejects.toMatchObject({
      status: 409,
      code: 'notice_correction_open',
    });
    await n.notices.close(managerOne, original.id, 'withdrawn', 'Dealt with by phone');
    await expect(n.notices.issue(managerOne, correction.id)).rejects.toMatchObject({
      code: 'notice_correction_original_closed',
    });
    await n.notices.discard(managerOne, correction.id);
  });

  it('★ stops the old notice’s ladder once corrected, and its link opens read-only', async () => {
    const lease = await leased();
    const original = await issued(lease.leaseId);
    const oldLink = linkTo(lease.phone);
    const correction = await n.notices.correct(managerOne, original.id);
    await n.notices.issue(managerOne, correction.id);
    await worker.run(agencyId);
    const page = await s.signingPage.open(oldLink, PHONE);
    expect(page.screen).not.toBe('sign');
    try {
      at(25);
      await n.tracking.runLadder(agencyId);
      await worker.run(agencyId);
    } finally {
      ctx.clock.set(START);
    }
    const old = await n.notices.get(managerOne, original.id);
    expect(old.events.map((e) => e.kind)).not.toContain('reminded');
    expect((await n.notices.get(managerOne, correction.id)).events.map((e) => e.kind)).toContain(
      'reminded',
    );
  });
});

describe('M7 review S7 and S8: escalation', () => {
  it('does not escalate a notice already served in person, and alerts the property’s managers', async () => {
    const lease = await leased();
    const draft = await breach(lease.leaseId, accountant);
    const submitted = await n.notices.submit(accountant, draft.id);
    await s.approvals.decide(managerTwo, submitted.approvalRequestId!, { decision: 'approve' });
    await worker.run(agencyId);
    try {
      at(120);
      const before = s.email.sent.length;
      await n.tracking.runLadder(agencyId);
      await worker.run(agencyId);
      const alerts = s.email.sent
        .slice(before)
        .filter((x) => /Not yet acknowledged/.test(x.subject ?? ''));
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.every((x) => x.to !== accountantEmail)).toBe(true);
      at(130);
      await n.notices.recordService(caretaker, draft.id, {
        method: 'handed_to_tenant',
        servedAt: ctx.clock.now().toISOString(),
        servedByName: 'Kojo Caretaker',
      });
      at(168);
      await n.tracking.runLadder(agencyId);
      await worker.run(agencyId);
    } finally {
      ctx.clock.set(START);
    }
    const served = await n.notices.get(managerOne, draft.id);
    expect(served.status).toBe('served');
    expect(served.document.servicePackReady).toBe(false);
  });

  it('makes no second physical-service task at escalation when one is open', async () => {
    const lease = await leased({ clause: false });
    const notice = await issued(lease.leaseId);
    try {
      at(168);
      await n.tracking.runLadder(agencyId);
      await worker.run(agencyId);
    } finally {
      ctx.clock.set(START);
    }
    const escalated = await n.notices.get(managerOne, notice.id);
    expect(escalated.status).toBe('escalated');
    expect(
      escalated.tasks.filter((t) => t.kind === 'notice_physical_service' && t.status === 'open'),
    ).toHaveLength(1);
  });
});

let accountantEmail = '';

describe('M7 review C4 and S10: Rent Officer assessments', () => {
  it('corrects and voids an assessment by new records, refuses a future date, and bars only from active ones', async () => {
    const lease = await leased();
    await expect(
      n.acks.recordAssessment(managerOne, lease.unitId, {
        assessedOn: plus(1),
        reference: 'RO/FUTURE',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'assessed_on_future' });
    const first = await n.acks.recordAssessment(managerOne, lease.unitId, {
      assessedOn: plus(-100),
      reference: 'RO/ACC/1',
    });
    const corrected = await n.acks.correctAssessment(managerOne, lease.unitId, first.id, {
      assessedOn: plus(-900),
      reference: 'RO/ACC/1A',
      reason: 'The date was typed wrong',
    });
    expect(corrected).toMatchObject({ replacesId: first.id, status: 'active' });
    await expect(
      n.acks.voidAssessment(managerOne, lease.unitId, first.id, 'Mistake'),
    ).rejects.toMatchObject({ code: 'assessment_changed' });
    const list = await n.acks.assessments(managerOne, lease.unitId);
    expect(list.assessments.find((a) => a.id === first.id)).toMatchObject({
      status: 'corrected',
      replacedById: corrected.id,
    });
    // 900 days ago is more than 24 months: the bar has ended.
    expect(list.bar).toMatchObject({ active: false });
    const check = async () =>
      (
        await n.notices.compose(managerOne, {
          type: 'notice_to_quit',
          subtype: 'arrears',
          leaseId: lease.leaseId,
          fields: { particulars: 'Rent unpaid', effectiveDate: plus(60) },
        })
      ).quitBar;
    expect(await check()).toMatchObject({ barred: false });
    const recent = await n.acks.recordAssessment(managerOne, lease.unitId, {
      assessedOn: plus(-30),
      reference: 'RO/ACC/2',
    });
    expect(await check()).toMatchObject({ barred: true });
    const voided = await n.acks.voidAssessment(
      managerOne,
      lease.unitId,
      recent.id,
      'Recorded on the wrong unit',
    );
    expect(voided).toMatchObject({
      status: 'voided',
      voided: { reason: 'Recorded on the wrong unit' },
    });
    expect(await check()).toMatchObject({ barred: false });
    expect((await n.acks.assessments(managerOne, lease.unitId)).assessments).toHaveLength(3);
  });
});

describe('M7 review data S8 and S9: the signed acknowledgement', () => {
  it('gives an ordinary link the frozen notice, never the certificate', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    const token = linkTo(lease.phone);
    await acknowledge(token, lease.phone);
    await worker.run(agencyId);
    const url = await s.signingPage.documentUrl(token, PHONE);
    const detail = await n.notices.get(managerOne, notice.id);
    const body = (await ctx.storage.openDownload(url)).body;
    expect(createHash('sha256').update(body).digest('hex')).toBe(detail.document.sha256);
    expect(detail.document.signedSha256).not.toBe(detail.document.sha256);
  });

  it('certifies acknowledged receipt, with the typed name, both clocks and the hashes', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    await acknowledge(linkTo(lease.phone), lease.phone);
    await worker.run(agencyId);
    const [request] = await withCompany(ctx.database, sys(), (tx) =>
      s.esign.noticeRequests(tx, notice.id),
    );
    const [doc] = await withCompany(ctx.database, sys(), (tx) =>
      tx
        .select({
          templateKey: schema.document.templateKey,
          templateVersion: schema.document.templateVersion,
          data: schema.document.dataSnapshot,
        })
        .from(schema.document)
        .where(sql`${schema.document.id} = ${request!.request.finalDocumentId}`),
    );
    expect(doc).toMatchObject({ templateKey: 'esign.certificate', templateVersion: 2 });
    expect(doc!.data).toMatchObject({
      subject: 'notice',
      documentSha256: notice.document.sha256,
      timeZone: 'Africa/Accra',
      signers: [
        {
          method: 'typed',
          typedName: 'Tenant Name',
          documentSha256: notice.document.sha256,
          consentVersion: CURRENT_NOTICE_CONSENT,
        },
      ],
    });
  });
});

describe('M7 review data S11: notice numbers under concurrent issue', () => {
  it('★ numbers notices issued at the same moment without a gap or a repeat', async () => {
    const drafts = [];
    for (let i = 0; i < 6; i += 1) drafts.push(await breach((await leased()).leaseId));
    await Promise.all(drafts.map((d) => n.notices.issue(managerOne, d.id)));
    const numbers = (await Promise.all(drafts.map((d) => n.notices.get(managerOne, d.id)))).map(
      (d) => Number(d.number!.slice(2)),
    );
    numbers.sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(6);
    expect(numbers.at(-1)! - numbers[0]!).toBe(5);
  });
});

describe('M7 review data S12 and notes', () => {
  it('flags late service from the period frozen at issue, not the lease’s values now', async () => {
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
    await asSuperuser(ctx, 'update lease set notice_days = 0 where id = $1', [lease.leaseId]);
    try {
      at(5 * 24);
      await n.notices.recordService(managerOne, draft.id, {
        method: 'handed_to_tenant',
        servedAt: ctx.clock.now().toISOString(),
        servedByName: 'Kojo Caretaker',
      });
    } finally {
      ctx.clock.set(START);
    }
    expect((await n.notices.get(managerOne, draft.id)).servedTooLateDetail).toMatchObject({
      shortByDays: 5,
    });
  });

  it('records the approver on the approved and sent events', async () => {
    const lease = await leased();
    const draft = await breach(lease.leaseId, accountant);
    const submitted = await n.notices.submit(accountant, draft.id);
    await s.approvals.decide(managerTwo, submitted.approvalRequestId!, { decision: 'approve' });
    const events = (await n.notices.get(managerOne, draft.id)).events;
    expect(events.find((e) => e.kind === 'approved')?.actorName).toBe('Manager Two');
    expect(events.find((e) => e.kind === 'sent')?.actorName).toBe('Manager Two');
  });

  it('warns on a notice to quit under a 0-day lease and with no assessment on record', async () => {
    const lease = await leased();
    await asSuperuser(ctx, 'update lease set notice_days = 0 where id = $1', [lease.leaseId]);
    const check = await n.notices.compose(managerOne, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: lease.leaseId,
      fields: { particulars: 'Rent unpaid', effectiveDate: plus(60) },
    });
    expect(check.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['lease_notice_days_zero', 'no_assessment_on_record']),
    );
  });

  it('runs every other notice’s ladder when one notice fails', async () => {
    const broken = await issued((await leased()).leaseId);
    const healthy = await issued((await leased()).leaseId);
    await asSuperuser(ctx, `update notice_recipient set channels = '{}' where notice_id = $1`, [
      broken.id,
    ]);
    try {
      at(25);
      await expect(n.tracking.runLadder(agencyId)).rejects.toThrow(/failed for 1 of/);
    } finally {
      ctx.clock.set(START);
      // Closed, so the broken notice leaves the later tests' ladders alone.
      await n.notices.close(managerOne, broken.id, 'withdrawn', 'Test notice');
    }
    expect((await n.notices.get(managerOne, healthy.id)).events.map((e) => e.kind)).toContain(
      'reminded',
    );
  });
});

describe('M7 review: tests beside the weak ones', () => {
  it('LN-03: records delivery reported through the SMS provider’s webhook, with its channel', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    const sent = [...s.sms.sent].reverse().find((x) => x.to === lease.phone)!;
    // The gateway's own report (Hubtel's shape), as the webhook receives it.
    const raw = JSON.stringify({
      messageId: sent.providerMessageId,
      status: 'Delivered',
      updateTime: ctx.clock.now().toISOString(),
    });
    expect((await receive(ctx, m, 'sms_status', raw)).stored).toBe('stored');
    await worker.run(agencyId);
    const delivered = await n.notices.get(managerOne, notice.id);
    expect(delivered.recipients[0]).toMatchObject({ deliveredVia: 'sms' });
    expect(delivered.status).toBe('delivered');
  });

  it('LN-07: the second signatory’s own link is closed once the company has acknowledged', async () => {
    const [first, second] = [newPhone(), newPhone()];
    const { tenant } = await s.tenants.create(managerOne, {
      kind: 'company',
      displayName: 'Review Ltd',
      legalName: 'Review Limited',
    });
    for (const [name, phone] of [
      ['Director A', first],
      ['Director B', second],
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
      parties: [{ role: 'tenant', name: 'Review Limited' }],
      scanUploadId: await uploadLeaseFile(ctx, s, managerOne),
      signedOn: start,
      servicePhones: [first, second],
      serviceEmails: [],
    });
    const notice = await issued(lease.id);
    const secondLink = linkTo(second);
    await acknowledge(linkTo(first), first);
    await worker.run(agencyId);
    const page = await s.signingPage.open(secondLink, PHONE);
    // Acknowledged for the company and finalised: closed, never signable again.
    expect(page).toMatchObject({ screen: 'closed', reason: 'completed' });
    await expect(s.signingPage.sendCode(secondLink, PHONE)).rejects.toMatchObject({
      status: 409,
    });
    expect((await n.notices.get(managerOne, notice.id)).status).toBe('signed');
  });

  it('CF-06: gives the day-5 task to a manager when the property has no caretaker', async () => {
    const bare = await propertyWithUnits(s, managerOne, {
      areaCode: 'ACC',
      propertyPart: 'RVB',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const lease = await leased({ unitId: Object.values(bare.units)[0]! });
    const notice = await issued(lease.leaseId);
    try {
      at(120);
      await n.tracking.runLadder(agencyId);
    } finally {
      ctx.clock.set(START);
    }
    const task = (await n.notices.get(managerOne, notice.id)).tasks.find(
      (t) => t.kind === 'notice_in_person_reminder',
    );
    expect(task?.assignee?.name).toBe('Manager One');
    expect(task).toMatchObject({ mayCancel: true });
    const kojo = await n.tasks.list(caretaker, {});
    expect(kojo.map((t) => t.id)).not.toContain(task!.id);
  });

  it('LN-05: runs staff steps outside the sending window, and holds tenant reminders', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    try {
      // 22:00 in Accra on day 5: the window is shut.
      at(120 + 12);
      await n.tracking.runLadder(agencyId);
    } finally {
      ctx.clock.set(START);
    }
    const kinds = (await n.notices.get(managerOne, notice.id)).events.map((e) => [
      e.kind,
      e.data?.step,
    ]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['manager_alerted', 'manager_alert'],
        ['task_created', 'caretaker_task'],
      ]),
    );
    expect(kinds.filter(([k]) => k === 'reminded')).toEqual([]);
  });

  it('LN-09: counts and filters the dashboard', async () => {
    const lease = await leased();
    const notice = await issued(lease.leaseId);
    const draft = await breach(lease.leaseId);
    const summary = await n.notices.summary(managerOne);
    expect(summary.drafts).toBeGreaterThan(0);
    expect(summary.byStatus.find((x) => x.status === 'sent')?.count).toBeGreaterThan(0);
    const byLease = await n.notices.list(managerOne, { leaseId: lease.leaseId });
    expect(byLease.map((x) => x.id)).toEqual(expect.arrayContaining([notice.id, draft.id]));
    const sentOnly = await n.notices.list(managerOne, { leaseId: lease.leaseId, status: 'sent' });
    expect(sentOnly.map((x) => x.id)).toEqual([notice.id]);
    const found = await n.notices.list(managerOne, { search: notice.number! });
    expect(found.map((x) => x.id)).toContain(notice.id);
  });

  it('/me/notices: a tenant sees their own notices, a building-wide one, and nobody else’s', async () => {
    const mine = await leased();
    const theirs = await leased();
    const myNotice = await issued(mine.leaseId);
    const theirNotice = await issued(theirs.leaseId);
    const draft = await n.notices.create(managerOne, {
      type: 'building_wide',
      subtype: 'other',
      propertyId,
      fields: { propertyId, title: 'Gate code', particulars: 'New gate code.', startDate: plus(2) },
    });
    await n.notices.issue(managerOne, draft.id);
    await worker.run(agencyId);
    // The same person rents from another landlord, who issues nothing visible here.
    const [row] = await withCompany(ctx.database, sys(), (tx) =>
      tx
        .select({ personId: schema.tenant.personId })
        .from(schema.tenant)
        .where(sql`${schema.tenant.id} = ${mine.tenantId}`),
    );
    const { tenant: elsewhere } = await s.tenants.create(other, {
      kind: 'individual',
      displayName: 'Same Person',
      phone: mine.phone,
    });
    expect(elsewhere.id).not.toBe(mine.tenantId);
    const actor = {
      kind: 'tenant' as const,
      personId: row!.personId!,
      authMethod: 'phone_otp' as const,
    };
    const groups = await n.tenantNotices.notices(actor);
    const ids = groups.flatMap((g) => g.notices.map((x) => x.noticeId));
    expect(ids).toEqual(expect.arrayContaining([myNotice.id, draft.id]));
    expect(ids).not.toContain(theirNotice.id);
    expect(groups.map((g) => g.landlord.companyId)).toEqual([agencyId]);
  });
});

beforeAll(async () => {
  const [row] = await withCompany(ctx.database, sys(), (tx) =>
    tx
      .select({ email: schema.person.email })
      .from(schema.person)
      .where(sql`${schema.person.id} = ${accountant.personId}`),
  );
  accountantEmail = row!.email;
});

describe('LN-04 service time is compared at the minute the form gives (coordinator, 2026-11-05)', () => {
  it('accepts service in the minute the notice was issued, and refuses it before that minute', async () => {
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
    const issuedAt = new Date(START.getTime() + 40_000);
    try {
      ctx.clock.set(issuedAt);
      await n.notices.issue(managerOne, draft.id);
      // Issued at 10:00:40: a minute before is refused, the same minute accepted.
      await expect(
        n.notices.recordService(managerOne, draft.id, {
          method: 'handed_to_tenant',
          servedAt: new Date(START.getTime() - 1_000).toISOString(),
          servedByName: 'Kojo Caretaker',
        }),
      ).rejects.toMatchObject({ code: 'served_before_issue' });
      ctx.clock.set(new Date(issuedAt.getTime() + 5_000));
      await n.notices.recordService(managerOne, draft.id, {
        method: 'handed_to_tenant',
        servedAt: START.toISOString(),
        servedByName: 'Kojo Caretaker',
      });
    } finally {
      ctx.clock.set(START);
    }
    expect((await n.notices.get(managerOne, draft.id)).serviceRecords).toHaveLength(1);
  });
});
