import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { withCompany, withSystem } from './context';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';
import { connect, createCompany, createPerson, inContext, sqlState } from './testing/fixtures';

/**
 * M3 database guarantees (docs/plans/M3.md sections 4.2, 4.3 and 4.7), proved with raw SQL as the
 * application role, so they hold whatever the services do.
 */
let db: TestDatabase;
let app: pg.Client;
let database: Database;
let agency: string;
let landlord: string;
let staffId: string;
const zero = '0'.repeat(64);

interface Place {
  propertyId: string;
  unitIds: string[];
}
const placeOf: Record<string, Place> = {};

/** A property with one owner and `units` units, as rent_app in `companyId`. */
async function addProperty(companyId: string, code: string, units = 3): Promise<Place> {
  return inContext(app, { companyId, personId: staffId }, async () => {
    const { rows: owners } = await app.query<{ id: string }>(
      "insert into owner (company_id, reference, kind, display_name) values ($1, $2, 'individual', $2) returning id",
      [companyId, `OWN-${code.slice(-3)}`],
    );
    const { rows: portfolios } = await app.query<{ id: string }>(
      'insert into portfolio (company_id, name) values ($1, $2) returning id',
      [companyId, `Portfolio ${code}`],
    );
    const { rows: properties } = await app.query<{ id: string }>(
      `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
       values ($1, $2, $3, split_part($3, '-', 1), $3, 'apartment_block', 'residential', 'Greater Accra') returning id`,
      [companyId, portfolios[0]!.id, code],
    );
    const propertyId = properties[0]!.id;
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [companyId, propertyId, owners[0]!.id],
    );
    const { rows: blocks } = await app.query<{ id: string }>(
      "insert into block (company_id, property_id, code, is_default) values ($1, $2, 'B1', true) returning id",
      [companyId, propertyId],
    );
    const unitIds: string[] = [];
    for (let i = 1; i <= units; i += 1) {
      const label = String(i).padStart(2, '0');
      const { rows } = await app.query<{ id: string }>(
        `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
         values ($1, $2, $3, $4 || '-B1-' || $5, $5, 'apartment', 'self_contained') returning id`,
        [companyId, propertyId, blocks[0]!.id, code, label],
      );
      unitIds.push(rows[0]!.id);
    }
    return { propertyId, unitIds };
  });
}

async function addTenant(companyId: string, name: string, extra: { createdBy?: string } = {}) {
  return inContext(app, { companyId, personId: extra.createdBy ?? staffId }, async () => {
    const { rows } = await app.query<{ id: string }>(
      "insert into tenant (company_id, kind, display_name, created_by) values ($1, 'individual', $2, $3) returning id",
      [companyId, name, extra.createdBy ?? null],
    );
    return rows[0]!.id;
  });
}

async function storedDocument(companyId: string): Promise<string> {
  return inContext(app, { companyId }, async () => {
    const { rows } = await app.query<{ id: string }>(
      "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'lease_scan', 'application/pdf', 1, $2, 'b', $3, true) returning id",
      [companyId, zero, `k-${randomBytes(4).toString('hex')}`],
    );
    return rows[0]!.id;
  });
}

/** A draft lease, optionally recorded as signed on paper and started. */
async function addLease(
  companyId: string,
  place: Place,
  unitIndex: number,
  tenantId: string,
  options: { start?: string; end?: string; to?: 'draft' | 'signed' | 'active' } = {},
): Promise<string> {
  const start = options.start ?? '2026-11-01';
  const end = options.end ?? '2027-10-31';
  const id = await inContext(app, { companyId, personId: staffId }, async () => {
    const { rows } = await app.query<{ id: string }>(
      `insert into lease (company_id, property_id, unit_id, tenant_id, use, start_date, end_date, monthly_rent_minor,
         rent_cycle, notice_days)
       values ($1, $2, $3, $4, 'residential', $5, $6, 150000, 'monthly', 30) returning id`,
      [companyId, place.propertyId, place.unitIds[unitIndex], tenantId, start, end],
    );
    await app.query(
      "insert into lease_party (company_id, property_id, tenant_id, lease_id, party_role, name, position) values ($1, $2, $3, $4, 'tenant', 'Tenant', 1)",
      [companyId, place.propertyId, tenantId, rows[0]!.id],
    );
    return rows[0]!.id;
  });
  if (options.to === 'signed' || options.to === 'active') {
    const documentId = await storedDocument(companyId);
    await inContext(app, { companyId, personId: staffId }, () =>
      app.query(
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
        [id, documentId],
      ),
    );
  }
  if (options.to === 'active')
    await inContext(app, { companyId, personId: staffId }, () =>
      app.query("update lease set status = 'active', activated_on = start_date where id = $1", [
        id,
      ]),
    );
  return id;
}

