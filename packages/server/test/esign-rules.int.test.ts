import { schema, sql, withCompany } from '@rent/db';
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
import { ProviderError } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from '../src/esign/esign.types';
import type { PartyInput } from '../src/tenancy/tenancy.types';
import { company, person, startServerTest, type ServerTestContext } from './support';
import { EsignWorker, PHONE, tokenIn } from './support/esign';
import {
  messagesOf,
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Who signs, and when signing is over (review findings 1, 7, 9, 10 and 11; M3 plan 4.8): the
 * server decides who must sign, staff sign only as members, one party signs as the tenant, a
 * request everyone required has signed takes no further action, and a reminder that cannot be
 * sent never costs the signer their working link.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let worker: EsignWorker;
let renderer: PdfRenderer;
let agencyId: string;
let admin: Awaited<ReturnType<typeof staffIn>>;
let manager: Awaited<ReturnType<typeof staffIn>>;
let units: Record<string, string>;
let ownerId: string;
let today: string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const month = (n: number) => toIsoDate(addMonths(parseBusinessDate(today), n));
const endAfter = (from: string, n: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), n), -1));

let phoneSeq = 0;
const newPhone = () => `+2332008${String((phoneSeq += 1)).padStart(5, '0')}`;

const typed = (code: string) => ({
  code,
  method: 'typed' as const,
  typedName: 'Signer Name',
  consentVersion: CURRENT_CONSENT,
  consentAccepted: true,
});

function codeSentTo(phone: string): string {
  const code = /^(\d{6}) is your code/.exec(s.sms.lastTo(phone)?.body ?? '')?.[1];
  if (!code) throw new Error('no code was texted to the signer');
  return code;
}

const linkSentTo = (phone: string) => tokenIn(s.sms.lastTo(phone)?.body);

async function signWith(token: string, phone: string, client: ClientInfo = PHONE) {
  await s.signingPage.sendCode(token, client);
  return s.signingPage.sign(token, client, typed(codeSentTo(phone)));
}

/** The landlord's signer (the manager, by email) signs through a hand-over link. */
async function signAsLandlord(requestId: string, signerId: string, as = manager) {
  const token = tokenIn((await s.leaseSigning.handoverLink(manager, requestId, signerId)).url);
  await s.signingPage.sendCode(token, PHONE);
  const code = /Your code is (\d{6})/.exec(
    s.email.lastTo(`${as.personId}@test.invalid`)?.text ?? '',
  )?.[1];
  if (!code) throw new Error('no code was emailed to the landlord’s signer');
  return s.signingPage.sign(token, PHONE, typed(code));
}

const handover = async (requestId: string, signerId: string) =>
  tokenIn((await s.leaseSigning.handoverLink(manager, requestId, signerId)).url);

async function tenantWithConsent(name: string, extra: Record<string, unknown> = {}) {
  const phone = newPhone();
  const { tenant } = await s.tenants.create(manager, {
    kind: 'individual',
    displayName: name,
    phone,
    consent: { sms: true },
    ...extra,
  });
  return { tenant, phone };
}

async function draftOn(
  unitCode: string,
  tenantId: string,
  parties?: (defaults: readonly PartyInput[]) => PartyInput[],
) {
  const draft = await s.leases.createDraft(manager, {
    unitId: units[unitCode]!,
    tenantId,
    startDate: month(2),
    endDate: endAfter(month(2), 12),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
  });
  if (parties) {
    const defaults: PartyInput[] = draft.parties.map((p) => ({
      role: p.role,
      name: p.name,
      phone: p.phone,
      email: p.email,
      tenantContactId: p.tenantContactId,
      staffPersonId: p.staffPersonId,
      required: p.required,
    }));
    await s.leases.updateDraft(manager, draft.id, { parties: parties(defaults) });
  }
  return draft;
}

async function issueAndOpen(leaseId: string) {
  await s.leaseSigning.issue(manager, leaseId);
  await worker.run(agencyId);
  const progress = (await s.leaseSigning.progress(manager, leaseId))!;
  expect(progress.status).toBe('pending');
  return {
    requestId: progress.requestId,
    signers: Object.fromEntries(progress.signers.map((x) => [x.role, x])),
  };
}

const statusOf = async (leaseId: string) => (await s.leases.get(manager, leaseId)).status;

