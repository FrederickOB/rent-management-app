import { schema, sql, withCompany } from '@rent/db';
import { sha256Hex, startsWith, verifyFingerprint } from '@rent/documents';
import { PdfRenderer } from '@rent/documents/render';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { CURRENT_CONSENT } from '@rent/domain/esign';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SigningHasher } from '../src/esign/secrets';
import { company, startServerTest, type ServerTestContext } from './support';
import { EsignWorker, PHONE, tokenIn } from './support/esign';
import {
  messagesOf,
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

let ctx: ServerTestContext;
let s: TenancyServices;
let worker: EsignWorker;
let renderer: PdfRenderer;
let agencyId: string;
let manager: Awaited<ReturnType<typeof staffIn>>;
let units: Record<string, string>;
let ownerId: string;
let today: string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const month = (n: number) => toIsoDate(addMonths(parseBusinessDate(today), n));
const endAfter = (from: string, n: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), n), -1));

let phoneSeq = 0;
/** Fresh fake numbers, clear of the demo and other tests' phones. */
const newPhone = () => `+2332007${String((phoneSeq += 1)).padStart(5, '0')}`;

const typed = (code: string, name = 'Signer Name') => ({
  code,
  method: 'typed' as const,
  typedName: name,
  consentVersion: CURRENT_CONSENT,
  consentAccepted: true,
});

/** The last code texted to a phone. */
function codeSentTo(phone: string): string {
  const body = s.sms.lastTo(phone)?.body ?? '';
  const code = /^(\d{6}) is your code/.exec(body)?.[1];
  if (!code) throw new Error(`no code was texted to the signer`);
  return code;
}

/** The last link texted to a phone. */
const linkSentTo = (phone: string) => tokenIn(s.sms.lastTo(phone)?.body);

/** Sends a code to the signer behind a link, and signs with it. */
async function signWith(token: string, phone: string, client = PHONE) {
  await s.signingPage.sendCode(token, client);
  return s.signingPage.sign(token, client, typed(codeSentTo(phone)));
}

interface Issued {
  readonly leaseId: string;
  readonly requestId: string;
  readonly tenantPhone: string;
  readonly guarantorPhone: string;
  readonly witnessPhone: string;
  readonly signers: Record<string, string>;
}

/**
 * A lease with four signers, issued and opened: the tenant and a guarantor (both with SMS
 * consent), the manager for the landlord (staff: email, no consent needed) and a witness with
 * no record (no consent, so staff hand the link over).
 */
async function issued(unitCode: string): Promise<Issued> {
  const tenantPhone = newPhone();
  const guarantorPhone = newPhone();
  const witnessPhone = newPhone();
  const { tenant } = await s.tenants.create(manager, {
    kind: 'individual',
    displayName: `Tenant ${unitCode}`,
    phone: tenantPhone,
    consent: { sms: true },
    contacts: [
      {
        kind: 'guarantor',
        name: `Guarantor ${unitCode}`,
        phone: guarantorPhone,
        consent: { sms: true },
      },
    ],
  });
  const draft = await s.leases.createDraft(manager, {
    unitId: units[unitCode]!,
    tenantId: tenant.id,
    startDate: month(2),
    endDate: endAfter(month(2), 12),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
  });
  // The default parties (tenant, guarantor, the manager for the landlord), plus the witness.
  await s.leases.updateDraft(manager, draft.id, {
    parties: [
      ...draft.parties.map((p) => ({
        role: p.role,
        name: p.name,
        phone: p.phone,
        email: p.email,
        tenantContactId: p.tenantContactId,
        staffPersonId: p.staffPersonId,
      })),
      { role: 'witness', name: `Witness ${unitCode}`, phone: witnessPhone },
    ],
  });
  const pending = await s.leaseSigning.issue(manager, draft.id);
  expect(pending.status).toBe('pending_signatures');
  await worker.run(agencyId);
  const progress = (await s.leaseSigning.progress(manager, draft.id))!;
  expect(progress.status).toBe('pending');
  return {
    leaseId: draft.id,
    requestId: progress.requestId,
    tenantPhone,
    guarantorPhone,
    witnessPhone,
    signers: Object.fromEntries(progress.signers.map((x) => [x.role, x.id])),
  };
}

/** A hand-over link for one signer, as staff would show it (decision 2). */
async function handover(lease: Issued, role: string) {
  const link = await s.leaseSigning.handoverLink(manager, lease.requestId, lease.signers[role]!);
  return tokenIn(link.url);
}

/** The landlord's signer gets an email; their code goes to the email on record too. */
async function signAsLandlord(lease: Issued) {
  const token = await handover(lease, 'landlord');
  await s.signingPage.sendCode(token, PHONE);
  // The test helper gives every person the email <id>@test.invalid.
  const email = `${manager.personId}@test.invalid`;
  const code = /Your code is (\d{6})/.exec(s.email.lastTo(email)?.text ?? '')?.[1];
  if (!code) throw new Error('no code was emailed to the landlord');
  return s.signingPage.sign(token, PHONE, typed(code));
}