const asApp = (companyId: string, text: string, values: unknown[] = []) =>
  sqlState(inContext(app, { companyId, personId: staffId }, () => app.query(text, values)));

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  database = createDatabase(db.appUrl, { max: 2 });
  agency = await createCompany(app, 'Tenancy agency', 'agency');
  landlord = await createCompany(app, 'Tenancy landlord', 'landlord');
  staffId = await createPerson(app, 'Tenancy manager');
  placeOf.elg = await addProperty(agency, 'ACC-ELG');
  placeOf.osu = await addProperty(agency, 'ACC-OSU');
  placeOf.tem = await addProperty(landlord, 'TEM-EST', 1);
});

afterAll(async () => {
  await app?.end();
  await database?.close();
  await db?.drop();
});

describe('PB-09 unit cannot be set vacant with an active lease', () => {
  it('lets no rent_app SQL make an occupied unit vacant or not lettable, and refuses a forged occupancy row', async () => {
    const tenantId = await addTenant(agency, 'Occupier');
    const leaseId = await addLease(agency, placeOf.elg!, 0, tenantId, { to: 'active' });
    const unitId = placeOf.elg!.unitIds[0]!;
    // Availability may only stay available or go under repair.
    expect(
      await asApp(agency, "update unit set availability = 'not_lettable' where id = $1", [unitId]),
    ).toBe('RA026');
    expect(
      await asApp(agency, "update unit set availability = 'reserved' where id = $1", [unitId]),
    ).toBe('RA026');
    // "Vacant" is never an availability: the lease check refuses it first, the check constraint
    // on any unit (M2).
    expect(
      await asApp(agency, "update unit set availability = 'vacant' where id = $1", [unitId]),
    ).toBe('RA026');
    expect(
      await asApp(agency, "update unit set availability = 'vacant' where id = $1", [
        placeOf.elg!.unitIds[2],
      ]),
    ).toBe('23514');
    expect(await asApp(agency, 'update unit set archived_at = now() where id = $1', [unitId])).toBe(
      'RA026',
    );
    expect(
      await asApp(agency, "update unit set availability = 'under_repair' where id = $1", [unitId]),
    ).toBeNull();
    // Occupancy has no setter: a history row cannot be inserted, and the lease cannot be removed
    // or ended without a recorded move-out.
    expect(
      await asApp(
        agency,
        "insert into unit_status_event (company_id, property_id, unit_id, kind, from_value, to_value, source) values ($1, $2, $3, 'occupancy', 'occupied', 'vacant', 'lease')",
        [agency, placeOf.elg!.propertyId, unitId],
      ),
    ).toBe('42501');
    expect(await asApp(agency, 'delete from lease where id = $1', [leaseId])).toBe('42501');
    expect(
      await asApp(
        agency,
        "update lease set status = 'ended', ended_on = current_date, end_reason = 'moved_out' where id = $1",
        [leaseId],
      ),
    ).toBe('RA023');
    expect(await asApp(agency, "update lease set status = 'draft' where id = $1", [leaseId])).toBe(
      'RA022',
    );
    const [view] = await runSql<{ occupancy: string }>(
      db.superuserUrl,
      'select occupancy from unit_occupancy where unit_id = $1',
      [unitId],
    );
    expect(view?.occupancy).toBe('occupied');
  });
});

