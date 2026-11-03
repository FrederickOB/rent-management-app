import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';
import { connect, createCompany, createPerson, inContext, sqlState } from './testing/fixtures';

/**
 * The M3 review's database guarantees (findings 2, 3, 8 and 12, and the tenant foreign keys),
 * proved with raw SQL as the application role, so they hold whatever the services do.
 */
let db: TestDatabase;
let app: pg.Client;
let agency: string;
let staffId: string;
const zero = '0'.repeat(64);
const other = 'f'.repeat(64);

interface Place {
  propertyId: string;
  unitIds: string[];
}

async function addProperty(companyId: string, code: string, units = 2): Promise<Place> {
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

async function addTenant(companyId: string, name: string) {
  return inContext(app, { companyId, personId: staffId }, async () => {
    const { rows } = await app.query<{ id: string }>(
      "insert into tenant (company_id, kind, display_name) values ($1, 'individual', $2) returning id",
      [companyId, name],
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

const asApp = (companyId: string, text: string, values: unknown[] = []) =>
  sqlState(inContext(app, { companyId, personId: staffId }, () => app.query(text, values)));

/** A draft lease; `to` moves it on as the services would, with what each state records. */
async function addLease(
  place: Place,
  unitIndex: number,
  tenantId: string,
  options: {
    start: string;
    end: string;
    renews?: string;
    to?: 'draft' | 'pending' | 'signed' | 'active' | 'holding_over' | 'ending';
  },
): Promise<string> {
  const id = await inContext(app, { companyId: agency, personId: staffId }, async () => {
    const { rows } = await app.query<{ id: string }>(
      `insert into lease (company_id, property_id, unit_id, tenant_id, use, start_date, end_date, monthly_rent_minor,
         rent_cycle, notice_days, renews_lease_id)
       values ($1, $2, $3, $4, 'residential', $5, $6, 150000, 'monthly', 30, $7) returning id`,
      [
        agency,
        place.propertyId,
        place.unitIds[unitIndex],
        tenantId,
        options.start,
        options.end,
        options.renews ?? null,
      ],
    );
    return rows[0]!.id;
  });
  const to = options.to ?? 'draft';
  if (to === 'pending')
    expect(
      await asApp(agency, "update lease set status = 'pending_signatures' where id = $1", [id]),
    ).toBeNull();
  if (['signed', 'active', 'holding_over', 'ending'].includes(to)) {
    const documentId = await storedDocument(agency);
    expect(
      await asApp(
        agency,
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
        [id, documentId],
      ),
    ).toBeNull();
  }
  if (['active', 'holding_over', 'ending'].includes(to))
    expect(
      await asApp(
        agency,
        "update lease set status = 'active', activated_on = start_date where id = $1",
        [id],
      ),
    ).toBeNull();
  if (to === 'holding_over')
    expect(
      await asApp(
        agency,
        "update lease set status = 'holding_over', holding_over_since = end_date + 1 where id = $1",
        [id],
      ),
    ).toBeNull();
  if (to === 'ending')
    expect(
      await asApp(
        agency,
        "update lease set status = 'ending', ending_reason = 'non_renewal', ending_recorded_at = now() where id = $1",
        [id],
      ),
    ).toBeNull();
  return id;
}

const chargePeriod = (
  lease: { id: string; place: Place; tenantId: string },
  from: string,
  to: string,
  sequence: number,
) =>
  asApp(
    agency,
    `insert into charge_period (company_id, property_id, tenant_id, lease_id, sequence, charge_type, period_start,
       period_end, amount_minor, source)
     values ($1, $2, $3, $4, $5, 'rent', $6, $7, 150000, 'holding_over')`,
    [agency, lease.place.propertyId, lease.tenantId, lease.id, sequence, from, to],
  );

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  agency = await createCompany(app, 'Guards agency', 'agency');
  staffId = await createPerson(app, 'Guards manager');
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('TL-07 signed evidence is written once, in the database', () => {
  it('sets a lease’s signed copy, time and method once, as it becomes signed, and never again', async () => {
    const place = await addProperty(agency, 'ACC-EVL', 1);
    const tenantId = await addTenant(agency, 'Evidence tenant');
    const lease = await addLease(place, 0, tenantId, { start: '2031-01-01', end: '2031-12-31' });
    const [first, second] = [await storedDocument(agency), await storedDocument(agency)];
    // A draft claims no signed copy, time or method.
    for (const [change, values] of [
      ['signed_document_id = $2', [lease, first]],
      ['signed_at = now()', [lease]],
      ["signing_method = 'paper'", [lease]],
    ] as const)
      expect(await asApp(agency, `update lease set ${change} where id = $1`, [...values])).toBe(
        'RA034',
      );
    // Becoming signed sets all three, once.
    expect(
      await asApp(
        agency,
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
        [lease, first],
      ),
    ).toBeNull();
    for (const [change, values] of [
      ['signed_document_id = $2', [lease, second]],
      ['signed_document_id = null', [lease]],
      ["signed_at = now() + interval '1 day'", [lease]],
      ["signing_method = 'esign'", [lease]],
    ] as const)
      expect(await asApp(agency, `update lease set ${change} where id = $1`, [...values])).toBe(
        'RA034',
      );
    // The owner role is refused too; the trackers still change.
    expect(
      await sqlState(
        runSql(
          db.ownerUrl,
          `select set_config('app.company_id', '${agency}', false);
           update lease set signed_document_id = '${second}' where id = '${lease}'`,
        ),
      ),
    ).toBe('RA034');
    expect(
      await asApp(agency, 'update lease set stamped_on = current_date where id = $1', [lease]),
    ).toBeNull();
  });

  it('keeps a completed, declined or cancelled signing request closed, and its fingerprints fixed', async () => {
    const place = await addProperty(agency, 'ACC-EVR', 3);
    const tenantId = await addTenant(agency, 'Request tenant');
    const request = async (unitIndex: number) => {
      const lease = await addLease(place, unitIndex, tenantId, {
        start: '2031-01-01',
        end: '2031-12-31',
        to: 'pending',
      });
      return inContext(app, { companyId: agency }, async () => {
        const { rows } = await app.query<{ id: string }>(
          "insert into signing_request (company_id, property_id, tenant_id, subject_type, lease_id) values ($1, $2, $3, 'lease', $4) returning id",
          [agency, place.propertyId, tenantId, lease],
        );
        return rows[0]!.id;
      });
    };
    const update = (id: string, change: string, values: unknown[] = []) =>
      asApp(agency, `update signing_request set ${change} where id = $1`, [id, ...values]);
    const [frozen, html, signed, again] = [
      await storedDocument(agency),
      await storedDocument(agency),
      await storedDocument(agency),
      await storedDocument(agency),
    ];
    const opened = async (id: string) =>
      expect(
        await update(
          id,
          "status = 'pending', document_id = $2, document_sha256 = $3, html_document_id = $4, html_sha256 = $3, opened_at = now()",
          [frozen, zero, html],
        ),
      ).toBeNull();

    // Opened once: its fingerprints are fixed. Finalised: it stays completed.
    const completed = await request(0);
    await opened(completed);
    expect(await update(completed, 'document_sha256 = $2', [other])).toBe('RA035');
    expect(await update(completed, 'html_document_id = $2', [again])).toBe('RA035');
    expect(
      await update(
        completed,
        "status = 'completed', final_document_id = $2, final_sha256 = $3, completed_at = now()",
        [signed, zero],
      ),
    ).toBeNull();
    for (const [change, values] of [
      ["status = 'pending'", []],
      ["status = 'cancelled', cancelled_at = now(), cancel_reason = 'Recalled'", []],
      ['final_document_id = $2', [again]],
      ['final_sha256 = $2', [other]],
      ["completed_at = now() + interval '1 hour'", []],
    ] as const)
      expect(await update(completed, change, [...values])).toBe('RA035');

    // Declined and cancelled are final too; declining and recalling still work.
    const declined = await request(1);
    await opened(declined);
    expect(
      await update(declined, "status = 'declined', declined_at = now(), decline_reason = 'No'"),
    ).toBeNull();
    expect(await update(declined, "status = 'pending'")).toBe('RA035');
    const cancelled = await request(2);
    expect(
      await update(
        cancelled,
        "status = 'cancelled', cancelled_at = now(), cancel_reason = 'Recalled'",
      ),
    ).toBeNull();
    expect(await update(cancelled, "status = 'pending'")).toBe('RA035');
    expect(await update(cancelled, "status = 'preparing'")).toBe('RA035');
  });

  it('keeps a signature or a decline final, while opens and code locks still change', async () => {
    const place = await addProperty(agency, 'ACC-EVS', 1);
    const tenantId = await addTenant(agency, 'Signer tenant');
    const lease = await addLease(place, 0, tenantId, {
      start: '2031-01-01',
      end: '2031-12-31',
      to: 'pending',
    });
    const frozen = await storedDocument(agency);
    const [signerA, signerB] = await inContext(app, { companyId: agency }, async () => {
      const { rows } = await app.query<{ id: string }>(
        `insert into signing_request (company_id, property_id, tenant_id, subject_type, lease_id, status, document_id, document_sha256)
         values ($1, $2, $3, 'lease', $4, 'pending', $5, $6) returning id`,
        [agency, place.propertyId, tenantId, lease, frozen, zero],
      );
      const ids: string[] = [];
      for (const position of [1, 2]) {
        const signer = await app.query<{ id: string }>(
          `insert into signer (company_id, property_id, tenant_id, signing_request_id, signer_role, subject_type, name, phone, position)
           values ($1, $2, $3, $4, 'tenant', 'tenant', 'Signer', '+233200000099', $5) returning id`,
          [agency, place.propertyId, tenantId, rows[0]!.id, position],
        );
        ids.push(signer.rows[0]!.id);
      }
      return ids;
    });
    const update = (id: string, change: string) =>
      asApp(agency, `update signer set ${change} where id = $1`, [id]);
    expect(await update(signerA!, "status = 'signed', signed_at = now()")).toBeNull();
    // Opens are still recorded on a signer who has signed (their signed-copy link).
    expect(await update(signerA!, 'last_opened_at = now(), updated_at = now()')).toBeNull();
    for (const change of [
      "status = 'pending'",
      "status = 'declined', declined_at = now(), decline_reason = 'No'",
      "signed_at = now() + interval '1 hour'",
      'signed_at = null',
    ])
      expect(await update(signerA!, change)).toBe('RA036');
    // A lock, a decline, then the hourly lift of the lock.
    expect(
      await update(
        signerB!,
        "failed_code_attempts = 5, locked_until = now() + interval '30 minutes'",
      ),
    ).toBeNull();
    expect(
      await update(signerB!, "status = 'declined', declined_at = now(), decline_reason = 'No'"),
    ).toBeNull();
    expect(await update(signerB!, 'failed_code_attempts = 0, locked_until = null')).toBeNull();
    expect(await update(signerB!, "status = 'signed', signed_at = now()")).toBe('RA036');
    expect(await update(signerB!, "declined_at = now() + interval '1 hour'")).toBe('RA036');
  });
});

describe('PB-09 a lease out for signature holds its unit, in the database', () => {
  it('refuses an overlapping lease, archiving and not lettable while one waits for signatures', async () => {
    const place = await addProperty(agency, 'ACC-PND', 2);
    const [x, y] = [await addTenant(agency, 'Waiting X'), await addTenant(agency, 'Waiting Y')];
    await addLease(place, 0, x, { start: '2031-01-01', end: '2031-12-31', to: 'pending' });
    const overlapping = await addLease(place, 0, y, { start: '2031-06-01', end: '2032-05-31' });
    expect(
      await asApp(agency, "update lease set status = 'pending_signatures' where id = $1", [
        overlapping,
      ]),
    ).toBe('23P01');
    const documentId = await storedDocument(agency);
    expect(
      await asApp(
        agency,
        "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
        [overlapping, documentId],
      ),
    ).toBe('23P01');
    const unitId = place.unitIds[0]!;
    expect(await asApp(agency, 'update unit set archived_at = now() where id = $1', [unitId])).toBe(
      'RA026',
    );
    expect(
      await asApp(agency, "update unit set availability = 'not_lettable' where id = $1", [unitId]),
    ).toBe('RA026');
    // A unit archived first can never be sent for signing.
    const archived = place.unitIds[1]!;
    const draft = await addLease(place, 1, x, { start: '2031-01-01', end: '2031-12-31' });
    expect(
      await asApp(agency, 'update unit set archived_at = now() where id = $1', [archived]),
    ).toBeNull();
    expect(
      await asApp(agency, "update lease set status = 'pending_signatures' where id = $1", [draft]),
    ).toBe('RA026');
  });
});

describe('TL-06 holding over in the database', () => {
  it('refuses a new lease while the tenant holds over, and a renewal that starts on a charged day', async () => {
    const place = await addProperty(agency, 'ACC-HOV', 2);
    const tenantId = await addTenant(agency, 'Holding tenant');
    const held = {
      id: await addLease(place, 0, tenantId, {
        start: '2025-01-01',
        end: '2025-12-31',
        to: 'holding_over',
      }),
      place,
      tenantId,
    };
    expect(await chargePeriod(held, '2026-01-01', '2026-01-31', 12)).toBeNull();
    const newcomer = await addTenant(agency, 'Newcomer');
    const next = await addLease(place, 0, newcomer, { start: '2026-03-01', end: '2027-02-28' });
    expect(
      await asApp(agency, "update lease set status = 'pending_signatures' where id = $1", [next]),
    ).toBe('RA030');
    const renewal = await addLease(place, 0, tenantId, {
      start: '2026-01-15',
      end: '2027-01-14',
      renews: held.id,
    });
    expect(
      await asApp(agency, "update lease set status = 'pending_signatures' where id = $1", [
        renewal,
      ]),
    ).toBe('RA031');
    expect(
      await asApp(
        agency,
        "update lease set start_date = '2026-02-01', end_date = '2027-01-31' where id = $1",
        [renewal],
      ),
    ).toBeNull();
    expect(
      await asApp(agency, "update lease set status = 'pending_signatures' where id = $1", [
        renewal,
      ]),
    ).toBeNull();
    // The held-over lease charges nothing from the day the renewal holds the unit.
    expect(await chargePeriod(held, '2026-02-01', '2026-02-28', 13)).toBe('RA032');

    // A lease ending past its end date, with no move-out recorded, holds over too.
    const ending = await addLease(place, 1, tenantId, {
      start: '2024-06-01',
      end: '2025-05-31',
      to: 'ending',
    });
    expect(ending).toBeTruthy();
    const after = await addLease(place, 1, newcomer, { start: '2026-08-01', end: '2027-07-31' });
    expect(
      await asApp(agency, "update lease set status = 'pending_signatures' where id = $1", [after]),
    ).toBe('RA030');
  });

  it('serialises a renewal and a held-over month on one unit across concurrent transactions', async () => {
    const place = await addProperty(agency, 'ACC-CCY', 2);
    const tenantId = await addTenant(agency, 'Concurrent tenant');
    const heldOver = async (unitIndex: number) => {
      const lease = {
        id: await addLease(place, unitIndex, tenantId, {
          start: '2025-01-01',
          end: '2025-12-31',
          to: 'holding_over',
        }),
        place,
        tenantId,
      };
      expect(await chargePeriod(lease, '2026-01-01', '2026-01-31', 12)).toBeNull();
      const renewal = await addLease(place, unitIndex, tenantId, {
        start: '2026-02-15',
        end: '2027-02-14',
        renews: lease.id,
      });
      return { lease, renewal };
    };
    const first = await connect(db.appUrl);
    const second = await connect(db.appUrl);
    const begin = async (client: pg.Client) => {
      await client.query('begin');
      await client.query(
        "select set_config('app.company_id', $1, true), set_config('app.actor_kind', 'system', true)",
        [agency],
      );
    };
    const settled = (promise: Promise<unknown>) => {
      let done = false;
      void promise.then(
        () => (done = true),
        () => (done = true),
      );
      return () => done;
    };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
    try {
      // The renewal goes out first: the month held over waits for it, then is refused.
      const a = await heldOver(0);
      await begin(first);
      await first.query("update lease set status = 'pending_signatures' where id = $1", [
        a.renewal,
      ]);
      await begin(second);
      const charge = sqlState(
        second.query(
          `insert into charge_period (company_id, property_id, tenant_id, lease_id, sequence, charge_type,
             period_start, period_end, amount_minor, source)
           values ($1, $2, $3, $4, 13, 'rent', '2026-02-01', '2026-02-28', 150000, 'holding_over')`,
          [agency, place.propertyId, tenantId, a.lease.id],
        ),
      );
      const chargeDone = settled(charge);
      await pause();
      expect(chargeDone()).toBe(false);
      await first.query('commit');
      expect(await charge).toBe('RA032');
      await second.query('rollback');

      // The month is charged first: the renewal waits for it, then is refused.
      const b = await heldOver(1);
      await begin(second);
      await second.query(
        `insert into charge_period (company_id, property_id, tenant_id, lease_id, sequence, charge_type,
           period_start, period_end, amount_minor, source)
         values ($1, $2, $3, $4, 13, 'rent', '2026-02-01', '2026-02-28', 150000, 'holding_over')`,
        [agency, place.propertyId, tenantId, b.lease.id],
      );
      await begin(first);
      const issue = sqlState(
        first.query("update lease set status = 'pending_signatures' where id = $1", [b.renewal]),
      );
      const issueDone = settled(issue);
      await pause();
      expect(issueDone()).toBe(false);
      await second.query('commit');
      expect(await issue).toBe('RA031');
      await first.query('rollback');
    } finally {
      await first.end();
      await second.end();
    }
  });
});

describe('TL-01 archiving a tenant in the database', () => {
  it('refuses archiving a tenant who holds a lease, whatever the session can see', async () => {
    const [inScope, outOfScope] = [
      await addProperty(agency, 'ACC-ARA', 1),
      await addProperty(agency, 'ACC-ARB', 1),
    ];
    const tenantId = await addTenant(agency, 'Two-property tenant');
    const ended = await addLease(inScope, 0, tenantId, {
      start: '2024-01-01',
      end: '2024-12-31',
      to: 'active',
    });
    expect(
      await asApp(
        agency,
        "update lease set status = 'ended', end_reason = 'moved_out', move_out_date = '2024-12-31', ended_on = '2024-12-31' where id = $1",
        [ended],
      ),
    ).toBeNull();
    await addLease(outOfScope, 0, tenantId, {
      start: '2031-01-01',
      end: '2031-12-31',
      to: 'pending',
    });
    // A session scoped to the first property sees the tenant, but not the lease that holds them.
    const archive = await sqlState(
      inContext(app, { companyId: agency, personId: staffId }, async () => {
        await app.query("select set_config('app.property_scope', $1, true)", [
          `{${inScope.propertyId}}`,
        ]);
        const { rows } = await app.query<{ n: number }>(
          'select count(*)::int as n from lease where tenant_id = $1',
          [tenantId],
        );
        expect(rows[0]!.n).toBe(1);
        return app.query('update tenant set archived_at = now() where id = $1', [tenantId]);
      }),
    );
    expect(archive).toBe('RA033');
    // A tenant with only a draft holds nothing, and can be archived.
    const done = await addTenant(agency, 'Former tenant');
    const past = await addLease(inScope, 0, done, { start: '2023-01-01', end: '2023-12-31' });
    expect(past).toBeTruthy();
    expect(
      await asApp(agency, 'update tenant set archived_at = now() where id = $1', [done]),
    ).toBeNull();
  });
});

describe('NFR-SEC the e-signing rows carry their request’s tenant', () => {
  it('refuses a signer, link, code, signature or event that names another tenant', async () => {
    const place = await addProperty(agency, 'ACC-FKT', 1);
    const [mine, theirs] = [await addTenant(agency, 'Mine'), await addTenant(agency, 'Theirs')];
    const lease = await addLease(place, 0, mine, {
      start: '2031-01-01',
      end: '2031-12-31',
      to: 'pending',
    });
    const frozen = await storedDocument(agency);
    const { requestId, signerId, linkId, challengeId } = await inContext(
      app,
      { companyId: agency },
      async () => {
        const request = await app.query<{ id: string }>(
          `insert into signing_request (company_id, property_id, tenant_id, subject_type, lease_id, status, document_id, document_sha256)
           values ($1, $2, $3, 'lease', $4, 'pending', $5, $6) returning id`,
          [agency, place.propertyId, mine, lease, frozen, zero],
        );
        const signer = await app.query<{ id: string }>(
          `insert into signer (company_id, property_id, tenant_id, signing_request_id, signer_role, subject_type, name, phone, position)
           values ($1, $2, $3, $4, 'tenant', 'tenant', 'Mine', '+233200000098', 1) returning id`,
          [agency, place.propertyId, mine, request.rows[0]!.id],
        );
        const link = await app.query<{ id: string }>(
          `insert into secure_link (company_id, property_id, tenant_id, purpose, token_hash, signer_id, expires_at)
           values ($1, $2, $3, 'sign', $4, $5, now() + interval '30 days') returning id`,
          [agency, place.propertyId, mine, randomBytes(32).toString('hex'), signer.rows[0]!.id],
        );
        const challenge = await app.query<{ id: string }>(
          `insert into otp_challenge (company_id, property_id, tenant_id, signer_id, secure_link_id, channel,
             destination_masked, destination_hash, code_hash, expires_at)
           values ($1, $2, $3, $4, $5, 'sms', 'x', 'h', 'c', now() + interval '10 minutes') returning id`,
          [agency, place.propertyId, mine, signer.rows[0]!.id, link.rows[0]!.id],
        );
        return {
          requestId: request.rows[0]!.id,
          signerId: signer.rows[0]!.id,
          linkId: link.rows[0]!.id,
          challengeId: challenge.rows[0]!.id,
        };
      },
    );
    const statements: [string, unknown[]][] = [
      [
        `insert into signer (company_id, property_id, tenant_id, signing_request_id, signer_role, subject_type, name, phone, position)
         values ($1, $2, $3, $4, 'guarantor', 'other', 'Stranger', '+233200000097', 2)`,
        [agency, place.propertyId, theirs, requestId],
      ],
      [
        `insert into secure_link (company_id, property_id, tenant_id, purpose, token_hash, signer_id, expires_at)
         values ($1, $2, $3, 'sign', $4, $5, now() + interval '30 days')`,
        [agency, place.propertyId, theirs, randomBytes(32).toString('hex'), signerId],
      ],
      [
        `insert into otp_challenge (company_id, property_id, tenant_id, signer_id, secure_link_id, channel,
           destination_masked, destination_hash, code_hash, expires_at)
         values ($1, $2, $3, $4, $5, 'sms', 'x', 'h', 'c', now() + interval '10 minutes')`,
        [agency, place.propertyId, theirs, signerId, linkId],
      ],
      [
        `insert into signature (company_id, property_id, tenant_id, signing_request_id, signer_id, method, typed_name,
           consent_version, consent_sha256, verified_channel, verified_destination_masked, ip_address, user_agent,
           document_sha256, otp_challenge_id)
         values ($1, $2, $3, $4, $5, 'typed', 'Mine', 'consent.v1', $6, 'sms', 'x', '203.0.113.7', 'test', $6, $7)`,
        [agency, place.propertyId, theirs, requestId, signerId, zero, challengeId],
      ],
      [
        `insert into signing_event (company_id, property_id, tenant_id, signing_request_id, signer_id, kind)
         values ($1, $2, $3, $4, $5, 'link.opened')`,
        [agency, place.propertyId, theirs, requestId, signerId],
      ],
    ];
    for (const [text, values] of statements)
      expect(await asApp(agency, text, values)).toBe('23503');
  });
});
