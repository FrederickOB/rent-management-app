import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { ProviderError, type SmsPort } from '@rent/integrations';
import { InMemoryIdentityVerification } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queueMessage } from '../src/core/messages';
import { MessagingService } from '../src/messaging/messaging.service';
import { company, startServerTest, type ServerTestContext } from './support';
import {
  deliverMessages,
  messagesOf,
  propertyWithUnits,
  runIdentityStarts,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

let ctx: ServerTestContext;
let s: TenancyServices;
let agencyId: string;
let landlordId: string;
let admin: Awaited<ReturnType<typeof staffIn>>;
let manager: Awaited<ReturnType<typeof staffIn>>;
let accountant: Awaited<ReturnType<typeof staffIn>>;
let caretaker: Awaited<ReturnType<typeof staffIn>>;
let landlord: Awaited<ReturnType<typeof staffIn>>;
let elg: { propertyId: string; units: Record<string, string> };
let tem: { propertyId: string; units: Record<string, string> };
let today: string;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));

const terms = (over: Record<string, unknown> = {}) => ({
  startDate: day(-30),
  endDate: day(334),
  monthlyRentMinor: 200_000,
  cycle: 'monthly' as const,
  noticeDays: 30,
  ...over,
});

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agencyId = await company(ctx, 'agency', 'Tenants Agency');
  landlordId = await company(ctx, 'landlord', 'Tenants Landlord');
  admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Manager');
  accountant = await staffIn(ctx, agencyId, 'agency', 'accountant', 'Accountant');
  landlord = await staffIn(ctx, landlordId, 'landlord', 'owner', 'Landlord');
  const ownerA = await s.owners.create(admin, { kind: 'individual', displayName: 'Owner A' });
  elg = await propertyWithUnits(s, manager, {
    areaCode: 'ACC',
    propertyPart: 'ELG',
    ownerId: ownerA.id,
    units: [{ unitType: 'apartment', count: 4, bedrooms: 2 }],
  });
  tem = await propertyWithUnits(s, landlord, {
    areaCode: 'TEM',
    propertyPart: 'EST',
    units: [{ unitType: 'apartment', count: 1, bedrooms: 3 }],
  });
  caretaker = await staffIn(ctx, agencyId, 'agency', 'caretaker', 'Caretaker', {
    properties: [elg.propertyId],
  });
});

afterAll(async () => {
  await ctx?.close();
});

/** A paper lease for an existing tenancy (decision 7), so the tenant has a unit. */
async function paperLease(
  actor: typeof manager,
  unitId: string,
  tenantId: string,
  over: Record<string, unknown> = {},
) {
  const scanUploadId = await uploadLeaseFile(ctx, s, actor);
  return s.leases.recordPaper(actor, {
    unitId,
    tenantId,
    ...terms(over),
    parties: [{ role: 'tenant', name: 'Tenant', paperSignedOn: day(-31) }],
    scanUploadId,
    signedOn: day(-31),
  });
}

