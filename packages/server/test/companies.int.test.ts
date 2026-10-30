import { randomUUID } from 'node:crypto';
import { InMemoryAddressLookup, InMemoryEmail, InMemorySms } from '@rent/integrations';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompaniesService } from '../src/companies/companies.service';
import { MembershipsService } from '../src/companies/memberships.service';
import { OwnersService } from '../src/companies/owners.service';
import { createLogger } from '../src/core/logging/logger';
import { DocumentsService, LOGO_UPLOAD } from '../src/documents/documents.service';
import { createAuth } from '../src/identity/auth';
import { MembershipDirectory } from '../src/identity/memberships';
import { PersonAccounts } from '../src/identity/person-accounts';
import { PolicyService } from '../src/policy/policy.service';
import { RegisterService } from '../src/portfolio/register.service';
import { RulesService } from '../src/rules/rules.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';

let ctx: ServerTestContext;
let companies: CompaniesService;
let memberships: MembershipsService;
let documents: DocumentsService;
const email = new InMemoryEmail();

let agencyId: string;
let admin: ReturnType<typeof staff>;
let manager: ReturnType<typeof staff>;
let accountant: ReturnType<typeof staff>;

beforeAll(async () => {
  ctx = await startServerTest();
  const policy = new PolicyService();
  const auth = createAuth({
    database: ctx.database,
    config: ctx.config,
    sms: new InMemorySms(),
    email,
    clock: ctx.clock,
    logger: createLogger({ level: 'silent' }),
    memberships: new MembershipDirectory(ctx.database),
  });
  documents = new DocumentsService(
    ctx.database,
    ctx.storage,
    ctx.config,
    ctx.clock,
    ctx.audit,
    new RulesService(ctx.database),
  );
  companies = new CompaniesService(ctx.database, policy, documents);
  memberships = new MembershipsService(
    ctx.database,
    policy,
    new PersonAccounts(auth),
    ctx.audit,
    auth,
    ctx.config,
  );

  agencyId = await company(ctx, 'agency', 'Branding Agency');
  const adminId = await person(ctx, 'Admin');
  const managerId = await person(ctx, 'Manager');
  const accountantId = await person(ctx, 'Accountant');
  admin = staff(
    agencyId,
    'agency',
    adminId,
    await member(ctx, agencyId, adminId, 'agency_admin'),
    'agency_admin',
  );
  manager = staff(
    agencyId,
    'agency',
    managerId,
    await member(ctx, agencyId, managerId, 'property_manager'),
    'property_manager',
  );
  accountant = staff(
    agencyId,
    'agency',
    accountantId,
    await member(ctx, agencyId, accountantId, 'accountant'),
    'accountant',
  );
});

afterAll(async () => {
  await ctx?.close();
});

