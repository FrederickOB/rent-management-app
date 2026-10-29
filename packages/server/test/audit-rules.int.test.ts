import { schema, sql, withCompany, withSystem } from '@rent/db';
import { parseBusinessDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbKeyStore } from '../src/core/crypto/db-key-store';
import { FieldCipher } from '../src/core/crypto/field-cipher';
import { RulesService } from '../src/rules/rules.service';
import { LocalKms } from '@rent/integrations';
import {
  asOwner,
  asSuperuser,
  company,
  member,
  person,
  startServerTest,
  type ServerTestContext,
} from './support';

let ctx: ServerTestContext;
let rules: RulesService;
let platformId: string;

beforeAll(async () => {
  ctx = await startServerTest();
  rules = new RulesService(ctx.database);
  platformId = await company(ctx, 'platform', 'Platform');
});

afterAll(async () => {
  await ctx?.close();
});

describe('AD-07 audit search', () => {
  it('filters by person, record and date, and only within the current company', async () => {
    const a = await company(ctx, 'agency', 'Search A');
    const b = await company(ctx, 'agency', 'Search B');
    const alice = await person(ctx, 'Alice');
    const bob = await person(ctx, 'Bob');
    const aliceMembership = await member(ctx, a, alice, 'agency_admin');
    await member(ctx, b, bob, 'agency_admin');
    await withCompany(ctx.database, { companyId: a, personId: alice, actorKind: 'staff' }, (tx) =>
      ctx.audit.append(tx, {
        companyId: a,
        action: 'test.event',
        recordType: 'thing',
        recordId: 'thing-1',
        data: { n: 1 },
      }),
    );

    const byRecord = await ctx.audit.search(a, alice, {
      recordType: 'membership',
      recordId: aliceMembership,
      limit: 10,
    });
    expect(byRecord.events.map((e) => e.action)).toEqual(['membership.insert']);
    const byActor = await ctx.audit.search(a, alice, { actorPersonId: alice, limit: 10 });
    expect(byActor.events.map((e) => e.action)).toEqual(['test.event']);
    expect(byActor.events[0]!.actorName).toBe('Alice');
    const future = await ctx.audit.search(a, alice, {
      from: new Date(Date.now() + 3_600_000),
      limit: 10,
    });
    expect(future.events).toEqual([]);
    const all = await ctx.audit.search(a, alice, { limit: 100 });
    expect(all.events.every((e) => e.action !== 'company.insert' || e.recordId === a)).toBe(true);
    expect(all.events.some((e) => e.recordId === b)).toBe(false);
  });

  it('pages newest first with a keyset cursor', async () => {
    const a = await company(ctx, 'landlord', 'Paging');
    for (let i = 0; i < 5; i += 1) {
      await withCompany(ctx.database, { companyId: a, actorKind: 'system' }, (tx) =>
        ctx.audit.append(tx, { companyId: a, action: 'test.page', data: { i } }),
      );
    }
    const first = await ctx.audit.search(a, a, { action: 'test.page', limit: 2 });
    expect(first.events).toHaveLength(2);
    const second = await ctx.audit.search(a, a, {
      action: 'test.page',
      limit: 2,
      before: first.nextBefore!,
    });
    expect(second.events[0]!.seq).toBeLessThan(first.events[1]!.seq);
  });
});