/** Signer roles, looked up as a set (they are signer roles, not access roles). */
const GUARANTOR: ReadonlySet<string> = new Set(['guarantor']);
const TENANT: ReadonlySet<string> = new Set(['tenant']);

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  renderer = await PdfRenderer.launch({ poolSize: 1 });
  worker = new EsignWorker(ctx, s, (html) => renderer.render(html));
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agencyId = await company(ctx, 'agency', 'Rules Agency');
  admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Kofi Manager');
  ownerId = (await s.owners.create(admin, { kind: 'individual', displayName: 'Owner' })).id;
  ({ units } = await propertyWithUnits(s, manager, {
    areaCode: 'ACC',
    propertyPart: 'RQD',
    ownerId,
    units: [{ unitType: 'apartment', count: 8, bedrooms: 2 }],
  }));
}, 120_000);

afterAll(async () => {
  await renderer?.close();
  await ctx?.close();
});

describe('TL-07 the server decides who must sign', () => {
  it('keeps the lease pending until the tenant and the witness sign, whatever the client sent', async () => {
    const { tenant, phone } = await tenantWithConsent('Optional Tenant');
    const witnessPhone = newPhone();
    // The client marks everyone optional; the company asks for a witness on every lease.
    const draft = await draftOn('ACC-RQD-B1-01', tenant.id, () => [
      { role: 'tenant', name: 'Optional Tenant', required: false },
      { role: 'landlord', name: 'Kofi Manager', staffPersonId: manager.personId, required: false },
      { role: 'witness', name: 'Optional Witness', phone: witnessPhone, required: false },
      { role: 'guarantor', name: 'Optional Guarantor', phone: newPhone(), required: false },
    ]);
    expect(draft.witnessRequired).toBe(true);
    const { requestId, signers } = await issueAndOpen(draft.id);
    expect(
      Object.fromEntries(Object.entries(signers).map(([role, x]) => [role, x.required])),
    ).toEqual({ tenant: true, landlord: true, witness: true, guarantor: false });

    // The landlord's signer alone completes nothing.
    await signAsLandlord(requestId, signers.landlord!.id);
    await worker.run(agencyId);
    expect(await statusOf(draft.id)).toBe('pending_signatures');
    await signWith(await handover(requestId, signers.witness!.id), witnessPhone);
    await worker.run(agencyId);
    expect(await statusOf(draft.id)).toBe('pending_signatures');
    // The tenant signs: the lease is signed, without the guarantor the client made optional.
    await signWith(linkSentTo(phone), phone);
    await worker.run(agencyId);
    expect(await statusOf(draft.id)).toBe('signed');
  });
});

describe('TL-07 a request everyone required has signed accepts nothing more', () => {
  it('shows an optional signer the closed page and refuses their code, signature and decline', async () => {
    const guarantorPhone = newPhone();
    const { tenant, phone } = await tenantWithConsent('Complete Tenant', {
      contacts: [
        {
          kind: 'guarantor',
          name: 'Late Guarantor',
          phone: guarantorPhone,
          consent: { sms: true },
        },
      ],
    });
    const witnessPhone = newPhone();
    const draft = await draftOn('ACC-RQD-B1-02', tenant.id, (defaults) => [
      ...defaults.map((p) => (GUARANTOR.has(p.role) ? { ...p, required: false } : p)),
      { role: 'witness', name: 'A Witness', phone: witnessPhone },
    ]);
    const { requestId, signers } = await issueAndOpen(draft.id);
    expect(signers.guarantor!.required).toBe(false);
    // The guarantor has a working link and asks for a code while the others sign.
    const guarantorToken = linkSentTo(guarantorPhone);
    expect((await s.signingPage.open(guarantorToken, PHONE)).screen).toBe('sign');
    await s.signingPage.sendCode(guarantorToken, PHONE);
    const guarantorCode = codeSentTo(guarantorPhone);

    await signWith(linkSentTo(phone), phone);
    await signAsLandlord(requestId, signers.landlord!.id);
    const last = await signWith(await handover(requestId, signers.witness!.id), witnessPhone);
    expect(last.complete).toBe(true);

    // Before the worker has finalised, the optional signer can do nothing more.
    expect(await s.signingPage.open(guarantorToken, PHONE)).toMatchObject({
      screen: 'closed',
      reason: 'signed_by_all',
      code: null,
    });
    await expect(s.signingPage.sendCode(guarantorToken, PHONE)).rejects.toMatchObject({
      code: 'link_not_usable',
    });
    await expect(
      s.signingPage.sign(guarantorToken, PHONE, typed(guarantorCode)),
    ).rejects.toMatchObject({ code: 'link_not_usable' });
    await expect(
      s.signingPage.decline(guarantorToken, PHONE, 'I no longer agree'),
    ).rejects.toMatchObject({ code: 'link_not_usable' });
    await expect(handover(requestId, signers.guarantor!.id)).rejects.toMatchObject({
      code: 'link_unavailable',
    });

    // The lease is signed with every required signature on its certificate.
    await worker.run(agencyId);
    expect(await statusOf(draft.id)).toBe('signed');
    const html = worker.certificates.at(-1)!;
    expect(html).toContain('Tenant: Complete Tenant');
    expect(html).not.toContain('Late Guarantor');
  });
});