describe('PB-09 occupancy', () => {
  it('derives reserved, occupied and vacant from the lease, and writes each change into the unit history', async () => {
    const tenantId = await addTenant(agency, 'History tenant');
    const leaseId = await addLease(agency, placeOf.elg!, 1, tenantId, { to: 'signed' });
    const unitId = placeOf.elg!.unitIds[1]!;
    await inContext(app, { companyId: agency, personId: staffId }, async () => {
      await app.query("select set_config('app.status_reason', 'Lease started', true)");
      await app.query(
        "update lease set status = 'active', activated_on = start_date where id = $1",
        [leaseId],
      );
    });
    await inContext(app, { companyId: agency, personId: staffId }, () =>
      app.query(
        "update lease set status = 'ended', ended_on = current_date, end_reason = 'moved_out', move_out_date = current_date where id = $1",
        [leaseId],
      ),
    );
    const events = await inContext(app, { companyId: agency }, async () => {
      const { rows } = await app.query<{
        from_value: string;
        to_value: string;
        source: string;
        lease_id: string;
        reason: string | null;
        actor_person_id: string;
      }>(
        "select from_value, to_value, source, lease_id, reason, actor_person_id from unit_status_event where unit_id = $1 and kind = 'occupancy' order by occurred_at, id",
        [unitId],
      );
      return rows;
    });
    expect(events.map((e) => [e.from_value, e.to_value])).toEqual([
      ['vacant', 'reserved'],
      ['reserved', 'occupied'],
      ['occupied', 'vacant'],
    ]);
    expect(events.every((e) => e.source === 'lease' && e.lease_id === leaseId)).toBe(true);
    expect(events[1]!.reason).toBe('Lease started');
    expect(events[0]!.actor_person_id).toBe(staffId);
  });

  it('refuses an overlapping lease on the same unit once both hold it', async () => {
    const first = await addTenant(agency, 'First holder');
    const second = await addTenant(agency, 'Second holder');
    await addLease(agency, placeOf.elg!, 2, first, {
      start: '2027-01-01',
      end: '2027-12-31',
      to: 'signed',
    });
    // A draft may overlap; signing it may not.
    const overlapping = await addLease(agency, placeOf.elg!, 2, second, {
      start: '2027-06-01',
      end: '2028-05-31',
    });
    const documentId = await storedDocument(agency);
    expect(
      await asApp(
        agency,
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
        [overlapping, documentId],
      ),
    ).toBe('23P01');
    // The next day after the first lease ends is free.
    const after = await addLease(agency, placeOf.elg!, 2, second, {
      start: '2028-01-01',
      end: '2028-12-31',
    });
    expect(
      await asApp(
        agency,
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
        [after, documentId],
      ),
    ).toBeNull();
  });
});