describe('AD-07 verification and anchoring jobs', () => {
  it('anchors the head in write-once storage and catches a chain rewritten after it', async () => {
    const a = await company(ctx, 'landlord', 'Anchored');
    expect((await ctx.audit.verifyChain(a)).ok).toBe(true);
    const anchor = await ctx.audit.anchorHead(a, '2026-10-28', {
      bucket: ctx.config.S3_BUCKET_EVIDENCE,
      retainUntil: new Date(Date.now() + 86_400_000),
      mode: 'GOVERNANCE',
    });
    expect(anchor).toMatchObject({ earlierAnchorsMatch: true });
    // The anchor object cannot be replaced.
    await expect(
      ctx.storage.putWriteOnce({
        bucket: ctx.config.S3_BUCKET_EVIDENCE,
        key: anchor!.storageKey,
        body: Buffer.from('{}'),
        contentType: 'application/json',
        retainUntil: new Date(Date.now() + 86_400_000),
        mode: 'GOVERNANCE',
      }),
    ).rejects.toThrow();

    // Someone with superuser access rewrites the first event and recomputes the whole chain.
    await asSuperuser(
      ctx,
      `update audit_event set data = '{"rewritten": true}' where company_id = $1 and seq = 1`,
      [a],
    );
    await asSuperuser(
      ctx,
      `with recursive chain as (
         select e.seq, audit.event_hash(audit.genesis_hash(), e.hash_version, e.company_id, e.seq, e.occurred_at, e.actor_person_id, e.actor_kind, e.request_id, e.action, e.record_type, e.record_id, e.data) as hash
         from audit_event e where e.company_id = $1 and e.seq = 1
         union all
         select e.seq, audit.event_hash(c.hash, e.hash_version, e.company_id, e.seq, e.occurred_at, e.actor_person_id, e.actor_kind, e.request_id, e.action, e.record_type, e.record_id, e.data)
         from audit_event e join chain c on e.seq = c.seq + 1 where e.company_id = $1
       )
       update audit_event e set hash = c.hash, prev_hash = coalesce((select c2.hash from chain c2 where c2.seq = e.seq - 1), audit.genesis_hash())
       from chain c where e.company_id = $1 and e.seq = c.seq`,
      [a],
    );
    await asSuperuser(
      ctx,
      'update audit_chain_head h set last_hash = e.hash from audit_event e where h.company_id = $1 and e.company_id = $1 and e.seq = h.last_seq',
      [a],
    );
    expect((await ctx.audit.verifyChain(a)).ok).toBe(true); // a consistent rewrite passes the chain check...
    expect(await ctx.audit.anchorsMatch(a)).toBe(false); // ...but not the anchor
  });
});