describe('TL-01 tenant profiles and one person, two landlords', () => {
  it('links both landlords’ records to one person, and the app shows both tenancies', async () => {
    const atAgency = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Kwame Two-Landlords',
      phone: '020 000 0041',
      email: 'kwame@example.org',
      occupation: 'Teacher',
    });
    const atLandlord = await s.tenants.create(landlord, {
      kind: 'individual',
      displayName: 'K. Two-Landlords',
      phone: '+233200000041',
    });
    // Same answer whatever the other company holds: no warning crosses companies.
    expect(atLandlord.duplicates).toEqual([]);
    expect(atAgency.tenant.phone).toBe('+233200000041');
    const people = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ personId: schema.tenant.personId })
          .from(schema.tenant)
          .where(sql`${schema.tenant.id} = ${atAgency.tenant.id}`),
    );
    const theirs = await withCompany(
      ctx.database,
      { companyId: landlordId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ personId: schema.tenant.personId })
          .from(schema.tenant)
          .where(sql`${schema.tenant.id} = ${atLandlord.tenant.id}`),
    );
    expect(people[0]!.personId).toBeTruthy();
    expect(theirs[0]!.personId).toBe(people[0]!.personId);
    // The views never carry the person link.
    expect(JSON.stringify(atAgency.tenant)).not.toContain(people[0]!.personId!);

    await paperLease(manager, elg.units['ACC-ELG-B1-01']!, atAgency.tenant.id);
    await paperLease(landlord, tem.units['TEM-EST-B1-01']!, atLandlord.tenant.id);
    const tenant = {
      kind: 'tenant' as const,
      personId: people[0]!.personId!,
      authMethod: 'phone_otp' as const,
    };
    const groups = await s.tenantApp.tenancies(tenant);
    expect(groups.map((g) => g.landlord.name).sort()).toEqual([
      'Tenants Agency',
      'Tenants Landlord',
    ]);
    expect(groups.flatMap((g) => g.tenancies.map((t) => t.unitCode)).sort()).toEqual([
      'ACC-ELG-B1-01',
      'TEM-EST-B1-01',
    ]);
    expect(groups.flatMap((g) => g.tenancies).every((t) => t.signedOnPaper)).toBe(true);
    const detail = await s.tenantApp.tenancy(tenant, groups[0]!.tenancies[0]!.leaseId);
    expect(detail.monthlyRentMinor).toBe(200_000);
    expect(await s.tenantApp.documentUrl(tenant, detail.documentId!)).toMatch(
      /^memory:\/\/download\//,
    );

    // Neither company sees the other's tenant.
    const agencyList = await s.tenants.list(manager);
    expect(agencyList.map((t) => t.id)).not.toContain(atLandlord.tenant.id);
    await expect(s.tenants.get(manager, atLandlord.tenant.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(s.tenants.get(landlord, atAgency.tenant.id)).rejects.toMatchObject({
      status: 404,
    });
    // A staff actor cannot use the tenant app, and another person sees nothing.
    await expect(s.tenantApp.tenancies(manager)).rejects.toMatchObject({ status: 403 });
    const stranger = {
      kind: 'tenant' as const,
      personId: landlord.personId,
      authMethod: 'phone_otp' as const,
    };
    expect(await s.tenantApp.tenancies(stranger)).toEqual([]);
    await expect(s.tenantApp.documentUrl(stranger, detail.documentId!)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('re-links a record to the new phone’s person, and never edits the person', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Phone Changer',
      phone: '+233200000056',
    });
    const personOf = async () =>
      (
        await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
          tx
            .select({ personId: schema.tenant.personId })
            .from(schema.tenant)
            .where(sql`${schema.tenant.id} = ${tenant.id}`),
        )
      )[0]!.personId;
    const before = await personOf();
    await s.tenants.update(manager, tenant.id, {
      phone: '+233200000057',
      displayName: 'Phone Changed',
    });
    const after = await personOf();
    expect(after).not.toBe(before);
    const people = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ id: string; name: string; phone_number: string }>(
          sql`select id, name, phone_number from person where id in (${before}, ${after}) order by phone_number`,
        ),
    );
    expect(people.rows.map((p) => [p.phone_number, p.name])).toEqual([
      ['+233200000056', 'Phone Changer'],
      ['+233200000057', 'Phone Changed'],
    ]);
  });

  it('warns about a duplicate phone inside the company, with a link to that tenant', async () => {
    const first = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Esi Duplicate',
      phone: '+233200000042',
    });
    const second = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Esi D.',
      phone: '0200000042',
    });
    expect(second.duplicates).toEqual([
      { tenantId: first.tenant.id, displayName: 'Esi Duplicate', matchedOn: 'phone' },
    ]);
    expect(await s.tenants.findDuplicates(manager, { phone: '+233 20 000 0042' })).toHaveLength(2);
  });
});