describe('TL-06 frozen lease terms and the lease machine', () => {
  it('freezes the terms, parties and steps once issued, and keeps the unit and tenant of a draft', async () => {
    const tenantId = await addTenant(agency, 'Frozen tenant');
    const other = await addTenant(agency, 'Other tenant');
    const draft = await addLease(agency, placeOf.osu!, 0, tenantId, {
      start: '2027-02-01',
      end: '2028-01-31',
    });
    expect(
      await asApp(agency, 'update lease set monthly_rent_minor = 200000 where id = $1', [draft]),
    ).toBeNull();
    // rent_app may not change the tenant at all, and the trigger stops the owner role too.
    expect(
      await asApp(agency, 'update lease set tenant_id = $2 where id = $1', [draft, other]),
    ).toBe('42501');
    expect(
      await sqlState(
        runSql(
          db.ownerUrl,
          `select set_config('app.company_id', '${agency}', false);
           update lease set tenant_id = '${other}' where id = '${draft}'`,
        ),
      ),
    ).toBe('RA021');
    const documentId = await storedDocument(agency);
    await inContext(app, { companyId: agency, personId: staffId }, () =>
      app.query(
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
        [draft, documentId],
      ),
    );
    expect(
      await asApp(agency, 'update lease set monthly_rent_minor = 100000 where id = $1', [draft]),
    ).toBe('RA021');
    expect(
      await asApp(agency, "update lease set end_date = '2029-01-31' where id = $1", [draft]),
    ).toBe('RA021');
    expect(await asApp(agency, 'delete from lease_party where lease_id = $1', [draft])).toBe(
      'RA024',
    );
    expect(
      await asApp(
        agency,
        'insert into rent_step (company_id, property_id, tenant_id, lease_id, effective_from, monthly_rent_minor) values ($1, $2, $3, $4, $5, 1)',
        [agency, placeOf.osu!.propertyId, tenantId, draft, '2027-08-01'],
      ),
    ).toBe('RA024');
    // Trackers still change after signing.
    expect(
      await asApp(
        agency,
        "update lease set rent_control_number = 'RC-1', rent_control_registered_on = current_date where id = $1",
        [draft],
      ),
    ).toBeNull();
  });

  it('starts every lease as a draft and follows the plan 4.7 transitions only', async () => {
    const tenantId = await addTenant(agency, 'Machine tenant');
    expect(
      await asApp(
        agency,
        `insert into lease (company_id, property_id, unit_id, tenant_id, status, use, start_date, end_date, monthly_rent_minor, rent_cycle, notice_days)
         values ($1, $2, $3, $4, 'active', 'residential', '2027-03-01', '2028-02-29', 100000, 'monthly', 30)`,
        [agency, placeOf.osu!.propertyId, placeOf.osu!.unitIds[1], tenantId],
      ),
    ).toBe('RA028');
    const draft = await addLease(agency, placeOf.osu!, 1, tenantId, {
      start: '2027-03-01',
      end: '2028-02-29',
    });
    expect(
      await asApp(
        agency,
        "update lease set status = 'active', activated_on = start_date where id = $1",
        [draft],
      ),
    ).toBe('RA022');
    // Signing from a draft is a paper signing, and needs the scan.
    expect(
      await asApp(
        agency,
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper' where id = $1",
        [draft],
      ),
    ).toBe('RA023');
    expect(
      await asApp(
        agency,
        "update lease set status = 'signed', signed_at = now(), signing_method = 'esign' where id = $1",
        [draft],
      ),
    ).toBe('RA023');
    expect(
      await asApp(agency, "update lease set status = 'cancelled' where id = $1", [draft]),
    ).toBe('RA023');
    expect(
      await asApp(
        agency,
        "update lease set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Tenant withdrew' where id = $1",
        [draft],
      ),
    ).toBeNull();
    expect(await asApp(agency, "update lease set status = 'draft' where id = $1", [draft])).toBe(
      'RA022',
    );
  });

  it('keeps the rent schedule for signed leases only', async () => {
    const tenantId = await addTenant(agency, 'Schedule tenant');
    const draft = await addLease(agency, placeOf.osu!, 2, tenantId, {
      start: '2027-04-01',
      end: '2028-03-31',
    });
    const insert = () =>
      asApp(
        agency,
        "insert into charge_period (company_id, property_id, tenant_id, lease_id, sequence, charge_type, period_start, period_end, amount_minor) values ($1, $2, $3, $4, 0, 'rent', '2027-04-01', '2027-04-30', 150000)",
        [agency, placeOf.osu!.propertyId, tenantId, draft],
      );
    expect(await insert()).toBe('RA025');
    const documentId = await storedDocument(agency);
    await inContext(app, { companyId: agency, personId: staffId }, () =>
      app.query(
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
        [draft, documentId],
      ),
    );
    expect(await insert()).toBeNull();
    expect(await insert()).toBe('23505'); // one row per charge type and period
    expect(
      await asApp(agency, 'update charge_period set amount_minor = 1 where lease_id = $1', [draft]),
    ).toBe('42501');
  });
});