describe('AD-01 company branding', () => {
  it('updates branding and records the change with before and after values', async () => {
    const profile = await companies.updateBranding(admin, {
      primaryColour: '#123456',
      senderName: 'Branding Ltd',
      displayName: 'Branding Agency Ltd',
    });
    expect(profile.branding).toMatchObject({
      primaryColour: '#123456',
      senderName: 'Branding Ltd',
    });
    expect(profile.displayName).toBe('Branding Agency Ltd');
    const events = await ctx.audit.search(agencyId, admin.personId, {
      action: 'company.update',
      limit: 5,
    });
    const data = events.events[0]!.data as {
      before: { primary_colour: string };
      after: { primary_colour: string };
    };
    expect(events.events[0]!.actorPersonId).toBe(admin.personId);
    expect(data.before.primary_colour).toBe('#0F766E');
    expect(data.after.primary_colour).toBe('#123456');
  });

  it('refuses bad values and people without the right', async () => {
    await expect(companies.updateBranding(admin, { primaryColour: 'teal' })).rejects.toThrow();
    await expect(
      companies.updateBranding(manager, { senderName: 'Not allowed' }),
    ).rejects.toThrow();
  });

  it('validates settings and keeps the PRD defaults for everything else', async () => {
    const profile = await companies.updateSettings(admin, { advanceRentPolicy: 'warn' });
    expect(profile.settings).toMatchObject({
      advanceRentPolicy: 'warn',
      rentReminderOffsetsDays: [-7, 0, 3, 7, 14],
    });
    await expect(
      companies.updateSettings(admin, { advanceRentPolicy: 'maybe' as never }),
    ).rejects.toThrow();
    await expect(companies.updateSettings(admin, { approvalCoolingOffHours: 1 })).rejects.toThrow();
  });

  it('accepts a logo only as declared, re-encodes it, and serves it by a short-lived link', async () => {
    const actorCtx = { companyId: agencyId, personId: admin.personId };
    await expect(
      documents.createUpload(actorCtx, LOGO_UPLOAD, 'image/svg+xml', 100),
    ).rejects.toThrow();
    await expect(
      documents.createUpload(actorCtx, LOGO_UPLOAD, 'image/png', 2_000_000),
    ).rejects.toThrow();

    const png = await sharp({
      create: { width: 900, height: 300, channels: 3, background: '#0F766E' },
    })
      .png()
      .toBuffer();
    const upload = await documents.createUpload(actorCtx, LOGO_UPLOAD, 'image/png', png.length);
    const key = upload.fields.key ?? upload.fields.Key!;
    await ctx.storage.put({
      bucket: ctx.config.S3_BUCKET_FILES,
      key,
      body: png,
      contentType: 'image/png',
    });
    const documentId = await documents.acceptLogo(actorCtx, upload.uploadId);
    const profile = await companies.setLogo(admin, documentId);
    expect(profile.branding.logoUrl).toBeTruthy();
    const stored = await ctx.storage.get({
      bucket: ctx.config.S3_BUCKET_FILES,
      key: `logos/${agencyId}/${documentId}.png`,
    });
    expect((await sharp(stored).metadata()).width).toBe(512);

    const fake = await documents.createUpload(actorCtx, LOGO_UPLOAD, 'image/png', 20);
    await ctx.storage.put({
      bucket: ctx.config.S3_BUCKET_FILES,
      key: fake.fields.key ?? fake.fields.Key!,
      body: Buffer.from('not an image at all'),
      contentType: 'image/png',
    });
    await expect(documents.acceptLogo(actorCtx, fake.uploadId)).rejects.toThrow(/readable image/);
  });
});

describe('AD-03 users and roles', () => {
  it('lists people for those allowed and refuses the rest', async () => {
    expect((await memberships.list(admin)).map((m) => m.role).sort()).toEqual([
      'accountant',
      'agency_admin',
      'property_manager',
    ]);
    expect((await memberships.list(manager)).length).toBe(3);
    await expect(memberships.list(accountant)).rejects.toThrow();
  });

  it('invites staff by email with a set-password link, and caretakers by phone', async () => {
    const invited = await memberships.invite(admin, {
      name: 'New Manager',
      email: 'new.manager@test.invalid',
      role: 'property_manager',
    });
    expect(invited).toMatchObject({
      role: 'property_manager',
      status: 'active',
      email: 'new.manager@test.invalid',
    });
    const message = email.sent.find((m) => m.to === 'new.manager@test.invalid');
    expect(message?.text).toMatch(/reset-password/);

    const caretaker = await memberships.invite(admin, {
      name: 'New Caretaker',
      phone: '020 000 0399',
      role: 'caretaker',
    });
    expect(caretaker).toMatchObject({
      role: 'caretaker',
      email: null,
      phoneMasked: '+233 ** *** 0399',
    });
    await expect(
      memberships.invite(admin, { name: 'No Phone', role: 'caretaker' }),
    ).rejects.toThrow(/phone/);
    await expect(
      memberships.invite(admin, {
        name: 'Again',
        email: 'new.manager@test.invalid',
        role: 'accountant',
      }),
    ).rejects.toThrow(/already/);
    await expect(
      memberships.invite(manager, { name: 'Nope', email: 'nope@test.invalid', role: 'accountant' }),
    ).rejects.toThrow();
  });

  it('records a role change with who, when, before and after (AD-07 acceptance)', async () => {
    const invited = await memberships.invite(admin, {
      name: 'Role Change',
      email: 'role.change@test.invalid',
      role: 'accountant',
    });
    const updated = await memberships.update(admin, invited.membershipId, {
      role: 'property_manager',
    });
    expect(updated.role).toBe('property_manager');
    const events = await ctx.audit.search(agencyId, admin.personId, {
      recordType: 'membership',
      recordId: invited.membershipId,
      action: 'membership.update',
      limit: 5,
    });
    const event = events.events[0]!;
    const data = event.data as { before: { role: string }; after: { role: string } };
    expect(event.actorPersonId).toBe(admin.personId);
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect([data.before.role, data.after.role]).toEqual(['accountant', 'property_manager']);
  });

  it('stops people changing their own role or removing themselves, and lets an admin revoke others', async () => {
    await expect(memberships.update(admin, admin.membershipId, { role: 'owner' })).rejects.toThrow(
      /own role/,
    );
    await expect(memberships.revoke(admin, admin.membershipId)).rejects.toThrow(/yourself/);
    const invited = await memberships.invite(admin, {
      name: 'Leaving',
      email: 'leaving@test.invalid',
      role: 'accountant',
    });
    expect((await memberships.revoke(admin, invited.membershipId)).status).toBe('revoked');
    const directory = await new MembershipDirectory(ctx.database).forPerson(invited.personId);
    expect(directory).toEqual([]);
  });
});