async function requestRow(requestId: string) {
  const [row] = await withCompany(
    ctx.database,
    { companyId: agencyId, actorKind: 'system' },
    (tx) =>
      tx
        .select()
        .from(schema.signingRequest)
        .where(sql`${schema.signingRequest.id} = ${requestId}`),
  );
  return row!;
}

async function scheduleRows(leaseId: string): Promise<number> {
  const rows = await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from charge_period where lease_id = ${leaseId}`,
    ),
  );
  return rows.rows[0]!.n;
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  renderer = await PdfRenderer.launch({ poolSize: 1 });
  worker = new EsignWorker(ctx, s, (html) => renderer.render(html));
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agencyId = await company(ctx, 'agency', 'Signing Agency');
  const admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Kofi Manager');
  ownerId = (await s.owners.create(admin, { kind: 'individual', displayName: 'Owner' })).id;
  ({ units } = await propertyWithUnits(s, manager, {
    areaCode: 'ACC',
    propertyPart: 'SGN',
    ownerId,
    units: [{ unitType: 'apartment', count: 16, bedrooms: 2 }],
  }));
}, 120_000);

afterAll(async () => {
  await renderer?.close();
  await ctx?.close();
});

describe('TL-07 lease does not activate with a missing signature', () => {
  it('stays pending, with no signed PDF and no schedule, until the last required signer signs', async () => {
    const lease = await issued('ACC-SGN-B1-01');
    // The tenant and guarantor got their links by SMS; the landlord's signer by email; the
    // witness has no consent on record, so nothing went to them (staff hand the link over).
    expect(s.sms.lastTo(lease.tenantPhone)?.body).toMatch(/\/l\//);
    expect(s.sms.lastTo(lease.guarantorPhone)?.body).toMatch(/\/l\//);
    expect(s.sms.lastTo(lease.witnessPhone)).toBeUndefined();

    await signWith(linkSentTo(lease.tenantPhone), lease.tenantPhone);
    await signWith(linkSentTo(lease.guarantorPhone), lease.guarantorPhone);
    await signAsLandlord(lease);
    await worker.run(agencyId);

    // Three of four: the lease waits, with no signed PDF and no schedule.
    expect((await s.leases.get(manager, lease.leaseId)).status).toBe('pending_signatures');
    const waiting = await requestRow(lease.requestId);
    expect(waiting.status).toBe('pending');
    expect(waiting.finalDocumentId).toBeNull();
    expect(waiting.finalSha256).toBeNull();
    expect(await scheduleRows(lease.leaseId)).toBe(0);
    // Finalising early does nothing.
    expect(await s.esign.finalise(agencyId, lease.requestId, (h) => renderer.render(h))).toBe(
      'skipped',
    );

    // The witness signs through a link staff hand over: now the lease is signed.
    const witnessToken = await handover(lease, 'witness');
    const result = await signWith(witnessToken, lease.witnessPhone);
    expect(result.complete).toBe(true);
    await worker.run(agencyId);
    const signed = await s.leases.get(manager, lease.leaseId);
    expect(signed).toMatchObject({
      status: 'signed',
      signing: { method: 'esign', signedOnPaper: false, signedDocument: true },
    });
    expect(await scheduleRows(lease.leaseId)).toBeGreaterThan(0);
  });
});

describe('TL-07 signed PDF hash matches stored hash', () => {
  it('records the signed copy’s SHA-256 in the database and the audit chain, matching the stored bytes', async () => {
    const lease = await issued('ACC-SGN-B1-02');
    await signWith(linkSentTo(lease.tenantPhone), lease.tenantPhone);
    await signWith(linkSentTo(lease.guarantorPhone), lease.guarantorPhone);
    await signAsLandlord(lease);
    await signWith(await handover(lease, 'witness'), lease.witnessPhone);
    await worker.run(agencyId);

    const request = await requestRow(lease.requestId);
    expect(request.status).toBe('completed');
    const [finalDoc, frozenDoc] = await Promise.all(
      [request.finalDocumentId!, request.documentId!].map(async (id) =>
        s.documents.documentFile(agencyId, id),
      ),
    );
    // The database record, the stored bytes and the audit chain agree.
    expect(finalDoc!.sha256).toBe(request.finalSha256);
    expect(sha256Hex(finalDoc!.bytes)).toBe(request.finalSha256);
    expect(verifyFingerprint(finalDoc!.bytes, request.finalSha256!)).toBe(true);
    expect(frozenDoc!.sha256).toBe(request.documentSha256);
    const audit = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ data: schema.auditEvent.data })
          .from(schema.auditEvent)
          .where(
            sql`${schema.auditEvent.action} = 'signing.completed' and ${schema.auditEvent.recordId} = ${lease.requestId}`,
          ),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({
      finalSha256: request.finalSha256,
      documentSha256: request.documentSha256,
    });
    expect(await s.esign.verify(agencyId, lease.requestId)).toEqual({
      frozen: true,
      signed: true,
      audited: true,
    });
    // The signed copy keeps the frozen document byte for byte, with the certificate after it,
    // and the lease points at the signed copy.
    expect(startsWith(finalDoc!.bytes, frozenDoc!.bytes)).toBe(true);
    expect(finalDoc!.bytes.length).toBeGreaterThan(frozenDoc!.bytes.length);
    expect(await s.leaseSigning.documentUrl(manager, lease.leaseId, 'signed')).toBeTruthy();
    const view = await s.leases.get(manager, lease.leaseId);
    expect(view.status).toBe('signed');
  });
});

describe('TL-07 altered PDF is detected', () => {
  it('fails verification when one byte of a stored PDF changes', async () => {
    const lease = await issued('ACC-SGN-B1-03');
    await signWith(linkSentTo(lease.tenantPhone), lease.tenantPhone);
    await signWith(linkSentTo(lease.guarantorPhone), lease.guarantorPhone);
    await signAsLandlord(lease);
    await signWith(await handover(lease, 'witness'), lease.witnessPhone);
    await worker.run(agencyId);
    const request = await requestRow(lease.requestId);
    expect(await s.esign.verify(agencyId, lease.requestId)).toMatchObject({ signed: true });

    // One byte changed below the application, in storage: verification fails.
    const finalDoc = await s.documents.documentFile(agencyId, request.finalDocumentId!);
    const keyOf = async (id: string) =>
      (
        await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
          tx
            .select()
            .from(schema.document)
            .where(sql`${schema.document.id} = ${id}`),
        )
      )[0]!.storageKey;
    const finalKey = await keyOf(request.finalDocumentId!);
    const frozenKey = await keyOf(request.documentId!);
    const realGet = ctx.storage.get.bind(ctx.storage);
    const tamper = vi.spyOn(ctx.storage, 'get').mockImplementation(async (ref) => {
      const bytes = await realGet(ref);
      if (ref.key !== finalKey && ref.key !== frozenKey) return bytes;
      const altered = Buffer.from(bytes);
      altered[Math.floor(altered.length / 2)] = altered[Math.floor(altered.length / 2)]! ^ 0x01;
      return altered;
    });
    try {
      expect(await s.esign.verify(agencyId, lease.requestId)).toMatchObject({
        frozen: false,
        signed: false,
      });
      const altered = await s.documents.documentFile(agencyId, request.finalDocumentId!);
      expect(altered!.intact).toBe(false);
      expect(verifyFingerprint(altered!.bytes, finalDoc!.sha256)).toBe(false);
    } finally {
      tamper.mockRestore();
    }
    expect(await s.esign.verify(agencyId, lease.requestId)).toMatchObject({
      frozen: true,
      signed: true,
    });
  });
});

describe('TL-07 signing engine', () => {
  it('lets signers sign in any order, and records the evidence of each signature', async () => {
    const lease = await issued('ACC-SGN-B1-04');
    // Witness first, landlord, guarantor, tenant last: the order does not matter.
    await signWith(await handover(lease, 'witness'), lease.witnessPhone);
    await signAsLandlord(lease);
    await signWith(linkSentTo(lease.guarantorPhone), lease.guarantorPhone);
    expect((await s.leases.get(manager, lease.leaseId)).status).toBe('pending_signatures');
    await signWith(linkSentTo(lease.tenantPhone), lease.tenantPhone, {
      ip: '198.51.100.23',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
    });
    await worker.run(agencyId);
    expect((await s.leases.get(manager, lease.leaseId)).status).toBe('signed');

    const evidence = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.signature)
          .where(sql`${schema.signature.signingRequestId} = ${lease.requestId}`),
    );
    const request = await requestRow(lease.requestId);
    expect(evidence).toHaveLength(4);
    const tenantSig = evidence.find((e) => e.signerId === lease.signers.tenant)!;
    expect(tenantSig).toMatchObject({
      method: 'typed',
      typedName: 'Signer Name',
      consentVersion: CURRENT_CONSENT,
      verifiedChannel: 'sms',
      verifiedDestinationMasked: `+233 ** *** ${lease.tenantPhone.slice(-4)}`,
      ipAddress: '198.51.100.23',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
      documentSha256: request.documentSha256,
    });
    expect(tenantSig.consentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.find((e) => e.signerId === lease.signers.landlord)!.verifiedChannel).toBe(
      'email',
    );
    // Evidence is append-only.
    await expect(
      withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
        tx.execute(sql`update signature set ip_address = 'x' where id = ${tenantSig.id}`),
      ),
    ).rejects.toThrow();
  });

  it('builds the certificate with names, roles, times with their zone, verification, address, device and fingerprint', async () => {
    const lease = await issued('ACC-SGN-B1-05');
    await signWith(linkSentTo(lease.tenantPhone), lease.tenantPhone, {
      ip: '198.51.100.77',
      userAgent: 'Mozilla/5.0 (Linux; Android 12; itel A70)',
    });
    await signWith(linkSentTo(lease.guarantorPhone), lease.guarantorPhone);
    await signAsLandlord(lease);
    await signWith(await handover(lease, 'witness'), lease.witnessPhone);
    await worker.run(agencyId);
    const request = await requestRow(lease.requestId);
    const html = worker.certificates.at(-1)!;
    for (const words of [
      `Tenant: Tenant ACC-SGN-B1-05`,
      `Guarantor: Guarantor ACC-SGN-B1-05`,
      `For the landlord: Kofi Manager`,
      `Witness: Witness ACC-SGN-B1-05`,
      '198.51.100.77',
      'Mozilla/5.0 (Linux; Android 12; itel A70)',
      `One-time code sent by SMS to +233 ** *** ${lease.tenantPhone.slice(-4)}`,
      '(Africa/Accra)',
      request.documentSha256!,
    ])
      expect(html).toContain(words);
    // The certificate is stored with the signed copy as its data snapshot.
    const [doc] = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.document)
          .where(sql`${schema.document.id} = ${request.finalDocumentId}`),
    );
    expect(doc).toMatchObject({
      kind: 'signed_pdf',
      templateKey: 'esign.certificate',
      writeOnce: true,
    });
    expect((doc!.dataSnapshot as { signers: unknown[] }).signers).toHaveLength(4);
  });

  it('sends every party a link to their signed copy', async () => {
    const lease = await issued('ACC-SGN-B1-06');
    await signWith(linkSentTo(lease.tenantPhone), lease.tenantPhone);
    await signWith(linkSentTo(lease.guarantorPhone), lease.guarantorPhone);
    await signAsLandlord(lease);
    await signWith(await handover(lease, 'witness'), lease.witnessPhone);
    await worker.run(agencyId);
    const copies = (await messagesOf(ctx, agencyId)).filter(
      (m) => m.purpose === 'signed_copy' && m.recipient_type === 'signer',
    );
    const mine = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ signer_id: string; status: string }>(
          sql`select m.signer_id, (select e.status from message_event e where e.message_id = m.id order by e.occurred_at desc, e.id desc limit 1) as status
            from message m where m.purpose = 'signed_copy' and m.signer_id in (
              select id from signer where signing_request_id = ${lease.requestId})`,
        ),
    );
    expect(copies.length).toBeGreaterThanOrEqual(4);
    expect(mine.rows.map((r) => r.signer_id).sort()).toEqual(Object.values(lease.signers).sort());
    // Sent where consent allows; the witness, with none on record, is told in person.
    const byStatus = Object.fromEntries(mine.rows.map((r) => [r.signer_id, r.status]));
    expect(byStatus[lease.signers.tenant!]).toBe('sent');
    expect(byStatus[lease.signers.landlord!]).toBe('sent');
    expect(byStatus[lease.signers.witness!]).toBe('not_sent');

    // The copy link opens the signed-copy page and downloads the signed PDF.
    const copyToken = linkSentTo(lease.tenantPhone);
    const page = await s.signingPage.open(copyToken, PHONE);
    const request = await requestRow(lease.requestId);
    expect(page).toMatchObject({
      screen: 'copy',
      purpose: 'signed_copy',
      document: { finalSha256: request.finalSha256, html: null },
    });
    const url = await s.signingPage.documentUrl(copyToken, PHONE);
    const download = await ctx.storage.openDownload(url);
    expect(sha256Hex(download.body)).toBe(request.finalSha256);
    // No more signing links once the request has closed.
    await expect(handover(lease, 'tenant')).rejects.toMatchObject({ code: 'link_unavailable' });
  });

  it('a decline returns the lease to draft once, and a late decline never touches a re-issued lease', async () => {
    const lease = await issued('ACC-SGN-B1-07');
    const tenantToken = linkSentTo(lease.tenantPhone);
    await expect(s.signingPage.decline(tenantToken, PHONE, 'no')).rejects.toMatchObject({
      code: 'reason_required',
    });
    await s.signingPage.decline(tenantToken, PHONE, 'The rent is not what we agreed');
    // The request closed in the same transaction as the event, before the lease reacts.
    expect((await requestRow(lease.requestId)).status).toBe('declined');
    expect(await s.signingPage.open(linkSentTo(lease.guarantorPhone), PHONE)).toMatchObject({
      screen: 'closed',
      reason: 'declined',
    });
    await worker.run(agencyId);
    expect((await s.leases.get(manager, lease.leaseId)).status).toBe('draft');

    // Staff fix the draft and issue it again; then the old decline arrives a second time.
    await s.leases.updateDraft(manager, lease.leaseId, { monthlyRentMinor: 140_000 });
    await s.leaseSigning.issue(manager, lease.leaseId);
    await worker.run(agencyId);
    const declined = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ id: schema.outboxEvent.id, payload: schema.outboxEvent.payload })
          .from(schema.outboxEvent)
          .where(
            sql`${schema.outboxEvent.type} = 'signing.declined' and ${schema.outboxEvent.payload}->>'signingRequestId' = ${lease.requestId}`,
          ),
    );
    await s.lifecycle.onSigningDeclined(agencyId, {
      leaseId: lease.leaseId,
      signingRequestId: lease.requestId,
    });
    expect(declined).toHaveLength(1);
    expect((await s.leases.get(manager, lease.leaseId)).status).toBe('pending_signatures');
    // A late completion of the old request is ignored too.
    await s.lifecycle.onSigningCompleted(agencyId, {
      leaseId: lease.leaseId,
      signingRequestId: lease.requestId,
      completedAt: ctx.clock.now(),
      finalDocumentId: (await requestRow(lease.requestId)).documentId!,
    });
    expect((await s.leases.get(manager, lease.leaseId)).status).toBe('pending_signatures');
  });

  it('recall voids the links and returns the lease to draft; a lease everyone signed cannot be recalled', async () => {
    const lease = await issued('ACC-SGN-B1-08');
    const tenantToken = linkSentTo(lease.tenantPhone);
    await s.signingPage.sendCode(tenantToken, PHONE);
    await s.leaseSigning.recall(manager, lease.leaseId, 'Wrong start date');
    expect((await s.leases.get(manager, lease.leaseId)).status).toBe('draft');
    expect(await s.signingPage.open(tenantToken, PHONE)).toMatchObject({
      screen: 'closed',
      reason: 'cancelled',
    });
    await expect(
      s.signingPage.sign(tenantToken, PHONE, typed(codeSentTo(lease.tenantPhone))),
    ).rejects.toMatchObject({ code: 'link_not_usable' });
    expect((await requestRow(lease.requestId)).status).toBe('cancelled');
    await expect(s.leaseSigning.recall(manager, lease.leaseId)).rejects.toMatchObject({
      code: 'lease_not_pending',
    });

    // Once everyone has signed, recall is refused.
    await s.leaseSigning.issue(manager, lease.leaseId);
    await worker.run(agencyId);
    const again = (await s.leaseSigning.progress(manager, lease.leaseId))!;
    const next: Issued = {
      ...lease,
      requestId: again.requestId,
      signers: Object.fromEntries(again.signers.map((x) => [x.role, x.id])),
    };
    await signWith(linkSentTo(lease.tenantPhone), lease.tenantPhone);
    await signWith(linkSentTo(lease.guarantorPhone), lease.guarantorPhone);
    await signAsLandlord(next);
    await signWith(await handover(next, 'witness'), lease.witnessPhone);
    await expect(s.leaseSigning.recall(manager, lease.leaseId)).rejects.toMatchObject({
      code: 'signing_complete',
    });
    await worker.run(agencyId);
    expect((await s.leases.get(manager, lease.leaseId)).status).toBe('signed');
  });

  it('needs the landlord, a tenant signer and, when the company asks, the witness before issuing', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'No Witness Tenant',
      phone: newPhone(),
    });
    const draft = await s.leases.createDraft(manager, {
      unitId: units['ACC-SGN-B1-09']!,
      tenantId: tenant.id,
      startDate: month(3),
      endDate: endAfter(month(3), 12),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      noticeDays: 30,
    });
    await expect(s.leaseSigning.issue(manager, draft.id)).rejects.toMatchObject({
      code: 'witness_required',
    });
    await s.leases.updateDraft(manager, draft.id, {
      parties: [
        { role: 'tenant', name: 'No Witness Tenant' },
        { role: 'witness', name: 'A Witness' },
      ],
    });
    await expect(s.leaseSigning.issue(manager, draft.id)).rejects.toMatchObject({
      code: 'landlord_signer_required',
    });
    await s.leases.updateDraft(manager, draft.id, {
      parties: [
        { role: 'tenant', name: 'No Witness Tenant' },
        { role: 'landlord', name: 'Kofi Manager', staffPersonId: manager.personId },
        { role: 'witness', name: 'A Witness' },
      ],
    });
    // The witness has no phone or email: nobody could send them a code.
    await expect(s.leaseSigning.issue(manager, draft.id)).rejects.toMatchObject({
      code: 'signer_contact',
    });
    expect((await s.leases.get(manager, draft.id)).status).toBe('draft');
    // Only someone who may manage leases issues them; the caretaker-like accountant may not.
    const accountant = await staffIn(ctx, agencyId, 'agency', 'accountant', 'Accountant');
    await expect(s.leaseSigning.issue(accountant, draft.id)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('TL-07 expired or reused signing link is rejected', () => {
  it('shows expired, revoked and already-signed links as explanations that accept no action', async () => {
    const lease = await issued('ACC-SGN-B1-10');
    const tenantToken = linkSentTo(lease.tenantPhone);
    expect((await s.signingPage.open(tenantToken, PHONE)).screen).toBe('sign');

    // Reused: once signed, the link shows what happened and accepts nothing more.
    await signWith(tenantToken, lease.tenantPhone);
    expect(await s.signingPage.open(tenantToken, PHONE)).toMatchObject({
      screen: 'signed',
      document: { html: null },
      code: null,
    });
    await expect(s.signingPage.sendCode(tenantToken, PHONE)).rejects.toMatchObject({
      code: 'link_not_usable',
      status: 409,
    });
    await expect(s.signingPage.sign(tenantToken, PHONE, typed('000000'))).rejects.toMatchObject({
      code: 'link_not_usable',
    });
    await expect(
      s.signingPage.decline(tenantToken, PHONE, 'Changed my mind'),
    ).rejects.toMatchObject({ code: 'link_not_usable' });

    // Revoked: a newer link to the guarantor replaces the first.
    const first = linkSentTo(lease.guarantorPhone);
    const newer = await handover(lease, 'guarantor');
    expect(await s.signingPage.open(first, PHONE)).toMatchObject({
      screen: 'revoked',
      reason: 'superseded',
      landlord: { name: 'Signing Agency', contactName: 'Kofi Manager' },
    });
    await expect(s.signingPage.sendCode(first, PHONE)).rejects.toMatchObject({
      code: 'link_not_usable',
    });

    // Expired: 30 days on, the newer link no longer signs either.
    ctx.clock.advance(30 * DAY + MINUTE);
    try {
      expect(await s.signingPage.open(newer, PHONE)).toMatchObject({ screen: 'expired' });
      await expect(s.signingPage.sendCode(newer, PHONE)).rejects.toMatchObject({
        code: 'link_not_usable',
      });
      await expect(s.signingPage.sign(newer, PHONE, typed('123456'))).rejects.toMatchObject({
        code: 'link_not_usable',
      });
      // The hourly housekeeping marks it expired.
      const swept = await s.esign.expireLinksAndCodes(agencyId);
      expect(swept.expired).toBeGreaterThanOrEqual(1);
    } finally {
      ctx.clock.advance(-(30 * DAY + MINUTE));
    }
    // An unknown token is simply not found, and nothing about it is revealed.
    await expect(s.signingPage.open('x'.repeat(43), PHONE)).rejects.toMatchObject({ status: 404 });
    await expect(s.signingPage.open('short', PHONE)).rejects.toMatchObject({ status: 404 });
  });
});

describe('TL-07 one-time code brute force is rate-limited', () => {
  it('locks after five wrong codes, limits sends per link, phone and address, and texts only the phone on record', async () => {
    const lease = await issued('ACC-SGN-B1-11');
    const token = linkSentTo(lease.tenantPhone);
    const sent = await s.signingPage.sendCode(token, PHONE);
    expect(sent).toMatchObject({ channel: 'sms', sendsLeft: 2 });
    const right = codeSentTo(lease.tenantPhone);
    const wrong = right === '000000' ? '111111' : '000000';

    // Attempts: four wrong codes are counted; the fifth locks signing for 30 minutes.
    for (let i = 1; i <= 4; i += 1)
      await expect(s.signingPage.sign(token, PHONE, typed(wrong))).rejects.toMatchObject({
        code: 'code_wrong',
        details: { attemptsLeft: String(5 - i) },
      });
    await expect(s.signingPage.sign(token, PHONE, typed(wrong))).rejects.toMatchObject({
      code: 'signing_locked',
      status: 423,
    });
    // While locked, even the right code and a new code are refused.
    await expect(s.signingPage.sign(token, PHONE, typed(right))).rejects.toMatchObject({
      code: 'signing_locked',
    });
    await expect(s.signingPage.sendCode(token, PHONE)).rejects.toMatchObject({
      code: 'signing_locked',
    });
    expect((await s.signingPage.open(token, PHONE)).code).toMatchObject({ attemptsLeft: 0 });

    // After 30 minutes the lock lifts; the old code has expired, so a new one is needed.
    ctx.clock.advance(31 * MINUTE);
    try {
      await expect(s.signingPage.sign(token, PHONE, typed(right))).rejects.toMatchObject({
        code: 'code_expired',
      });
      // Send limits per link: three in 15 minutes.
      await s.signingPage.sendCode(token, PHONE);
      await s.signingPage.sendCode(token, PHONE);
      await s.signingPage.sendCode(token, PHONE);
      await expect(s.signingPage.sendCode(token, PHONE)).rejects.toMatchObject({
        code: 'code_limit',
        status: 429,
      });
      // Only the newest code works, and it signs.
      await s.signingPage.sign(token, PHONE, typed(codeSentTo(lease.tenantPhone)));
    } finally {
      ctx.clock.advance(-31 * MINUTE);
    }

    // Per destination: new links do not buy more codes to the same phone.
    const guarantor = lease.guarantorPhone;
    let refused: unknown = null;
    for (let link = 0; link < 4 && !refused; link += 1) {
      const t = await handover(lease, 'guarantor');
      for (let i = 0; i < 3 && !refused; i += 1)
        refused = await s.signingPage.sendCode(t, PHONE).then(
          () => null,
          (error: unknown) => error,
        );
    }
    expect(refused).toMatchObject({ code: 'code_limit', status: 429 });
    const toGuarantor = s.sms.sent.filter(
      (m) => m.to === guarantor && /is your code/.test(m.body),
    ).length;
    expect(toGuarantor).toBe(10);

    // Per address: a full window refuses every send from it.
    const hasher = new SigningHasher(ctx.config.BETTER_AUTH_SECRET);
    const busy = { ip: '192.0.2.99', userAgent: PHONE.userAgent };
    await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
      tx.execute(
        sql`insert into rate_limit (key, count, last_request)
            values (${`esign:code:ip:${hasher.address(busy.ip)}`}, 30, ${ctx.clock.now().getTime()})`,
      ),
    );
    await expect(
      s.signingPage.sendCode(await handover(lease, 'witness'), busy),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });

    // Destination: codes only ever went to the phones on record, never anywhere else.
    const codeTexts = s.sms.sent.filter((m) => /is your code/.test(m.body)).map((m) => m.to);
    expect(new Set(codeTexts).has(lease.witnessPhone)).toBe(false);
    for (const to of codeTexts) expect(to).toMatch(/^\+2332007\d{5}$/);
    // Codes are stored only as an HMAC: no row holds the plain code.
    const stored = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) => tx.execute<{ code_hash: string }>(sql`select code_hash from otp_challenge`),
    );
    for (const row of stored.rows) expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.rows)).not.toContain(`"${right}"`);
  });
});

describe('TL-07 signing engine: the signing page API', () => {
  it('shows the document as stored, with its PDF and fingerprint, and records the first open', async () => {
    const lease = await issued('ACC-SGN-B1-12');
    const token = linkSentTo(lease.tenantPhone);
    const page = await s.signingPage.open(token, PHONE);
    const request = await requestRow(lease.requestId);
    expect(page).toMatchObject({
      screen: 'sign',
      purpose: 'sign',
      timeZone: 'Africa/Accra',
      signer: { role: 'tenant', roleLabel: 'Tenant', status: 'pending' },
      document: { sha256: request.documentSha256 },
      consent: { version: CURRENT_CONSENT },
      code: {
        channel: 'sms',
        destinationMasked: `+233 ** *** ${lease.tenantPhone.slice(-4)}`,
        sendsLeft: 3,
        attemptsLeft: 5,
      },
    });
    expect(page.signers.map((x) => x.roleLabel)).toEqual([
      'Tenant',
      'Guarantor',
      'For the landlord',
      'Witness',
    ]);
    // The HTML is the stored one, and it matches its hash.
    expect(sha256Hex(Buffer.from(page.document.html!, 'utf8'))).toBe(request.htmlSha256);
    expect(page.document.html).toContain('Tenant ACC-SGN-B1-12');
    // The PDF download is the frozen document itself.
    const download = await ctx.storage.openDownload(await s.signingPage.documentUrl(token, PHONE));
    expect(sha256Hex(download.body)).toBe(request.documentSha256);
    // The first open is evidence, with the address and device; later opens only count.
    await s.signingPage.open(token, PHONE);
    const events = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.signingEvent)
          .where(
            sql`${schema.signingEvent.signerId} = ${lease.signers.tenant} and ${schema.signingEvent.kind} = 'signer.opened'`,
          ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ipAddress: PHONE.ip, userAgent: PHONE.userAgent });
    const progress = (await s.leaseSigning.progress(manager, lease.leaseId))!;
    const tenantProgress = progress.signers.find((x) => x.id === lease.signers.tenant)!;
    expect(tenantProgress.firstOpenedAt).not.toBeNull();
    expect(tenantProgress.lastLink).toMatchObject({ via: 'message' });
    expect(progress.signers.find((x) => x.id === lease.signers.witness)!.lastLink).toBeNull();
    // A manager scoped to another property sees no progress and cannot hand a link over.
    const elsewhere = await propertyWithUnits(s, manager, {
      areaCode: 'ACC',
      propertyPart: 'OTH',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const scoped = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Scoped', {
      properties: [elsewhere.propertyId],
    });
    await expect(s.leaseSigning.progress(scoped, lease.leaseId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      s.leaseSigning.handoverLink(scoped, lease.requestId, lease.signers.witness!),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('draws a signature into a stored image, and refuses one that is not a PNG', async () => {
    const lease = await issued('ACC-SGN-B1-13');
    const token = linkSentTo(lease.tenantPhone);
    await s.signingPage.sendCode(token, PHONE);
    const code = codeSentTo(lease.tenantPhone);
    const base = {
      code,
      method: 'drawn' as const,
      consentVersion: CURRENT_CONSENT,
      consentAccepted: true,
    };
    await expect(
      s.signingPage.sign(token, PHONE, { ...base, drawing: 'data:image/png;base64,AAAA' }),
    ).rejects.toMatchObject({ code: 'drawing_invalid' });
    await expect(
      s.signingPage.sign(token, PHONE, { ...base, consentAccepted: false, drawing: TINY_PNG }),
    ).rejects.toMatchObject({ code: 'consent_required' });
    await s.signingPage.sign(token, PHONE, { ...base, drawing: TINY_PNG });
    const [sig] = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.signature)
          .where(sql`${schema.signature.signerId} = ${lease.signers.tenant}`),
    );
    expect(sig).toMatchObject({ method: 'drawn' });
    const drawing = await s.documents.documentFile(agencyId, sig!.drawingDocumentId!);
    expect(drawing).toMatchObject({ contentType: 'image/png', intact: true });
  });
});

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('TL-07 signing engine: reminders, housekeeping and the tenant app', () => {
  it('reminds unsigned signers 24 hours, 3 days and 7 days after sending, once each, with a fresh link', async () => {
    const lease = await issued('ACC-SGN-B1-14');
    const signers = Object.values(lease.signers);
    const remindersTo = async (signerId: string) =>
      (
        await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
          tx.execute<{ n: number }>(
            sql`select count(*)::int as n from outbox_event where type = 'messaging.send'
                and payload->>'purpose' = 'signing_reminder' and payload->'recipient'->>'signerId' = ${signerId}`,
          ),
        )
      ).rows[0]!.n;
    const first = linkSentTo(lease.tenantPhone);
    const moved = { ms: 0 };
    const advance = async (ms: number) => {
      ctx.clock.advance(ms);
      moved.ms += ms;
      await s.esign.remindUnsigned(agencyId);
      await worker.run(agencyId);
    };
    try {
      await advance(23 * HOUR);
      expect(await remindersTo(lease.signers.tenant!)).toBe(0);
      await advance(1 * HOUR + MINUTE);
      for (const id of signers) expect(await remindersTo(id)).toBe(1);
      // The reminder's fresh link replaced the first.
      const second = linkSentTo(lease.tenantPhone);
      expect(second).not.toBe(first);
      expect((await s.signingPage.open(first, PHONE)).screen).toBe('revoked');
      expect((await s.signingPage.open(second, PHONE)).screen).toBe('sign');
      // Running again in the same step sends nothing more.
      await advance(15 * MINUTE);
      for (const id of signers) expect(await remindersTo(id)).toBe(1);
      // The tenant signs; the others are reminded at 3 days.
      await signWith(second, lease.tenantPhone);
      await advance(48 * HOUR);
      expect(await remindersTo(lease.signers.tenant!)).toBe(1);
      expect(await remindersTo(lease.signers.guarantor!)).toBe(2);
      // After a long gap only the latest step goes out, once.
      await advance(10 * DAY);
      expect(await remindersTo(lease.signers.guarantor!)).toBe(3);
      await advance(1 * DAY);
      expect(await remindersTo(lease.signers.guarantor!)).toBe(3);
      // A company can choose its own ladder.
      expect(await remindersTo(lease.signers.witness!)).toBe(3);
    } finally {
      ctx.clock.advance(-moved.ms);
    }
  });

  it('expires old links, closes links of closed requests and lifts finished code locks every hour', async () => {
    const lease = await issued('ACC-SGN-B1-15');
    const token = linkSentTo(lease.tenantPhone);
    await s.signingPage.sendCode(token, PHONE);
    for (let i = 0; i < 5; i += 1)
      await s.signingPage.sign(token, PHONE, typed('999999')).catch(() => undefined);
    const lockedProgress = (await s.leaseSigning.progress(manager, lease.leaseId))!;
    expect(
      lockedProgress.signers.find((x) => x.id === lease.signers.tenant)!.lockedUntil,
    ).not.toBeNull();
    ctx.clock.advance(31 * MINUTE);
    try {
      const swept = await s.esign.expireLinksAndCodes(agencyId);
      expect(swept.unlocked).toBeGreaterThanOrEqual(1);
      expect((await s.signingPage.open(token, PHONE)).code).toMatchObject({
        attemptsLeft: 5,
        lockedUntil: null,
      });
    } finally {
      ctx.clock.advance(-31 * MINUTE);
    }
  });

  it('lists the tenant’s own requests in the app and opens them with a fresh link', async () => {
    const lease = await issued('ACC-SGN-B1-16');
    const [row] = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ personId: schema.tenant.personId })
          .from(schema.tenant)
          .where(sql`${schema.tenant.phone} = ${lease.tenantPhone}`),
    );
    const tenantActor = {
      kind: 'tenant' as const,
      personId: row!.personId!,
      authMethod: 'phone_otp' as const,
    };
    const cards = await s.tenantApp.signing(tenantActor);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      signingRequestId: lease.requestId,
      leaseId: lease.leaseId,
      status: 'pending',
      landlord: { companyId: agencyId, name: 'Signing Agency' },
      signer: { id: lease.signers.tenant, status: 'pending' },
      tenancy: { unitCode: 'ACC-SGN-B1-16', status: 'pending_signatures' },
    });
    expect(cards[0]!.signers.map((x) => x.roleLabel)).toEqual([
      'Tenant',
      'Guarantor',
      'For the landlord',
      'Witness',
    ]);
    // The app's link replaces the texted one, and only the tenant's own signer gets one.
    const texted = linkSentTo(lease.tenantPhone);
    const link = await s.tenantApp.signingLink(tenantActor, lease.signers.tenant!);
    expect(link.url).toMatch(/\/l\/[A-Za-z0-9_-]{43}$/);
    expect((await s.signingPage.open(tokenIn(link.url), PHONE)).screen).toBe('sign');
    expect((await s.signingPage.open(texted, PHONE)).screen).toBe('revoked');
    await expect(
      s.tenantApp.signingLink(tenantActor, lease.signers.guarantor!),
    ).rejects.toMatchObject({ status: 404 });
    const stranger = { ...tenantActor, personId: manager.personId };
    expect(await s.tenantApp.signing(stranger)).toEqual([]);
    await expect(s.tenantApp.signingLink(stranger, lease.signers.tenant!)).rejects.toMatchObject({
      status: 404,
    });
    // Staff cannot use the tenant app's endpoints.
    await expect(s.tenantApp.signing(manager)).rejects.toMatchObject({ status: 403 });
  });
});