describe('AD-05 cancelling a signed lease in the database', () => {
  it('refuses to cancel a signed lease without a second person’s approval', async () => {
    const tenantId = await addTenant(landlord, 'Cancel tenant');
    const leaseId = await addLease(landlord, placeOf.tem!, 0, tenantId, {
      start: '2027-05-01',
      end: '2028-04-30',
      to: 'signed',
    });
    const cancel = () =>
      asApp(
        landlord,
        "update lease set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Changed mind' where id = $1",
        [leaseId],
      );
    expect(await cancel()).toBe('RA027');
    // An approval decided by the initiator does not count; the database refuses it anyway.
    const approver = await createPerson(app, 'Second approver');
    const memberships = await inContext(app, { companyId: landlord }, async () => {
      const initiator = await app.query<{ id: string }>(
        "insert into membership (company_id, person_id, role) values ($1, $2, 'owner') returning id",
        [landlord, staffId],
      );
      const second = await app.query<{ id: string }>(
        "insert into membership (company_id, person_id, role) values ($1, $2, 'property_manager') returning id",
        [landlord, approver],
      );
      return { initiator: initiator.rows[0]!.id, second: second.rows[0]!.id };
    });
    await inContext(app, { companyId: landlord, personId: staffId }, async () => {
      const { rows } = await app.query<{ id: string }>(
        `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash, initiated_by,
           initiator_membership_id, mode, status, expires_at)
         values ($1, 'lease.cancel_signed', 'lease', $2, '{}', 'h', $3, $4, 'two_person', 'pending', now() + interval '1 day') returning id`,
        [landlord, leaseId, staffId, memberships.initiator],
      );
      await app.query(
        "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
        [landlord, rows[0]!.id, approver, memberships.second],
      );
    });
    expect(await cancel()).toBeNull();
  });
});

describe('TL-05 template versions in the database', () => {
  it('never changes a version, and records its counsel review once', async () => {
    const versionId = await inContext(app, { companyId: agency, personId: staffId }, async () => {
      const { rows: templates } = await app.query<{ id: string }>(
        "insert into lease_template (company_id, name, kind) values ($1, 'Custom', 'custom') returning id",
        [agency],
      );
      const { rows } = await app.query<{ id: string }>(
        'insert into lease_template_version (company_id, template_id, version, content, content_sha256) values ($1, $2, 1, \'{"sections": []}\', $3) returning id',
        [agency, templates[0]!.id, zero],
      );
      return rows[0]!.id;
    });
    expect(
      await asApp(
        agency,
        "update lease_template_version set change_note = 'edited' where id = $1",
        [versionId],
      ),
    ).toBe('42501');
    const review = () =>
      asApp(
        agency,
        "update lease_template_version set counsel_reviewed_at = now(), counsel_reviewed_by = $2, counsel_review_note = 'Reviewed by our lawyer' where id = $1",
        [versionId, staffId],
      );
    expect(await review()).toBeNull();
    expect(await review()).toBe('RA020');
    expect(
      await sqlState(
        runSql(
          db.ownerUrl,
          `select set_config('app.company_id', '${agency}', false);
           update lease_template_version set content = '{}' where id = '${versionId}'`,
        ),
      ),
    ).toBe('RA020');
  });
});