describe('TL-02 ID numbers', () => {
  it('stores only ciphertext, shows it masked, and reveals it only with a permission and a reason, audited', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Abena Card-Holder',
      phone: '+233200000043',
      idType: 'ghana_card',
      idNumber: 'gha 123456789 1',
    });
    expect(tenant.identity).toMatchObject({
      type: 'ghana_card',
      masked: 'GHA-*******89-1',
      status: 'not_started',
    });
    const [row] = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.tenant)
          .where(sql`${schema.tenant.id} = ${tenant.id}`),
    );
    expect(row!.idNumberEncrypted).toBeInstanceOf(Buffer);
    expect(row!.idNumberEncrypted!.toString('latin1')).not.toContain('123456789');
    expect(row!.idNumberIndex).toMatch(/^[0-9a-f]{64}$/);

    // A duplicate ID number is found through the blind index.
    const again = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Abena Again',
      idType: 'ghana_card',
      idNumber: 'GHA-123456789-1',
    });
    expect(again.duplicates).toEqual([
      { tenantId: tenant.id, displayName: 'Abena Card-Holder', matchedOn: 'id_number' },
    ]);

    await expect(
      s.tenants.revealIdNumber(caretaker, tenant.id, 'Checking the card'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      s.tenants.revealIdNumber(accountant, tenant.id, 'Checking the card'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(s.tenants.revealIdNumber(manager, tenant.id, 'why')).rejects.toMatchObject({
      status: 400,
    });
    const revealed = await s.tenants.revealIdNumber(
      manager,
      tenant.id,
      'Rent Control registration form',
    );
    expect(revealed).toEqual({ idType: 'ghana_card', idNumber: 'GHA-123456789-1', country: 'GH' });
    const events = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ action: string; data: Record<string, unknown>; actor_person_id: string }>(
          sql`select action, data, actor_person_id from audit_event where record_id = ${tenant.id} order by seq`,
        ),
    );
    const reveal = events.rows.find((e) => e.action === 'id_number.revealed');
    expect(reveal?.data).toEqual({
      reason: 'Rent Control registration form',
      idType: 'ghana_card',
    });
    expect(reveal?.actor_person_id).toBe(manager.personId);
    // The row audit records the ID columns only as changed, never by value.
    expect(JSON.stringify(events.rows)).not.toContain('123456789');
    expect(JSON.stringify(events.rows)).not.toContain('GHA-*******89-1');
  });

  it('never gives a caretaker or an accountant the number', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Yaa Lodger',
      phone: '+233200000044',
      idType: 'ghana_card',
      idNumber: 'GHA-987654321-1',
    });
    await paperLease(manager, elg.units['ACC-ELG-B1-02']!, tenant.id);
    const seen = await s.tenants.get(caretaker, tenant.id);
    expect(seen).toEqual({
      access: 'limited',
      id: tenant.id,
      kind: 'individual',
      displayName: 'Yaa Lodger',
      phone: '+233200000044',
      units: ['ACC-ELG-B1-02'],
    });
    const listed = await s.tenants.list(caretaker);
    expect(listed.map((t) => t.id)).toContain(tenant.id);
    expect(JSON.stringify(listed)).not.toMatch(/GHA-/);
    const forAccountant = JSON.stringify(await s.tenants.get(accountant, tenant.id));
    expect(forAccountant).toContain('GHA-*******21-1');
    expect(forAccountant).not.toContain('987654321');
  });

  it('records a passport as "recorded, not verified", and a company TIN the same way as an ID number', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Chidi Visitor',
      idType: 'passport',
      idNumber: 'a1234 567',
      idCountry: 'ng',
    });
    expect(tenant.identity).toMatchObject({
      type: 'passport',
      masked: '****4567',
      status: 'recorded',
    });
    expect(await s.tenants.revealIdNumber(admin, tenant.id, 'Checking the passport')).toEqual({
      idType: 'passport',
      idNumber: 'A1234567',
      country: 'NG',
    });
    await expect(s.idChecks.start(manager, tenant.id)).rejects.toMatchObject({
      code: 'id_check_ghana_card_only',
    });
    const firm = await s.tenants.create(manager, {
      kind: 'company',
      displayName: 'Osu Traders',
      legalName: 'Osu Traders Ltd',
      registrationNumber: 'CS123456789',
      tin: 'C0012345678',
    });
    expect(firm.tenant.tinMasked).toBe('*******5678');
    expect(
      (await s.tenants.revealTin(manager, firm.tenant.id, 'Withholding tax certificate')).tin,
    ).toBe('C0012345678');
    await expect(
      s.tenants.create(manager, { kind: 'individual', displayName: 'No TIN', tin: 'C0012345678' }),
    ).rejects.toMatchObject({ code: 'tin_company_only' });
  });

  it('runs biometric checks against the fake: verified, not matched, and a provider failure that stays pending', async () => {
    const identity = s.identity as InMemoryIdentityVerification;
    const check = async (name: string, idNumber: string, phone: string) => {
      const { tenant } = await s.tenants.create(manager, {
        kind: 'individual',
        displayName: name,
        phone,
        idType: 'ghana_card',
        idNumber,
        consent: { sms: true },
      });
      const started = await s.idChecks.start(manager, tenant.id);
      expect(started.status).toBe('pending');
      return { tenant, started };
    };
    const verified = await check('Verified Tenant', 'GHA-111111111-1', '+233200000045');
    const unmatched = await check('Unmatched Tenant', 'GHA-222222222-0', '+233200000046');
    const failing = await check('Failing Tenant', 'GHA-333333333-9', '+233200000047');
    const scheduled = await runIdentityStarts(ctx, s, agencyId);
    // The first poll is five minutes after the check started.
    const first = scheduled.find((p) => p.checkId === verified.started.id)!;
    expect(first.attempt).toBe(1);
    expect(first.at.getTime() - verified.started.createdAt.getTime()).toBe(5 * 60_000);

    // The capture link went by SMS, with consent; the record keeps no link.
    await deliverMessages(ctx, s, agencyId);
    const sms = s.sms.lastTo('+233200000045');
    expect(sms?.body).toContain('https://identity.fake.invalid/capture/');
    const recorded = (await messagesOf(ctx, agencyId)).filter((m) => m.purpose === 'id_check_link');
    expect(recorded.every((m) => m.body.includes('[link]') && !m.body.includes('capture/'))).toBe(
      true,
    );
    expect(recorded.every((m) => m.status === 'sent' && m.channel === 'sms')).toBe(true);

    for (const t of [verified, unmatched, failing]) {
      const [row] = await withCompany(
        ctx.database,
        { companyId: agencyId, actorKind: 'system' },
        (tx) =>
          tx
            .select()
            .from(schema.idCheck)
            .where(sql`${schema.idCheck.id} = ${t.started.id}`),
      );
      await identity.completeCapture(row!.providerCheckId!);
      const next: number[] = [];
      await s.idChecks.run(agencyId, t.started.id, 1, async (attempt) => {
        next.push(attempt);
      });
      const tenant = await s.tenants.get(manager, t.tenant.id);
      if (tenant.access !== 'full') throw new Error('expected the full view');
      if (t === verified) expect(tenant.identity.status).toBe('verified');
      if (t === unmatched) expect(tenant.identity.status).toBe('not_matched');
      if (t === failing) {
        expect(tenant.identity.status).toBe('pending');
        expect(next).toEqual([2]); // polled again later
        expect(tenant.idChecks[0]).toMatchObject({
          status: 'pending',
          lastResult: 'failed',
          polls: 1,
        });
      }
    }
    // The same poll twice runs once.
    await s.idChecks.run(agencyId, failing.started.id, 1, async () => undefined);
    const after = await s.tenants.get(manager, failing.tenant.id);
    if (after.access === 'full') expect(after.idChecks[0]!.polls).toBe(1);
    // Staff can check again after the scheduled polls.
    expect((await s.idChecks.refresh(manager, failing.tenant.id)).status).toBe('pending');
  });

  it('sends no capture link once the check is cancelled by a new ID number', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Changed Card',
      phone: '+233200000055',
      idType: 'ghana_card',
      idNumber: 'GHA-666666666-1',
      consent: { sms: true },
    });
    await s.idChecks.start(manager, tenant.id);
    await runIdentityStarts(ctx, s, agencyId);
    // A corrected number cancels the open check before its link goes out.
    await s.tenants.update(manager, tenant.id, {
      idType: 'ghana_card',
      idNumber: 'GHA-666666667-1',
    });
    await deliverMessages(ctx, s, agencyId);
    const link = (await messagesOf(ctx, agencyId))
      .filter((m) => m.purpose === 'id_check_link')
      .at(-1);
    expect(link).toMatchObject({ status: 'not_sent', reason: 'link_unavailable' });
    expect(s.sms.lastTo('+233200000055')).toBeUndefined();
  });

  it('says plainly when no identity provider is connected', async () => {
    const off = tenancyServices(ctx, { identity: null });
    const { tenant } = await off.tenants.create(manager, {
      kind: 'individual',
      displayName: 'No Provider',
      idType: 'ghana_card',
      idNumber: 'GHA-444444444-1',
    });
    await expect(off.idChecks.start(manager, tenant.id)).rejects.toMatchObject({
      code: 'identity_unavailable',
    });
  });
});