describe('TL-07 a reminder that cannot be sent keeps the signer’s working link', () => {
  it('revokes the never-delivered link instead of the one the signer has', async () => {
    const { tenant, phone } = await tenantWithConsent('Unreachable Tenant');
    const draft = await draftOn('ACC-RQD-B1-03', tenant.id, (defaults) => [
      ...defaults,
      { role: 'witness', name: 'A Witness', phone: newPhone() },
    ]);
    const { signers } = await issueAndOpen(draft.id);
    const working = linkSentTo(phone);
    const send = s.sms.send.bind(s.sms);
    const refuse = vi
      .spyOn(s.sms, 'send')
      .mockImplementation((message) =>
        message.to === phone && /reminder/i.test(message.body)
          ? Promise.reject(new ProviderError('memory', 'number barred', false, 400))
          : send(message),
      );
    const moved = 24 * HOUR + MINUTE;
    ctx.clock.advance(moved);
    try {
      await s.esign.remindUnsigned(agencyId);
      await worker.run(agencyId);
      const reminder = (await messagesOf(ctx, agencyId)).find(
        (m) => m.purpose === 'signing_reminder' && m.status === 'failed',
      );
      expect(reminder).toBeDefined();
      // The link the signer already has still works, and signs.
      expect((await s.signingPage.open(working, PHONE)).screen).toBe('sign');
      const links = await withCompany(
        ctx.database,
        { companyId: agencyId, actorKind: 'system' },
        (tx) =>
          tx
            .select({
              messageId: schema.secureLink.messageId,
              revokeReason: schema.secureLink.revokeReason,
            })
            .from(schema.secureLink)
            .where(sql`${schema.secureLink.signerId} = ${signers.tenant!.id}`),
      );
      // The reminder's own link never reached anyone, so it is the one revoked.
      expect(links.filter((l) => l.messageId === reminder!.id)).toEqual([
        { messageId: reminder!.id, revokeReason: 'not_delivered' },
      ]);
      await signWith(working, phone);
    } finally {
      refuse.mockRestore();
      ctx.clock.advance(-moved);
    }
  });
});

describe('TL-07 one party signs as the tenant', () => {
  it('refuses a second tenant party without a contact record, and issues once co-occupants are contacts', async () => {
    const { tenant, phone } = await tenantWithConsent('Main Tenant');
    const witness = { role: 'witness' as const, name: 'A Witness', phone: newPhone() };
    const landlord = {
      role: 'landlord' as const,
      name: 'Kofi Manager',
      staffPersonId: manager.personId,
    };
    const draft = await draftOn('ACC-RQD-B1-04', tenant.id, () => [
      { role: 'tenant', name: 'Main Tenant' },
      { role: 'tenant', name: 'Co-occupant' },
      landlord,
      witness,
    ]);
    await expect(s.leaseSigning.issue(manager, draft.id)).rejects.toMatchObject({
      code: 'tenant_signer_once',
      message: expect.stringMatching(/add co-occupants as the tenant’s contacts/i),
    });
    expect(await statusOf(draft.id)).toBe('draft');

    const coPhone = newPhone();
    const contact = await s.tenants.addContact(manager, tenant.id, {
      kind: 'next_of_kin',
      name: 'Co-occupant',
      phone: coPhone,
    });
    await s.leases.updateDraft(manager, draft.id, {
      parties: [
        { role: 'tenant', name: 'Main Tenant' },
        { role: 'tenant', name: 'Co-occupant', tenantContactId: contact.id },
        landlord,
        witness,
      ],
    });
    await s.leaseSigning.issue(manager, draft.id);
    await worker.run(agencyId);
    const progress = (await s.leaseSigning.progress(manager, draft.id))!;
    const tenants = progress.signers.filter((x) => TENANT.has(x.role));
    expect(tenants.map((x) => x.phoneMasked)).toEqual([
      `+233 ** *** ${phone.slice(-4)}`,
      `+233 ** *** ${coPhone.slice(-4)}`,
    ]);
  });
});