describe('NFR-SEC tenant and property scope predicates', () => {
  it('shows a tenant session only its own tenant, issued leases and their properties', async () => {
    const mine = await addTenant(agency, 'Scoped tenant');
    const theirs = await addTenant(agency, 'Someone else');
    const issued = await addLease(agency, placeOf.osu!, 0, mine, {
      start: '2029-01-01',
      end: '2029-12-31',
      to: 'signed',
    });
    await addLease(agency, placeOf.elg!, 0, mine, { start: '2031-01-01', end: '2031-12-31' }); // a draft
    await addLease(agency, placeOf.osu!, 1, theirs, {
      start: '2029-01-01',
      end: '2029-12-31',
      to: 'signed',
    });
    const seen = await withCompany(
      database,
      { companyId: agency, actorKind: 'tenant', tenantScope: { tenantIds: [mine] } },
      async (tx) => {
        const tenants = await tx.execute<{ id: string }>(sql`select id from tenant`);
        const leases = await tx.execute<{ id: string }>(sql`select id from lease`);
        const properties = await tx.execute<{ code: string }>(sql`select code from property`);
        const owners = await tx.execute<{ id: string }>(sql`select id from owner`);
        const parties = await tx.execute<{ lease_id: string }>(
          sql`select distinct lease_id from lease_party`,
        );
        const templates = await tx.execute(sql`select id from lease_template`);
        return {
          tenants: tenants.rows.map((r) => r.id),
          leases: leases.rows.map((r) => r.id),
          properties: properties.rows.map((r) => r.code),
          owners: owners.rows.length,
          parties: parties.rows.map((r) => r.lease_id),
          templates: templates.rows.length,
        };
      },
    );
    expect(seen).toEqual({
      tenants: [mine],
      leases: [issued],
      properties: ['ACC-OSU'],
      owners: 0,
      parties: [issued],
      templates: 0,
    });
  });

  it('shows scoped staff a tenant through its leases in scope, or as its creator before any lease exists', async () => {
    const creator = await createPerson(app, 'Scoped creator');
    const inScope = await addTenant(agency, 'Osu lodger');
    const outOfScope = await addTenant(agency, 'East Legon lodger');
    const fresh = await addTenant(agency, 'New prospect', { createdBy: creator });
    const othersFresh = await addTenant(agency, 'Someone’s prospect');
    await addLease(agency, placeOf.osu!, 2, inScope, { start: '2030-01-01', end: '2030-12-31' });
    await addLease(agency, placeOf.elg!, 1, outOfScope, {
      start: '2030-01-01',
      end: '2030-12-31',
    });
    const visible = (personId: string) =>
      withCompany(
        database,
        {
          companyId: agency,
          personId,
          actorKind: 'staff',
          scope: { ownerIds: [], propertyIds: [placeOf.osu!.propertyId] },
        },
        async (tx) =>
          (await tx.execute<{ id: string }>(sql`select id from tenant`)).rows.map((r) => r.id),
      );
    const seen = await visible(creator);
    expect(seen).toContain(inScope);
    expect(seen).toContain(fresh);
    expect(seen).not.toContain(outOfScope);
    expect(seen).not.toContain(othersFresh);
    // Once the prospect has a lease outside the scope, the creator no longer sees it.
    await addLease(agency, placeOf.elg!, 2, fresh, { start: '2032-01-01', end: '2032-12-31' });
    expect(await visible(creator)).not.toContain(fresh);
    // Contacts follow their tenant.
    await inContext(app, { companyId: agency }, () =>
      app.query(
        "insert into tenant_contact (company_id, tenant_id, kind, name) values ($1, $2, 'next_of_kin', 'Kin'), ($1, $3, 'next_of_kin', 'Kin')",
        [agency, inScope, outOfScope],
      ),
    );
    const contacts = await withCompany(
      database,
      {
        companyId: agency,
        actorKind: 'staff',
        scope: { ownerIds: [], propertyIds: [placeOf.osu!.propertyId] },
      },
      async (tx) =>
        (await tx.execute<{ tenant_id: string }>(sql`select tenant_id from tenant_contact`)).rows,
    );
    expect(contacts.map((c) => c.tenant_id)).toEqual([inScope]);
  });

  it('refuses a tenant session without its tenant scope, and shows an empty scope nothing', async () => {
    await expect(
      withCompany(database, { companyId: agency, actorKind: 'tenant' }, async () => 'opened'),
    ).rejects.toThrow('A tenant session needs its tenant scope');
    await expect(
      withCompany(
        database,
        { companyId: agency, actorKind: 'staff', tenantScope: { tenantIds: [] } },
        async () => 'opened',
      ),
    ).rejects.toThrow('Only a tenant session has a tenant scope');
    const seen = await withCompany(
      database,
      { companyId: agency, actorKind: 'tenant', tenantScope: { tenantIds: [] } },
      async (tx) => (await tx.execute(sql`select id from tenant`)).rows.length,
    );
    expect(seen).toBe(0);
  });
});