describe('TL-03 and TL-04 contacts and company tenants', () => {
  it('keeps a guarantor, next of kin and employer for a person, each with an E.164 phone', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Kojo With-Contacts',
      phone: '+233200000048',
      contacts: [
        {
          kind: 'guarantor',
          name: 'Uncle Guarantor',
          phone: '024 000 0001',
          relationship: 'Uncle',
        },
        {
          kind: 'next_of_kin',
          name: 'Sister Kin',
          phone: '+233 24 000 0002',
          relationship: 'Sister',
        },
        {
          kind: 'employer',
          name: 'HR Desk',
          organisation: 'Legon Hospital',
          email: 'hr@example.org',
        },
      ],
    });
    expect(tenant.contacts.map((c) => [c.kind, c.phone])).toEqual([
      ['guarantor', '+233240000001'],
      ['next_of_kin', '+233240000002'],
      ['employer', null],
    ]);
    const updated = await s.tenants.updateContact(manager, tenant.id, tenant.contacts[0]!.id, {
      phone: '0240000003',
    });
    expect(updated.phone).toBe('+233240000003');
    await expect(
      s.tenants.addContact(caretaker, tenant.id, { kind: 'guarantor', name: 'Nobody' }),
    ).rejects.toMatchObject({ status: 403 });
    await s.tenants.archiveContact(manager, tenant.id, tenant.contacts[2]!.id);
    const detail = await s.tenants.get(manager, tenant.id);
    if (detail.access === 'full')
      expect(detail.contacts.find((c) => c.kind === 'employer')?.archived).toBe(true);
  });

  it('keeps a company tenant’s registration, TIN, signatories and finance contact', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'company',
      displayName: 'Ridge Pharmacy',
      legalName: 'Ridge Pharmacy Ltd',
      registrationNumber: 'CS987654321',
      businessType: 'Pharmacy',
      tin: 'C0098765432',
      email: 'accounts@ridge.example',
      contacts: [
        { kind: 'signatory', name: 'Director One', phone: '+233200000049', position: 'Director' },
        { kind: 'finance', name: 'Finance Desk', email: 'finance@ridge.example' },
      ],
    });
    expect(tenant).toMatchObject({
      kind: 'company',
      legalName: 'Ridge Pharmacy Ltd',
      registrationNumber: 'CS987654321',
      businessType: 'Pharmacy',
      tinMasked: '*******5432',
    });
    expect(tenant.contacts.map((c) => c.kind)).toEqual(['signatory', 'finance']);
    await expect(
      s.tenants.create(manager, {
        kind: 'company',
        displayName: 'Card Co',
        idType: 'ghana_card',
        idNumber: 'GHA-555555555-1',
      }),
    ).rejects.toMatchObject({ code: 'id_individual_only' });
  });
});