describe('TL-07 staff sign only for the landlord or as witness, and only as members', () => {
  it('refuses a staff signer from outside the company, in another role, or no longer a member', async () => {
    const { tenant } = await tenantWithConsent('Staff Rules Tenant');
    const draft = await draftOn('ACC-RQD-B1-05', tenant.id);
    const outsider = await person(ctx, 'Not A Member');
    const save = (parties: PartyInput[]) => s.leases.updateDraft(manager, draft.id, { parties });
    await expect(
      save([
        { role: 'tenant', name: 'Staff Rules Tenant' },
        { role: 'landlord', name: 'Not A Member', staffPersonId: outsider },
      ]),
    ).rejects.toMatchObject({ code: 'party_staff' });
    await expect(
      save([
        { role: 'tenant', name: 'Kofi Manager', staffPersonId: manager.personId },
        { role: 'landlord', name: 'Kofi Manager', staffPersonId: manager.personId },
      ]),
    ).rejects.toMatchObject({ code: 'party_staff' });
    await expect(
      s.leases.createDraft(manager, {
        unitId: units['ACC-RQD-B1-06']!,
        tenantId: tenant.id,
        startDate: month(2),
        endDate: endAfter(month(2), 12),
        monthlyRentMinor: 150_000,
        cycle: 'monthly',
        noticeDays: 30,
        parties: [
          { role: 'tenant', name: 'Staff Rules Tenant' },
          { role: 'guarantor', name: 'Kofi Manager', staffPersonId: manager.personId },
        ],
      }),
    ).rejects.toMatchObject({ code: 'party_staff' });

    // A colleague signs for the landlord and the admin witnesses: both members.
    const colleague = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Colleague');
    await save([
      { role: 'tenant', name: 'Staff Rules Tenant' },
      { role: 'landlord', name: 'Colleague', staffPersonId: colleague.personId },
      { role: 'witness', name: 'Admin', staffPersonId: admin.personId },
    ]);
    // The colleague leaves before the lease is sent: issuing checks again.
    await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.membership)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(sql`${schema.membership.id} = ${colleague.membershipId}`),
    );
    await expect(s.leaseSigning.issue(manager, draft.id)).rejects.toMatchObject({
      code: 'party_staff',
    });
    expect(await statusOf(draft.id)).toBe('draft');
  });
});

describe('TL-07 one-time code brute force is rate-limited across companies', () => {
  it('counts the codes sent to one phone in every company together', async () => {
    const shared = newPhone();
    const client = { ip: '198.51.100.201', userAgent: PHONE.userAgent };
    // Company 1: ten codes to the shared phone, three per link.
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Shared Phone Tenant',
      phone: shared,
      consent: { sms: true },
    });
    const first = await draftOn('ACC-RQD-B1-07', tenant.id, (defaults) => [
      ...defaults,
      { role: 'witness', name: 'A Witness', phone: newPhone() },
    ]);
    const opened = await issueAndOpen(first.id);
    let sent = 0;
    for (let link = 0; link < 4 && sent < 10; link += 1) {
      const token = await handover(opened.requestId, opened.signers.tenant!.id);
      for (let i = 0; i < 3 && sent < 10; i += 1) {
        await s.signingPage.sendCode(token, client);
        sent += 1;
      }
    }
    expect(sent).toBe(10);

    // Company 2, another landlord with a tenant on the same phone: no more codes to it for now.
    const otherId = await company(ctx, 'landlord', 'Second Landlord');
    const owner = await staffIn(ctx, otherId, 'landlord', 'owner', 'Second Owner');
    const place = await propertyWithUnits(s, owner, {
      areaCode: 'TEM',
      propertyPart: 'RQD',
      units: [{ unitType: 'apartment', count: 1, bedrooms: 2 }],
    });
    const { tenant: theirs } = await s.tenants.create(owner, {
      kind: 'individual',
      displayName: 'Shared Phone Tenant',
      phone: shared,
      consent: { sms: true },
    });
    const draft = await s.leases.createDraft(owner, {
      unitId: place.units['TEM-RQD-B1-01']!,
      tenantId: theirs.id,
      startDate: month(2),
      endDate: endAfter(month(2), 12),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      witnessRequired: false,
    });
    await s.leaseSigning.issue(owner, draft.id);
    await worker.run(otherId);
    const progress = (await s.leaseSigning.progress(owner, draft.id))!;
    const tenantSigner = progress.signers.find((x) => TENANT.has(x.role))!;
    const token = tokenIn(
      (await s.leaseSigning.handoverLink(owner, progress.requestId, tenantSigner.id)).url,
    );
    await expect(s.signingPage.sendCode(token, client)).rejects.toMatchObject({
      code: 'code_limit',
      status: 429,
    });
  });
});
