import { schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { ownerFundingLines } from '@rent/domain/ledger';
import { flattenStatementFigures } from '@rent/domain/reporting';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messageRequestSchema, queueMessage } from '../src/core/messages';
import { prepaymentSplitAt } from '../src/reporting/prepayment-split';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { outboxOf } from './support/maintenance';
import { paymentsServices } from './support/payments';
import {
  reportingStatementsServices,
  statementRecords,
  type ReportingStatementsServices,
} from './support/reporting-statements';
import { taxServices, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  SAMPLE_PDF,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M9 review's statement findings against the real database with RLS on:
 * - F1: issuing a month locks it and every month before it, so a late entry dated in an earlier,
 *   unissued month lands in the open month, and the database refuses the earlier month too;
 * - the race: an issue waits for a posting in flight and includes it; a posting that meets an
 *   issue in progress is refused and lands in the open month when retried; two issues at once
 *   take turns;
 * - RA094 and RA096: figures only with their issue, and an issue only with its lock;
 * - CM-09: the statement email has its own purpose, `deliveredAt` follows the provider's report,
 *   and an opt-out or a missing address is recorded as the reason no email went;
 * - one split of 2010 for the statement and the dashboard (founder, 2026-11-07);
 * - TX-04: the rent-tax hold-back leaves out tax a tenant withheld (#9).
 * Months are counted back from the test clock's month and days are fixed within them (the 5th to
 * the 25th), so the file passes on any date.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let r: ReportingStatementsServices;
let agency: Awaited<ReturnType<typeof moneyCompany>>;

const monthPlus = (month: string, n: number) =>
  toIsoDate(addMonths(parseBusinessDate(`${month}-01`), n)).slice(0, 7);
const dayOf = (month: string, day: number) =>
  toIsoDate(addDays(parseBusinessDate(`${month}-01`), day - 1));
const lastOf = (month: string) =>
  toIsoDate(addDays(parseBusinessDate(`${monthPlus(month, 1)}-01`), -1));
const system = <T>(fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, fn);

let M0: string;
let M1: string;
let M2: string;
let M3: string;
let today: string;

/** The SQLSTATE of a database error, through any wrapping. */
function stateOf(error: unknown): string | null {
  let e = error as { code?: unknown; cause?: unknown } | undefined;
  while (e) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    e = e.cause as typeof e;
  }
  return null;
}

/** Waits until `test` holds, checking every 25 ms for up to 10 s. */
async function until(test: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting');
}