describe('TL-01 one person, two landlords, in the database', () => {
  it('links both companies’ tenants to one person, with the same answer whether or not the person existed', async () => {
    const phone = '+233200000077';
    const link = (companyId: string, name: string) =>
      withCompany(database, { companyId, actorKind: 'staff' }, async (tx) => {
        const result = await tx.execute<Record<string, unknown>>(
          sql`select app.ensure_tenant_person(${phone}, ${name}, true) as person_id`,
        );
        return result.rows[0]!;
      });
    const first = await link(agency, 'Esi at the agency');
    const second = await link(landlord, 'E. Mensah at the landlord');
    expect(Object.keys(first)).toEqual(['person_id']);
    expect(Object.keys(second)).toEqual(['person_id']);
    expect(second.person_id).toBe(first.person_id);
    // The person keeps the first name it was given; the second company changed nothing.
    const [person] = await runSql<{ name: string; email: string }>(
      db.superuserUrl,
      'select name, email from person where id = $1',
      [first.person_id],
    );
    expect(person!.name).toBe('Esi at the agency');
    expect(person!.email).toMatch(/@users\.invalid$/);
    // Outside a company transaction the function refuses.
    expect(
      await sqlState(
        withSystem(database, {}, (tx) =>
          tx.execute(sql`select app.ensure_tenant_person(${phone}, null, false)`),
        ),
      ),
    ).toBe('RA029');
  });

  it('lists a person’s tenancies as ids only, and only for that person acting as a tenant', async () => {
    const personId = await createPerson(app, 'Two-landlord tenant');
    for (const companyId of [agency, landlord])
      await inContext(app, { companyId }, () =>
        app.query(
          "insert into tenant (company_id, kind, display_name, person_id) values ($1, 'individual', 'Kofi', $2)",
          [companyId, personId],
        ),
      );
    const list = (ctx: { personId?: string; actorKind?: 'tenant' | 'staff' }) =>
      withSystem(
        database,
        { personId: ctx.personId, actorKind: ctx.actorKind },
        async (tx) =>
          (
            await tx.execute<Record<string, unknown>>(
              sql`select * from app.tenancies_for_person(${personId}::uuid)`,
            )
          ).rows,
      );
    const mine = await list({ personId, actorKind: 'tenant' });
    expect(mine).toHaveLength(2);
    expect(Object.keys(mine[0]!).sort()).toEqual(['company_id', 'tenant_id']);
    expect(mine.map((r) => r.company_id).sort()).toEqual([agency, landlord].sort());
    expect(await list({ personId: staffId, actorKind: 'tenant' })).toEqual([]);
    expect(await list({ personId, actorKind: 'staff' })).toEqual([]);
    // Neither company sees the other's record or its person link.
    for (const [companyId, other] of [
      [agency, landlord],
      [landlord, agency],
    ] as const) {
      const rows = await withCompany(
        database,
        { companyId, actorKind: 'staff' },
        async (tx) =>
          (
            await tx.execute<{ company_id: string }>(
              sql`select company_id from tenant where person_id = ${personId}`,
            )
          ).rows,
      );
      expect(rows.map((r) => r.company_id)).toEqual([companyId]);
      expect(rows.map((r) => r.company_id)).not.toContain(other);
    }
  });
});

describe('CM-09 consent groundwork in the database', () => {
  it('keeps consent and message records append-only', async () => {
    const tenantId = await addTenant(agency, 'Consenting tenant');
    await inContext(app, { companyId: agency, personId: staffId }, () =>
      app.query(
        "insert into consent_event (company_id, tenant_id, channel, action, text_version, text_sha256, recorded_by) values ($1, $2, 'sms', 'grant', 'messages.v1', $3, $4)",
        [agency, tenantId, zero, staffId],
      ),
    );
    expect(
      await asApp(agency, "update consent_event set action = 'withdraw' where tenant_id = $1", [
        tenantId,
      ]),
    ).toBe('42501');
    expect(await asApp(agency, 'delete from consent_event where tenant_id = $1', [tenantId])).toBe(
      '42501',
    );
    expect(
      await sqlState(
        runSql(
          db.ownerUrl,
          `select set_config('app.company_id', '${agency}', false);
           update consent_event set action = 'withdraw' where tenant_id = '${tenantId}'`,
        ),
      ),
    ).toBe('RA001');
  });
});

describe('OQ-44 and OQ-45 rules rows', () => {
  it('adds the stamping deadline and the writing exemption as unverified rules', async () => {
    const rows = await runSql<{
      key: string;
      value: unknown;
      verification_status: string;
      source: string;
    }>(
      db.ownerUrl,
      "select key, value, verification_status, source from rule where key in ('stamp_duty.deadline_months', 'lease.writing_exemption_max_years') order by key",
    );
    expect(rows.map((r) => [r.key, r.value, r.verification_status])).toEqual([
      ['lease.writing_exemption_max_years', { years: 3 }, 'unverified'],
      ['stamp_duty.deadline_months', { months: 2 }, 'unverified'],
    ]);
    expect(rows[0]!.source).toContain('OQ-44');
    expect(rows[1]!.source).toContain('OQ-45');
  });
});
