import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cloneTemplateDatabase, type TestDatabase } from './testing';
import { connect, createCompany, inContext, sqlState } from './testing/fixtures';

/**
 * Migration 0061's deferred constraint trigger, `app.check_journal_line_refs()` (M10 review
 * BE-10): a journal line's `invoice_line_id` and `payment_id` name rent's invoice lines and
 * payments in an owner or company book, and subscription invoices and payments in the platform
 * book (P26), checked at commit. So rent never names a subscription record, nor P26 a rent record
 * (D1), and a line never names a record that does not exist. Raw SQL below the application, as
 * ledger_writer, the only role that writes the journal.
 */
let db: TestDatabase;
let app: pg.Client;
let platform: string;
let landlord: string;
let platformBook: string;
let ownerBook: string;
let subscriptionInvoice: string;
let subscriptionPayment: string;
let rentInvoiceLine: string;
let rentPayment: string;

const zero = '0'.repeat(64);

interface Line {
  readonly book: string;
  readonly account: string;
  readonly amount: number;
  readonly invoiceLineId?: string | null;
  readonly paymentId?: string | null;
}

/** An entry's statements: the entry, then its lines (in `companyId`, as ledger_writer). */
function entryStatements(
  companyId: string,
  rule: string,
  lines: readonly Line[],
): { text: string; values: unknown[] }[] {
  const id = randomUUID();
  return [
    {
      // eslint-disable-next-line rent/ledger-writes -- proves the database's rules for journal writes
      text: `insert into journal_entry (id, company_id, rule, idempotency_key, value_date, accounting_date, record_type, record_id)
             values ($1, $2, $3, $4, current_date, current_date, 'test', $1)`,
      values: [id, companyId, rule, `refs:${id}`],
    },
    ...lines.map((line, i) => ({
      // eslint-disable-next-line rent/ledger-writes -- proves the database's rules for journal writes
      text: `insert into journal_line (id, company_id, entry_id, line_no, book_id, account_code, amount_minor,
               invoice_line_id, payment_id)
             values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      values: [
        companyId,
        id,
        i + 1,
        line.book,
        line.account,
        line.amount,
        line.invoiceLineId ?? null,
        line.paymentId ?? null,
      ],
    })),
  ];
}

/**
 * Writes an entry in one transaction as the posting service does; resolves to null, or to the
 * refusal's SQLSTATE and message.
 */
async function post(companyId: string, rule: string, lines: readonly Line[]) {
  try {
    await inContext(app, { companyId }, async () => {
      await app.query('set local role ledger_writer');
      for (const s of entryStatements(companyId, rule, lines)) await app.query(s.text, s.values);
    });
    return null;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return `${e.code} ${e.message}`;
  }
}

/** The platform book: P26's accounts, naming what is given. */
const platformLines = (refs: { invoiceLineId?: string; paymentId?: string }): Line[] => [
  { book: platformBook, account: '1100', amount: 1_000, ...refs },
  { book: platformBook, account: '4600', amount: -1_000, ...refs },
];

/** An owner book: rent's accounts, naming what is given. */
const ownerLines = (refs: { invoiceLineId?: string; paymentId?: string }): Line[] => [
  { book: ownerBook, account: '1100', amount: 1_000, ...refs },
  { book: ownerBook, account: '4000', amount: -1_000, ...refs },
];

const one = async (text: string, values: unknown[]) =>
  (await app.query<{ id: string }>(text, values)).rows[0]!.id;

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  platform = await createCompany(app, 'Refs Platform', 'platform');
  landlord = await createCompany(app, 'Refs Landlord', 'landlord');

  // Rent's side: an owner (its book comes from the database), a lease with an invoice line, and a
  // payment received straight into the owner's account (its entry names it).
  await inContext(app, { companyId: landlord }, async () => {
    const owner = await one(
      "insert into owner (company_id, reference, kind, display_name) values ($1, 'OWN-01', 'individual', 'Owner') returning id",
      [landlord],
    );
    ownerBook = await one('select id from book where owner_id = $1', [owner]);
    const portfolio = await one(
      "insert into portfolio (company_id, name, is_default) values ($1, 'Main portfolio', true) returning id",
      [landlord],
    );
    const property = await one(
      `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
       values ($1, $2, 'ACC-REF', 'ACC', 'Refs', 'compound_house', 'residential', 'Greater Accra') returning id`,
      [landlord, portfolio],
    );
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [landlord, property, owner],
    );
    const block = await one(
      "insert into block (company_id, property_id, code, is_default) values ($1, $2, 'B1', true) returning id",
      [landlord, property],
    );
    const unit = await one(
      `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
       values ($1, $2, $3, 'ACC-REF-B1-01', '01', 'single_room', 'single_room') returning id`,
      [landlord, property, block],
    );
    const tenant = await one(
      "insert into tenant (company_id, kind, display_name, phone) values ($1, 'individual', 'Tenant', '+233200000098') returning id",
      [landlord],
    );
    const template = await one(
      "insert into lease_template (company_id, name, kind) values ($1, 'Residential', 'residential') returning id",
      [landlord],
    );
    const version = await one(
      "insert into lease_template_version (company_id, template_id, version, content, content_sha256) values ($1, $2, 1, '{}', $3) returning id",
      [landlord, template, zero],
    );
    const lease = await one(
      `insert into lease (company_id, property_id, unit_id, tenant_id, use, template_version_id, start_date, end_date,
         monthly_rent_minor, rent_cycle, notice_days)
       values ($1, $2, $3, $4, 'residential', $5, current_date, current_date + 364, 150000, 'monthly', 30) returning id`,
      [landlord, property, unit, tenant, version],
    );
    const leaseRef = [landlord, property, tenant, lease];
    // Recorded as signed on paper, so it may have a rent schedule.
    const scan = await one(
      "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'test', 'application/pdf', 1, $2, 'b', 'k', true) returning id",
      [landlord, zero],
    );
    await app.query(
      "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
      [lease, scan],
    );
    const period = await one(
      `insert into charge_period (company_id, property_id, tenant_id, lease_id, sequence, charge_type, period_start,
         period_end, amount_minor)
       values ($1, $2, $3, $4, 0, 'rent', current_date, current_date + 29, 150000) returning id`,
      leaseRef,
    );
    const invoice = await one(
      `insert into invoice (company_id, property_id, tenant_id, lease_id, number, kind, unit_id, owner_id, book_id, issue_date,
         due_date, cycle_start, payment_reference, unit_code, property_name, billed_to_name, billed_from_name)
       values ($1, $2, $3, $4, 1, 'cycle', $5, $6, $7, current_date, current_date, current_date, 'K000000', 'ACC-REF-B1-01',
         'Refs', 'Tenant', 'Owner') returning id`,
      [...leaseRef, unit, owner, ownerBook],
    );
    rentInvoiceLine = await one(
      `insert into invoice_line (company_id, property_id, tenant_id, lease_id, invoice_id, position, kind, charge_period_id,
         period_start, period_end, due_date, amount_minor)
       values ($1, $2, $3, $4, $5, 1, 'rent', $6, current_date, current_date + 29, current_date, 150000) returning id`,
      [...leaseRef, invoice, period],
    );
    rentPayment = randomUUID();
    const statements = entryStatements(landlord, 'P28', [
      { book: ownerBook, account: '1010', amount: 1_000, paymentId: rentPayment },
      { book: ownerBook, account: '2090', amount: -1_000, paymentId: rentPayment },
    ]);
    await app.query('set local role ledger_writer');
    for (const s of statements) await app.query(s.text, s.values);
    await app.query('set local role none');
    await app.query(
      `insert into payment (id, company_id, method, amount_minor, received_on, accounting_date, owner_id, book_id,
         cash_account, source_type, source_id, entry_id)
       values ($1, $2, 'bank_transfer', 1000, current_date, current_date, $3, $4, '1010', 'direct_receipt',
         gen_random_uuid(), $5)`,
      [rentPayment, landlord, owner, ownerBook, statements[0]!.values[0]],
    );
  });

  // The platform's side: the landlord's subscription, an invoice and a payment (M10 decision 1).
  await inContext(app, { companyId: platform }, async () => {
    platformBook = await one("select id from book where kind = 'platform'", []);
    const subscription = await one(
      `insert into subscription (company_id, subscriber_company_id, tier, status, started_on)
       values ($1, $2, 'growth', 'active', '2026-01-01') returning id`,
      [platform, landlord],
    );
    const snapshot = await one(
      `insert into billing_snapshot (company_id, subscription_id, subscriber_company_id, month, single_room_units,
         self_contained_units, commercial_units)
       values ($1, $2, $3, '2026-01', 1, 0, 0) returning id`,
      [platform, subscription, landlord],
    );
    const terms = await one(
      'select id from subscription_terms order by effective_from limit 1',
      [],
    );
    subscriptionInvoice = await one(
      `insert into subscription_invoice (company_id, subscription_id, subscriber_company_id, number, month, snapshot_id,
         issued_on, due_on, subtotal_minor, discount_minor, net_minor, vat_minor, total_minor, price_list_ids, terms_id,
         template_key, template_version)
       values ($1, $2, $3, 'SUB-2026-000001', '2026-01', $4, '2026-02-01', '2026-02-08', 1000, 0, 1000, 0, 1000,
         '{}', $5, 'subscription.invoice', 1) returning id`,
      [platform, subscription, landlord, snapshot, terms],
    );
    subscriptionPayment = await one(
      `insert into subscription_payment (company_id, subscription_id, subscriber_company_id, reference, purpose, channel,
         amount_minor, status, provider, succeeded_at)
       values ($1, $2, $3, $4, 'invoices', 'card', 1000, 'succeeded', 'paystack', now()) returning id`,
      [platform, subscription, landlord, `SUB-${randomUUID().replace(/-/g, '')}`],
    );
  });
}, 60_000);

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('D1 and AC-01 journal line references follow the kind of book (0061)', () => {
  it('accepts each book naming its own records: rent’s in an owner book, subscriptions’ in the platform book', async () => {
    expect(await post(landlord, 'P02', ownerLines({ invoiceLineId: rentInvoiceLine }))).toBeNull();
    expect(await post(landlord, 'P02', ownerLines({ paymentId: rentPayment }))).toBeNull();
    expect(
      await post(platform, 'P26', platformLines({ invoiceLineId: subscriptionInvoice })),
    ).toBeNull();
    expect(
      await post(platform, 'P26', platformLines({ paymentId: subscriptionPayment })),
    ).toBeNull();
  });

  it('refuses an owner-book line naming a subscription invoice or payment', async () => {
    expect(await post(landlord, 'P02', ownerLines({ invoiceLineId: subscriptionInvoice }))).toMatch(
      /^23503 journal line \S+ names an invoice line that does not exist$/,
    );
    expect(await post(landlord, 'P02', ownerLines({ paymentId: subscriptionPayment }))).toMatch(
      /^23503 journal line \S+ names a payment that does not exist$/,
    );
  });

  it('refuses a platform-book line naming a rent invoice line or payment', async () => {
    expect(await post(platform, 'P26', platformLines({ invoiceLineId: rentInvoiceLine }))).toMatch(
      /^23503 journal line \S+ names a subscription invoice that does not exist$/,
    );
    expect(await post(platform, 'P26', platformLines({ paymentId: rentPayment }))).toMatch(
      /^23503 journal line \S+ names a subscription payment that does not exist$/,
    );
  });

  it('refuses at commit, not before, a line naming an id that does not exist', async () => {
    for (const [companyId, rule, lines] of [
      [platform, 'P26', platformLines({ invoiceLineId: randomUUID() })],
      [platform, 'P26', platformLines({ paymentId: randomUUID() })],
      [landlord, 'P02', ownerLines({ invoiceLineId: randomUUID() })],
      [landlord, 'P02', ownerLines({ paymentId: randomUUID() })],
    ] as const) {
      await app.query('begin');
      try {
        await app.query(
          "select set_config('app.company_id', $1, true), set_config('app.actor_kind', 'system', true)",
          [companyId],
        );
        await app.query('set local role ledger_writer');
        // Every insert is taken: the check is deferred to commit.
        for (const s of entryStatements(companyId, rule, lines)) await app.query(s.text, s.values);
        expect(await sqlState(app.query('commit'))).toBe('23503');
      } finally {
        await app.query('rollback');
      }
    }
    // Nothing of them was kept.
    const kept = await inContext(app, { companyId: platform }, () =>
      app.query<{ n: number }>(
        "select count(*)::int as n from journal_entry where record_type = 'test'",
      ),
    );
    expect(kept.rows[0]!.n).toBe(2);
  });
});