/** Whether some session is waiting for an advisory lock (an issue waiting for a posting). */
const someoneWaitsForAdvisory = () =>
  system(async (tx) => {
    const rows = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event = 'advisory'`,
    );
    return (rows.rows[0]?.n ?? 0) > 0;
  });

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}

let ownerCount = 0;
async function owner(input: { email?: string; withUnit?: boolean; use?: 'commercial' } = {}) {
  ownerCount += 1;
  const ownerId = (
    await s.owners.create(agency.admin, {
      kind: 'individual',
      displayName: `Review owner ${ownerCount}`,
      ...(input.email ? { email: input.email } : {}),
    })
  ).id;
  const bookId = await system(async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`select id from book where owner_id = ${ownerId}::uuid`,
    );
    return rows.rows[0]!.id;
  });
  if (!input.withUnit) return { ownerId, bookId, propertyId: null, unitId: null };
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: `RV${ownerCount}`,
    ownerId,
    ...(input.use ? { use: input.use } : {}),
    units: [
      input.use === 'commercial'
        ? { unitType: 'office', count: 1 }
        : { unitType: 'single_room', count: 1 },
    ],
  });
  // Registered long ago, as a register built at go-live would have it (below the application).
  await asSuperuser(
    ctx,
    `update property_ownership set effective_from = $2::date where property_id = $1`,
    [property.propertyId, `${monthPlus(M3, -1)}-01`],
  );
  return {
    ownerId,
    bookId,
    propertyId: property.propertyId,
    unitId: Object.values(property.units)[0]!,
  };
}

let tenantCount = 0;
async function leaseOn(
  unitId: string,
  input: { start: string; rentMinor: number; use?: 'commercial' },
) {
  tenantCount += 1;
  const tenantId = (
    await s.tenants.create(agency.manager, {
      kind: input.use === 'commercial' ? 'company' : 'individual',
      displayName: `Review tenant ${tenantCount}`,
      ...(input.use === 'commercial' ? { legalName: `Review Tenant ${tenantCount} Limited` } : {}),
    })
  ).tenant.id;
  return billedLease(ctx, s, b, agency.manager, {
    unitId,
    tenantId,
    startDate: input.start,
    endDate: toIsoDate(addDays(addMonths(parseBusinessDate(input.start), 12), -1)),
    monthlyRentMinor: input.rentMinor,
    cycle: 'monthly',
    ...(input.use ? { use: input.use } : {}),
    signedOn: toIsoDate(addDays(parseBusinessDate(input.start), -1)),
    billingStartDate: input.start,
  });
}

/** Owner funding (P30) posted in the caller's transaction, as the funding service posts it. */
const fund = (tx: Tx, bookId: string, valueDate: string, amountMinor: number) => {
  const id = uuidv7();
  return b.posting.post(tx, {
    companyId: agency.companyId,
    rule: 'P30',
    key: `P30:${id}`,
    valueDate,
    lines: ownerFundingLines({ bookId, amountMinor }),
    record: { type: 'statement_review_test', id },
  });
};

/** A journal entry written straight to the tables as ledger_writer, bypassing the service. */
const directEntry = (bookId: string, accountingDate: string) =>
  system(async (tx) => {
    const id = uuidv7();
    await tx.execute(sql`set local role ledger_writer`);
    await tx.execute(
      // eslint-disable-next-line rent/ledger-writes -- the database's own refusal is under test
      sql`insert into journal_entry (id, company_id, rule, idempotency_key, value_date,
            accounting_date, record_type, record_id)
          values (${id}::uuid, ${agency.companyId}::uuid, 'P30', ${`P30:${id}`},
            ${accountingDate}::date, ${accountingDate}::date, 'statement_review_test', ${id}::uuid)`,
    );
    await tx.execute(
      // eslint-disable-next-line rent/ledger-writes -- the database's own refusal is under test
      sql`insert into journal_line (id, company_id, entry_id, line_no, book_id, account_code,
            amount_minor)
          values (gen_random_uuid(), ${agency.companyId}::uuid, ${id}::uuid, 1, ${bookId}::uuid,
            '1070', 100),
            (gen_random_uuid(), ${agency.companyId}::uuid, ${id}::uuid, 2, ${bookId}::uuid,
            '1010', -100)`,
    );
    await tx.execute(sql`set local role none`);
  });

async function issued(ownerId: string, month: string) {
  const draft = await r.statements.draft(agency.manager, { ownerId, month });
  return r.statements.issue(agency.manager, draft.id);
}

/** Renders the issued statement's PDF and runs the hook that records it and emails the owner. */
async function rendered(statementId: string) {
  const record = await statementRecords(ctx, agency.companyId, statementId);
  await s.documents.renderRequested(
    agency.companyId,
    record.row!.render_request_id!,
    async () => SAMPLE_PDF,
  );
  expect(
    await r.statements.onDocumentRendered(agency.companyId, record.row!.render_request_id!),
  ).toBe(true);
  return statementRecords(ctx, agency.companyId, statementId);
}

/** The statement email queued for a statement, if any (the outbox's messaging.send payload). */
async function statementEmail(statementId: string) {
  const sends = await outboxOf(ctx, agency.companyId, 'messaging.send');
  return (
    sends
      .map((e) => messageRequestSchema.parse(e.payload))
      .find((p) => p.related?.type === 'owner_statement' && p.related.id === statementId) ?? null
  );
}

/** Records what the email provider reported for a message, as the delivery webhook does. */
const providerReports = (
  messageId: string,
  status: 'delivered' | 'read' | 'failed',
  reason: string | null = null,
) =>
  system(async (tx) => {
    const [row] = await tx
      .insert(schema.messageEvent)
      .values({
        companyId: agency.companyId,
        messageId,
        status,
        channel: 'email',
        provider: 'memory',
        providerMessageId: `report-${uuidv7()}`,
        reason,
      })
      .returning({ occurredAt: schema.messageEvent.occurredAt });
    return row!.occurredAt;
  });

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  // Owners as message recipients (M4b's resolver, now with their opt-outs), and the pay links.
  paymentsServices(ctx, s, b);
  r = reportingStatementsServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  M0 = today.slice(0, 7);
  M1 = monthPlus(M0, -1);
  M2 = monthPlus(M0, -2);
  M3 = monthPlus(M0, -3);
  agency = await moneyCompany(ctx, s, 'agency', 'Review Statements Agency');
});

afterAll(async () => {
  await ctx?.close();
});

describe('AC-04 F1 issuing a month locks it and every month before it', () => {
  it('reports a late entry dated in an earlier, unissued month on the open month’s first day', async () => {
    const o = await owner({ withUnit: true });
    const lease = await leaseOn(o.unitId!, { start: `${M3}-01`, rentMinor: 100_000 });
    // M1 is issued; M2 and M3 never were.
    const statementM1 = await issued(o.ownerId, M1);
    expect((await statementRecords(ctx, agency.companyId, statementM1.id)).locks).toEqual([
      { month: `${M1}-01`, source: 'owner_statement' },
    ]);
    // Money received in M2 and in M3, recorded now: both are reported on M0's first day.
    const inM2 = await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 100_000,
      receivedOn: dayOf(M2, 12),
    });
    const inM3 = await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 100_000,
      receivedOn: dayOf(M3, 20),
    });
    const dates = await system((tx) =>
      tx.execute<{ id: string; received_on: string; accounting_date: string }>(
        sql`select id, received_on::text, accounting_date::text from payment
            where id = any(${`{${inM2.paymentId},${inM3.paymentId}}`}::uuid[])`,
      ),
    );
    expect(dates.rows.map((p) => p.accounting_date)).toEqual([`${M0}-01`, `${M0}-01`]);
    // The database refuses the earlier, unissued month too, and takes the open one.
    expect(stateOf(await directEntry(o.bookId, dayOf(M2, 12)).catch((e: unknown) => e))).toBe(
      'RA044',
    );
    expect(stateOf(await directEntry(o.bookId, lastOf(M1)).catch((e: unknown) => e))).toBe('RA044');
    await expect(directEntry(o.bookId, `${M0}-01`)).resolves.toBeUndefined();
    // M2 can still be drafted and issued, and it has none of the late money.
    const draftM2 = await r.statements.draft(agency.manager, { ownerId: o.ownerId, month: M2 });
    expect(draftM2.figures.summary.cash.collectionsMinor).toBe(0);
    const issuedM2 = await r.statements.issue(agency.manager, draftM2.id);
    expect(issuedM2.matchesIssued).toBe(true);
    expect((await r.statements.get(agency.manager, statementM1.id)).matchesIssued).toBe(true);
  });
});

describe('AC-04 issuing and posting never race (M9 review)', () => {
  it('an issue waits for a posting in flight, then includes it in the figures it freezes', async () => {
    const o = await owner();
    const draft = await r.statements.draft(agency.manager, { ownerId: o.ownerId, month: M1 });
    expect(draft.figures.agent!.in.owner_funding).toBe(0);
    const hold = gate();
    let posted: { accountingDate: string } | null = null;
    const posting = system(async (tx) => {
      posted = await fund(tx, o.bookId, dayOf(M1, 14), 25_000);
      await hold.closed;
    });
    await until(async () => posted !== null);
    const issuing = r.statements.issue(agency.manager, draft.id);
    await until(someoneWaitsForAdvisory);
    hold.open();
    await posting;
    const done = await issuing;
    expect(posted!.accountingDate).toBe(dayOf(M1, 14));
    expect(done.figures.agent!.in.owner_funding).toBe(25_000);
    expect(done.figures.agent!.closingMinor).toBe(25_000);
    const again = await r.statements.get(agency.manager, draft.id);
    expect(again.matchesIssued).toBe(true);
    expect(again.figures).toEqual(done.figures);
  });

  it('a posting that meets an issue in progress is refused, then lands in the open month', async () => {
    const o = await owner({ withUnit: true });
    const lease = await leaseOn(o.unitId!, { start: `${M2}-01`, rentMinor: 80_000 });
    const hold = gate();
    let locked = false;
    // An issue in progress for M1: it holds the book's lock until it commits with its lock row.
    const issue = system(async (tx) => {
      await b.posting.lockBookForIssue(tx, o.bookId);
      locked = true;
      await hold.closed;
      await b.posting.lockMonth(tx, {
        companyId: agency.companyId,
        bookId: o.bookId,
        month: M1,
        source: 'owner_statement',
      });
    });
    await until(async () => locked);
    await expect(
      b.money.recordProviderPayment(agency.companyId, {
        leaseId: lease.id,
        amountMinor: 80_000,
        receivedOn: dayOf(M1, 10),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'statement_issuing' });
    // Below the service, the database refuses too, without waiting.
    expect(stateOf(await directEntry(o.bookId, today).catch((e: unknown) => e))).toBe('RA095');
    hold.open();
    await issue;
    const retried = await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 80_000,
      receivedOn: dayOf(M1, 10),
    });
    const [payment] = (
      await system((tx) =>
        tx.execute<{ accounting_date: string }>(
          sql`select accounting_date::text from payment where id = ${retried.paymentId}::uuid`,
        ),
      )
    ).rows;
    expect(payment!.accounting_date).toBe(`${M0}-01`);
  });

  it('two issues of one statement at once: one issues, the other is refused, figures stored once', async () => {
    const o = await owner({ withUnit: true });
    await leaseOn(o.unitId!, { start: `${M2}-01`, rentMinor: 60_000 });
    const draft = await r.statements.draft(agency.manager, { ownerId: o.ownerId, month: M1 });
    const outcomes = await Promise.allSettled([
      r.statements.issue(agency.manager, draft.id),
      r.statements.issue(agency.accountant, draft.id),
    ]);
    const won = outcomes.filter((x) => x.status === 'fulfilled');
    const lost = outcomes.filter((x) => x.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: 'statement_issued',
    });
    const record = await statementRecords(ctx, agency.companyId, draft.id);
    expect(record.row!.status).toBe('issued');
    expect(record.figures).toEqual(
      flattenStatementFigures((won[0] as PromiseFulfilledResult<typeof draft>).value.figures),
    );
    expect(record.locks).toEqual([{ month: `${M1}-01`, source: 'owner_statement' }]);
  });

  it('two months of one owner issued at once take turns, and both lock', async () => {
    const o = await owner({ withUnit: true });
    await leaseOn(o.unitId!, { start: `${M3}-01`, rentMinor: 70_000 });
    const drafts = await Promise.all(
      [M1, M2].map((month) => r.statements.draft(agency.manager, { ownerId: o.ownerId, month })),
    );
    const done = await Promise.all(drafts.map((d) => r.statements.issue(agency.manager, d.id)));
    expect(done.map((d) => d.status)).toEqual(['issued', 'issued']);
    const locks = (await statementRecords(ctx, agency.companyId, drafts[0]!.id)).locks;
    expect(locks.map((l) => l.month).sort()).toEqual([`${M2}-01`, `${M1}-01`]);
    for (const d of drafts)
      expect((await r.statements.get(agency.manager, d.id)).matchesIssued).toBe(true);
  });
});

describe('AC-04 the database keeps an issue whole (RA094, RA096)', () => {
  it('refuses figures added after the issue, and an issue without its month’s lock', async () => {
    const o = await owner();
    const statement = await issued(o.ownerId, M1);
    const late = await system((tx) =>
      tx.execute(
        sql`insert into owner_statement_figure (company_id, statement_id, owner_id, key, value_minor, position)
            values (${agency.companyId}::uuid, ${statement.id}::uuid, ${o.ownerId}::uuid,
              'summary.late', 1, 9999)`,
      ),
    ).catch((e: unknown) => e);
    expect(stateOf(late)).toBe('RA094');
    // A draft marked issued with no lock written: refused when the transaction commits.
    const other = await owner();
    const draft = await r.statements.draft(agency.manager, { ownerId: other.ownerId, month: M1 });
    const unlocked = await system((tx) =>
      tx.execute(
        sql`update owner_statement set status = 'issued', issued_at = now(),
              issued_by = ${agency.manager.personId}::uuid
            where id = ${draft.id}::uuid`,
      ),
    ).catch((e: unknown) => e);
    expect(stateOf(unlocked)).toBe('RA096');
    expect((await statementRecords(ctx, agency.companyId, draft.id)).row!.status).toBe('draft');
  });
});

describe('CM-09 the statement email (owner_statement)', () => {
  it('goes as owner_statement to an owner with an email; deliveredAt fills in when the provider reports delivered or read', async () => {
    const o = await owner({ email: 'review-owner-e@test.invalid' });
    const statement = await issued(o.ownerId, M1);
    const after = await rendered(statement.id);
    expect(after.row!.sent_at).not.toBeNull();
    expect(after.row!.delivered_at).toBeNull();
    expect(after.row!.email_not_sent_reason).toBeNull();
    const email = await statementEmail(statement.id);
    expect(email).toMatchObject({
      messageId: after.row!.email_message_id,
      purpose: 'owner_statement',
      channels: ['email'],
      recipient: { type: 'owner', ownerId: o.ownerId },
    });
    // The send job: the address on record is the consent, so it goes.
    expect(await s.messaging.deliver(agency.companyId, email!)).toBe('sent');
    expect(s.email.sent.some((m) => m.to === 'review-owner-e@test.invalid')).toBe(true);
    const sent = await r.statements.get(agency.manager, statement.id);
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.deliveredAt).toBeNull();
    expect(sent.emailNotSentReason).toBeNull();
    const deliveredAt = await providerReports(email!.messageId, 'delivered');
    const delivered = await r.statements.get(agency.manager, statement.id);
    expect(delivered.deliveredAt).toEqual(deliveredAt);
    await providerReports(email!.messageId, 'read');
    expect((await r.statements.get(agency.manager, statement.id)).deliveredAt).toEqual(deliveredAt);
    const [listed] = await r.statements.list(agency.manager, { ownerId: o.ownerId });
    expect(listed!.deliveredAt).toEqual(deliveredAt);
  });

  it('read alone also counts as delivered; a failure leaves deliveredAt empty', async () => {
    const read = await owner({ email: 'review-owner-r@test.invalid' });
    const readStatement = await issued(read.ownerId, M1);
    await rendered(readStatement.id);
    const readEmail = (await statementEmail(readStatement.id))!;
    await s.messaging.deliver(agency.companyId, readEmail);
    const readAt = await providerReports(readEmail.messageId, 'read');
    expect((await r.statements.get(agency.manager, readStatement.id)).deliveredAt).toEqual(readAt);

    const bounced = await owner({ email: 'review-owner-f@test.invalid' });
    const statement = await issued(bounced.ownerId, M1);
    await rendered(statement.id);
    const email = (await statementEmail(statement.id))!;
    await s.messaging.deliver(agency.companyId, email);
    await providerReports(email.messageId, 'failed', 'hard_bounce');
    const view = await r.statements.get(agency.manager, statement.id);
    expect(view.sentAt).toBeInstanceOf(Date);
    expect(view.deliveredAt).toBeNull();
  });

  it('honours an opt-out and records why no email went; an owner with no address gets none', async () => {
    const o = await owner({ email: 'review-owner-o@test.invalid' });
    const first = await issued(o.ownerId, M2);
    await rendered(first.id);
    const firstEmail = (await statementEmail(first.id))!;
    await s.messaging.deliver(agency.companyId, firstEmail);
    // The owner marks it as spam: the provider reports a complaint, an opt-out from email.
    await providerReports(firstEmail.messageId, 'failed', 'spam_complaint');
    const second = await issued(o.ownerId, M1);
    const after = await rendered(second.id);
    expect(after.row!.sent_at).toBeNull();
    expect(after.row!.email_message_id).toBeNull();
    expect(after.row!.email_not_sent_reason).toBe('opted_out');
    expect(await statementEmail(second.id)).toBeNull();
    const view = await r.statements.get(agency.manager, second.id);
    expect(view).toMatchObject({
      sentAt: null,
      deliveredAt: null,
      emailNotSentReason: 'opted_out',
    });
    // The send job honours it as well: a statement email queued anyway is not sent.
    const messageId = uuidv7();
    await system((tx) =>
      queueMessage(tx, agency.companyId, {
        messageId,
        recipient: { type: 'owner', ownerId: o.ownerId },
        purpose: 'owner_statement',
        channels: ['email'],
        subject: 'Your statement',
        body: 'Your statement is attached.',
      }),
    );
    const queued = (await outboxOf(ctx, agency.companyId, 'messaging.send'))
      .map((e) => messageRequestSchema.parse(e.payload))
      .find((p) => p.messageId === messageId)!;
    expect(await s.messaging.deliver(agency.companyId, queued)).toBe('not_sent');
    const events = await system((tx) =>
      tx.execute<{ status: string; reason: string | null }>(
        sql`select status, reason from message_event where message_id = ${messageId}::uuid
            order by occurred_at, id`,
      ),
    );
    // The send job names every refusal on consent `no_consent` (M6's planner); for an owner,
    // whose address on record is the consent, that can only be this opt-out.
    expect(events.rows.at(-1)).toEqual({ status: 'not_sent', reason: 'no_consent' });

    const none = await owner();
    const noEmail = await issued(none.ownerId, M1);
    const record = await rendered(noEmail.id);
    expect(record.row!.email_not_sent_reason).toBe('no_email');
    expect(record.row!.sent_at).toBeNull();
    expect((await r.statements.get(agency.manager, noEmail.id)).emailNotSentReason).toBe(
      'no_email',
    );
  });
});

describe('AC-04 and DA-01 one split of 2010 for the statement and the dashboard (founder, 2026-11-07)', () => {
  it('gives the same month-end split both ways for a lease paid ahead past its invoices, and nothing changes after month end', async () => {
    const o = await owner({ withUnit: true });
    const lease = await leaseOn(o.unitId!, { start: `${M2}-01`, rentMinor: 100_000 });
    // In M2, five and a half months: M2's rent, the invoiced months not started then, and more.
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 550_000,
      receivedOn: dayOf(M2, 10),
    });
    const byLease = async (asOf: string) =>
      (await system((tx) => prepaymentSplitAt(tx, { leaseIds: [lease.id], asOf }))).get(lease.id)!;
    const pageOf = async () => {
      const draft = await r.statements.draft(agency.manager, { ownerId: o.ownerId, month: M2 });
      return { draft, accrual: draft.figures.properties[0]!.accrual };
    };
    const dashboard = await byLease(lastOf(M2));
    const { draft, accrual } = await pageOf();
    expect(accrual).toMatchObject({
      unearnedRentMinor: dashboard.unearnedRentMinor,
      unearnedServiceChargeMinor: dashboard.unearnedServiceChargeMinor,
      creditMinor: dashboard.creditMinor,
      unearnedMinor: dashboard.prepaymentsMinor,
    });
    // Paid ahead past its invoices: months invoiced and not started, and credit beyond them.
    expect(dashboard.unearnedRentMinor).toBeGreaterThan(0);
    expect(dashboard.creditMinor).toBeGreaterThan(0);
    expect(dashboard.prepaymentsMinor).toBe(550_000 - 100_000);
    expect(
      dashboard.unearnedRentMinor + dashboard.unearnedServiceChargeMinor + dashboard.creditMinor,
    ).toBe(dashboard.prepaymentsMinor);

    // After the month: more money, and the months it paid start. M2's split stays as it was.
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 100_000,
      receivedOn: dayOf(M1, 5),
    });
    await b.invoicing.accrueAll(agency.companyId, today);
    expect(await byLease(lastOf(M2))).toEqual(dashboard);
    const later = await pageOf();
    expect(later.accrual).toEqual(accrual);
    const issuedM2 = await r.statements.issue(agency.manager, draft.id);
    expect(issuedM2.figures.properties[0]!.accrual).toEqual(accrual);
    // Today the months paid have started: less unearned, as the dashboard reads it now.
    expect((await byLease(today)).unearnedRentMinor).toBeLessThan(dashboard.unearnedRentMinor);
  });
});

describe('TX-04 the rent-tax hold-back leaves out tax a tenant withheld (M9 review #9)', () => {
  it('holds back nothing for GH₵1,500 withheld and pending its certificate (worked example B)', async () => {
    const o = await owner({ withUnit: true, use: 'commercial' });
    const lease = await leaseOn(o.unitId!, {
      start: `${M2}-01`,
      rentMinor: 1_000_000,
      use: 'commercial',
    });
    await b.invoicing.accrueAll(agency.companyId, today);
    const [line] = await system((tx) =>
      tx
        .select({ id: schema.invoiceLine.id })
        .from(schema.invoiceLine)
        .where(sql`lease_id = ${lease.id} and kind = 'rent' and period_start = ${`${M2}-01`}`),
    );
    await system((tx) =>
      tx.execute(
        sql`insert into management_fee_terms (company_id, owner_id, kind, gra_paid_by, effective_from)
            values (${agency.companyId}::uuid, ${o.ownerId}::uuid, 'none', 'agency',
              ${`${M3}-01`}::date)`,
      ),
    );
    await t.withholding.record(agency.manager, {
      leaseId: lease.id,
      valueDate: dayOf(M2, 5),
      lines: [{ lineId: line!.id, amountMinor: 150_000 }],
    });
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 850_000,
      receivedOn: dayOf(M2, 5),
    });
    const draft = await r.statements.draft(agency.manager, { ownerId: o.ownerId, month: M2 });
    expect(draft.figures.rentTaxPayable!.closingMinor).toBe(150_000);
    expect(draft.figures.agent!.graPaidBy).toBe('agency');
    expect(draft.figures.agent!.rentTaxHeldBackMinor).toBe(0);
  });
});