describe('CM-09 consent groundwork', () => {
  const send = async (tenantId: string, body = 'Please sign: {{link}}') =>
    withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
      queueMessage(tx, agencyId, {
        recipient: { type: 'tenant', tenantId },
        purpose: 'signing_reminder',
        subject: 'Your lease',
        body: body.replace('{{link}}', 'see the office'),
        requestedBy: manager.personId,
      }),
    );

  it('sends only on a channel with consent, in order, and records each step', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Consenting Tenant',
      phone: '+233200000050',
      email: 'consenting@example.org',
      consent: { sms: true },
    });
    const viaSms = await send(tenant.id);
    await deliverMessages(ctx, s, agencyId); // consent is checked when the message is sent
    await s.tenants.recordConsent(manager, tenant.id, { channel: 'sms', action: 'withdraw' });
    const state = await s.tenants.recordConsent(manager, tenant.id, {
      channel: 'email',
      action: 'grant',
    });
    expect(state).toEqual({ sms: false, email: true });
    await deliverMessages(ctx, s, agencyId);
    const viaEmail = await send(tenant.id);
    await deliverMessages(ctx, s, agencyId);
    const rows = await messagesOf(ctx, agencyId);
    expect(rows.find((m) => m.id === viaSms)).toMatchObject({
      status: 'sent',
      channel: 'sms',
      events: ['queued', 'sent'],
    });
    expect(rows.find((m) => m.id === viaEmail)).toMatchObject({ status: 'sent', channel: 'email' });
    expect(s.email.lastTo('consenting@example.org')?.subject).toBe('Your lease');
  });

  it('does not send without consent, and tells whoever queued it', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Silent Tenant',
      phone: '+233200000051',
    });
    const id = await send(tenant.id);
    await deliverMessages(ctx, s, agencyId);
    await deliverMessages(ctx, s, agencyId); // the staff notice that follows
    const rows = await messagesOf(ctx, agencyId);
    expect(rows.find((m) => m.id === id)).toMatchObject({
      status: 'not_sent',
      reason: 'no_consent',
    });
    expect(s.sms.lastTo('+233200000051')).toBeUndefined();
    const notice = rows.filter((m) => m.purpose === 'staff_notice').at(-1);
    expect(notice).toMatchObject({ recipient_type: 'staff', status: 'sent', channel: 'email' });
  });

  it('falls back to the next consented channel after five failed sends', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Fallback Tenant',
      phone: '+233200000052',
      email: 'fallback@example.org',
      consent: { sms: true, email: true },
    });
    const failing: SmsPort = {
      provider: 'failing',
      send: () => Promise.reject(new ProviderError('failing', 'gateway down', true, 503)),
      parseDeliveryReport: () => null,
    };
    const messaging = new MessagingService(
      ctx.database,
      failing,
      s.email,
      ctx.config,
      s.tenants,
      s.idChecks,
    );
    const id = await send(tenant.id);
    const [event] = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ payload: schema.outboxEvent.payload })
          .from(schema.outboxEvent)
          .where(sql`${schema.outboxEvent.idempotencyKey} = ${`messaging.send:${id}`}`),
    );
    const { messageRequestSchema } = await import('../src/core/messages');
    const request = messageRequestSchema.parse(event!.payload);
    let retries = 0;
    for (;;) {
      try {
        await messaging.deliver(agencyId, request);
        break;
      } catch {
        retries += 1; // the job runner would retry with backoff
      }
    }
    expect(retries).toBe(4);
    const row = (await messagesOf(ctx, agencyId)).find((m) => m.id === id)!;
    expect(row.events).toEqual([
      'queued',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'sent',
    ]);
    expect(row.channel).toBe('email');
    // Replaying the job changes nothing.
    await messaging.deliver(agencyId, request);
    expect((await messagesOf(ctx, agencyId)).find((m) => m.id === id)!.events).toHaveLength(7);
  });

  it('never sends to a test contact through real adapters, and stores bodies without link tokens', async () => {
    const { tenant } = await s.tenants.create(
      manager,
      {
        kind: 'individual',
        displayName: 'Test Contact',
        phone: '+233200000053',
        consent: { sms: true },
      },
      { isTestContact: true },
    );
    const production = new MessagingService(
      ctx.database,
      s.sms,
      s.email,
      { ...ctx.config, NODE_ENV: 'production' },
      s.tenants,
      s.idChecks,
    );
    const id = await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
      queueMessage(tx, agencyId, {
        recipient: { type: 'tenant', tenantId: tenant.id },
        purpose: 'signing_reminder',
        body: 'Open https://links.example/l/abcdefghijklmnopqrstuvwxyz012345 to sign',
      }),
    );
    const [event] = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ payload: schema.outboxEvent.payload })
          .from(schema.outboxEvent)
          .where(sql`${schema.outboxEvent.idempotencyKey} = ${`messaging.send:${id}`}`),
    );
    const { messageRequestSchema } = await import('../src/core/messages');
    await production.deliver(agencyId, messageRequestSchema.parse(event!.payload));
    const row = (await messagesOf(ctx, agencyId)).find((m) => m.id === id)!;
    expect(row).toMatchObject({ status: 'not_sent', reason: 'test_contact' });
    expect(row.body).toBe('Open https://links.example/l/[link] to sign');
  });

  it('sends staff notices by email with no consent at all', async () => {
    await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
      queueMessage(tx, agencyId, {
        recipient: { type: 'staff', personId: admin.personId },
        purpose: 'staff_notice',
        subject: 'A reminder',
        body: 'A lease needs attention.',
        channels: ['email'],
      }),
    );
    await deliverMessages(ctx, s, agencyId);
    const row = (await messagesOf(ctx, agencyId))
      .filter((m) => m.purpose === 'staff_notice')
      .at(-1);
    expect(row).toMatchObject({ status: 'sent', channel: 'email' });
  });
});