describe('TX-08 rules engine', () => {
  const asOf = parseBusinessDate('2026-10-28');

  it('seeds the Ghana values with their status and source (CLAUDE.md section 7)', async () => {
    const expected: [string, unknown, string][] = [
      ['rent_tax.rate.residential', { bps: 800 }, 'from_prd'],
      ['rent_tax.rate.commercial', { bps: 1500 }, 'from_prd'],
      ['rent_tax.due_days_after_receipt', { days: 30 }, 'from_prd'],
      ['rent_tax.alert_days', { days: [21, 28] }, 'from_prd'],
      ['rent_tax.base', 'rent_received_including_advances', 'unverified'],
      ['rent_tax.rounding', 'half_up_per_receipt', 'unverified'],
      ['rent_tax.includes_service_charge', true, 'unverified'],
      ['withholding_tax.rate.residential', { bps: 800 }, 'unverified'],
      ['vat.commercial_rent', { vatBps: 1500, nhilBps: 250, getfundBps: 250 }, 'unverified'],
      ['advance_rent.max_months.monthly_or_shorter', { months: 1 }, 'unverified'],
      ['advance_rent.max_months.over_six_months', { months: 6 }, 'unverified'],
      ['rent_control.registration_days', { days: 14 }, 'unverified'],
      ['notice_to_quit.statutory_min_days.residential', null, 'unverified'],
      ['data_retention.financial_and_notices', { years: 6 }, 'unverified'],
      ['data_retention.other.messages', null, 'unverified'],
    ];
    for (const [key, value, status] of expected) {
      const rule = await rules.resolve('GH', key, asOf);
      expect(rule.value, key).toEqual(value);
      expect(rule.verificationStatus, key).toBe(status);
      expect(rule.warning, key).toBe(true); // nothing is verified yet
      expect(rule.source.length, key).toBeGreaterThan(0);
    }
  });

  it('leaves past dates unchanged when a future-dated value is added, and records who added it', async () => {
    const before = await rules.resolve('GH', 'rent_tax.rate.commercial', asOf);
    const id = await rules.add(
      {
        country: 'GH',
        key: 'rent_tax.rate.commercial',
        value: { bps: 1200 },
        effectiveFrom: '2027-01-01',
        source: 'Test amendment',
        verificationStatus: 'unverified',
        createdBy: 'test',
      },
      platformId,
    );
    expect((await rules.resolve('GH', 'rent_tax.rate.commercial', asOf)).ruleId).toBe(
      before.ruleId,
    );
    expect(
      (await rules.resolve('GH', 'rent_tax.rate.commercial', parseBusinessDate('2027-02-01')))
        .ruleId,
    ).toBe(id);
    const events = await withCompany(
      ctx.database,
      { companyId: platformId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ action: string }>(sql`select action from audit_event where record_id = ${id}`),
    );
    expect(events.rows.map((r) => r.action)).toEqual(['rule.insert']);
  });

  it('refuses invalid values, unknown keys and a verified value with no verifier', async () => {
    const base = {
      country: 'GH',
      effectiveFrom: '2027-01-01',
      source: 'x',
      createdBy: 'test',
    } as const;
    await expect(
      rules.add(
        {
          ...base,
          key: 'rent_tax.rate.residential',
          value: { bps: 7.5 },
          verificationStatus: 'unverified',
        },
        platformId,
      ),
    ).rejects.toThrow();
    await expect(
      rules.add(
        { ...base, key: 'made_up.key', value: 1, verificationStatus: 'unverified' },
        platformId,
      ),
    ).rejects.toThrow();
    await expect(
      rules.add(
        {
          ...base,
          key: 'rent_tax.rate.residential',
          value: { bps: 800 },
          verificationStatus: 'verified',
        },
        platformId,
      ),
    ).rejects.toThrow(/verified/);
  });

  it('never edits or deletes a rule row', async () => {
    const [row] = await withSystem(ctx.database, {}, (tx) =>
      tx.select({ id: schema.rule.id }).from(schema.rule).limit(1),
    );
    await expect(
      asOwner(ctx, `update rule set source = 'edited' where id = '${row!.id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(asOwner(ctx, `delete from rule where id = '${row!.id}'`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('treats a missing rule as an error, never a default', async () => {
    await expect(
      rules.resolve('GH', 'rent_tax.rate.residential', parseBusinessDate('1999-12-31')),
    ).rejects.toThrow(/No rule/);
  });
});

describe('NFR-SEC field encryption keys in the database', () => {
  it('creates one wrapped key per company, audited without the key material, and decrypts after a restart', async () => {
    const a = await company(ctx, 'landlord', 'Keys Co');
    const kms = new LocalKms(ctx.config.LOCAL_KMS_MASTER_KEY!);
    const master = Buffer.from(ctx.config.BLIND_INDEX_MASTER_KEY!, 'base64');
    const field = { companyId: a, table: 'tenant', column: 'id_number', rowId: 'r1' };
    const sealed = await new FieldCipher(kms, new DbKeyStore(ctx.database), master).encrypt(
      field,
      'GHA-000000001-1',
    );
    const restarted = new FieldCipher(kms, new DbKeyStore(ctx.database), master);
    expect(await restarted.decrypt(field, sealed)).toBe('GHA-000000001-1');
    const keys = await withCompany(ctx.database, { companyId: a, actorKind: 'system' }, (tx) =>
      tx.select().from(schema.companyKey),
    );
    expect(keys).toHaveLength(1);
    const audit = await ctx.audit.search(a, a, { action: 'company_key.insert', limit: 5 });
    expect(JSON.stringify(audit.events[0]!.data)).toContain('[redacted]');
  });
});