describe('AD-02 required scopes', () => {
  it('refuses a caretaker without a property and an agency adviser without an owner', async () => {
    const policy = new PolicyService();
    const owners = new OwnersService(ctx.database, policy);
    const register = new RegisterService(
      ctx.database,
      policy,
      owners,
      ctx.clock,
      new InMemoryAddressLookup(),
    );
    const ownerId = (await owners.create(admin, { kind: 'individual', displayName: 'Scope Owner' }))
      .id;
    const propertyId = await register.createProperty(admin, {
      areaCode: 'acc',
      propertyPart: 'scp',
      name: 'Scope house',
      propertyType: 'compound_house',
      use: 'residential',
      ownerId,
      address: { region: 'Greater Accra', town: 'Legon', ghanapostGps: 'ga 000 0009' },
      units: [{ unitType: 'single_room', count: 1 }],
    });

    // An invite starts with no scope, so a new caretaker sees nothing until assigned.
    const caretaker = await memberships.invite(admin, {
      name: 'Scoped Caretaker',
      phone: '020 000 0477',
      role: 'caretaker',
    });
    expect(caretaker.scope).toEqual({});
    await expect(
      memberships.update(admin, caretaker.membershipId, { scope: {} }),
    ).rejects.toMatchObject({ code: 'scope.properties_required' });
    await expect(
      memberships.update(admin, caretaker.membershipId, { scope: { properties: [randomUUID()] } }),
    ).rejects.toMatchObject({ code: 'scope_unknown' });
    const saved = await memberships.update(admin, caretaker.membershipId, {
      scope: { owners: [ownerId], properties: [propertyId] },
    });
    expect(saved.scope).toEqual({ properties: [propertyId] });

    const adviser = await memberships.invite(admin, {
      name: 'Scoped Adviser',
      email: 'scoped.adviser@test.invalid',
      role: 'adviser',
    });
    await expect(
      memberships.update(admin, adviser.membershipId, { scope: { properties: [propertyId] } }),
    ).rejects.toMatchObject({ code: 'scope.owners_required' });
    const advised = await memberships.update(admin, adviser.membershipId, {
      scope: { owners: [ownerId] },
    });
    expect(advised.scope).toEqual({ owners: [ownerId] });

    // A role change is checked against the scope the person already has.
    const accountant = await memberships.invite(admin, {
      name: 'Scoped Accountant',
      email: 'scoped.accountant@test.invalid',
      role: 'accountant',
    });
    await expect(
      memberships.update(admin, accountant.membershipId, { role: 'adviser' }),
    ).rejects.toMatchObject({ code: 'scope.owners_required' });
    const moved = await memberships.update(admin, accountant.membershipId, {
      role: 'adviser',
      scope: { owners: [ownerId] },
    });
    expect(moved).toMatchObject({ role: 'adviser', scope: { owners: [ownerId] } });
  });
});