describe('AD-07 audit of tenants', () => {
  it('records tenant and contact changes with phones and emails redacted', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Audited Tenant',
      phone: '+233200000054',
      email: 'audited@example.org',
    });
    await s.tenants.update(manager, tenant.id, {
      email: 'changed@example.org',
      occupation: 'Nurse',
    });
    const events = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{
          action: string;
          data: { after?: Record<string, unknown>; redacted_changed?: string[] };
        }>(
          sql`select action, data from audit_event where record_type = 'tenant' and record_id = ${tenant.id} order by seq`,
        ),
    );
    expect(events.rows.map((e) => e.action)).toEqual(['tenant.insert', 'tenant.update']);
    expect(events.rows[1]!.data.redacted_changed).toEqual(['email']);
    expect(events.rows[1]!.data.after?.occupation).toBe('Nurse');
    expect(JSON.stringify(events.rows)).not.toContain('example.org');
    expect(JSON.stringify(events.rows)).not.toContain('200000054');
    const timeline = await s.tenants.timeline(manager, tenant.id);
    expect(timeline.map((e) => e.action)).toEqual(['tenant.update', 'tenant.insert']);
  });
});

describe('TL-01 a tenant’s person link stays out of the audit log and the timeline', () => {
  it('records the person link only as changed, and never shows it to staff', async () => {
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Linked Tenant',
      phone: '+233200000081',
    });
    await s.tenants.update(manager, tenant.id, { phone: '+233200000082' });
    const people = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`select id from person where phone_number in ('+233200000081', '+233200000082')`,
          )
        ).rows.map((r) => r.id),
    );
    expect(people).toHaveLength(2);
    const events = await withCompany(
      ctx.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{
          action: string;
          data: {
            before?: Record<string, unknown>;
            after?: Record<string, unknown>;
            redacted_changed?: string[];
          };
        }>(
          sql`select action, data from audit_event where record_type = 'tenant' and record_id = ${tenant.id} order by seq`,
        ),
    );
    expect(events.rows.map((e) => e.action)).toEqual(['tenant.insert', 'tenant.update']);
    expect(events.rows[0]!.data.after?.person_id).toBe('[redacted]');
    expect(events.rows[1]!.data.before?.person_id).toBe('[redacted]');
    expect(events.rows[1]!.data.redacted_changed).toEqual(
      expect.arrayContaining(['phone', 'person_id']),
    );
    for (const id of people) expect(JSON.stringify(events.rows)).not.toContain(id);

    // An event written before the redaction, simulated here, is shown without the link too.
    await withCompany(
      ctx.database,
      { companyId: agencyId, personId: manager.personId, actorKind: 'staff' },
      (tx) =>
        ctx.audit.append(tx, {
          companyId: agencyId,
          action: 'tenant.update',
          recordType: 'tenant',
          recordId: tenant.id,
          data: {
            before: { id: tenant.id, person_id: people[0] },
            after: { id: tenant.id, person_id: people[1] },
          },
        }),
    );
    const timeline = await s.tenants.timeline(manager, tenant.id);
    expect(timeline).toHaveLength(3);
    const search = await ctx.audit.search(agencyId, manager.personId, {
      recordType: 'tenant',
      recordId: tenant.id,
      limit: 10,
    });
    for (const id of people) {
      expect(JSON.stringify(timeline)).not.toContain(id);
      expect(JSON.stringify(search.events)).not.toContain(id);
    }
    expect(timeline[0]!.data).toMatchObject({
      before: { person_id: '[redacted]' },
      after: { person_id: '[redacted]' },
      redacted_changed: ['person_id'],
    });
  });
});
