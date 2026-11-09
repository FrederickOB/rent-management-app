import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  eq,
  inArray,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import {
  addDays,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  startOfDay,
  toIsoDate,
} from '@rent/domain/dates';
import { settlementEntryLines, shareSettlementFees } from '@rent/domain/ledger';
import { format, money } from '@rent/domain/money';
import { reconcileSettlement, reconcileTransactions } from '@rent/domain/payments';
import { DomainError } from '@rent/domain/errors';
import type { AlertPort, ProviderSettlement } from '@rent/integrations';
import { companyRecord } from '../companies/companies.service';
import { cashAccountFor } from '../companies/settlement-destinations';
import type { AppLogger } from '../core/logging/logger';
import type { PaymentProviders } from '../core/payment-providers';
import { ALERT_PORT, DATABASE, LOGGER, PAYMENT_PROVIDERS } from '../core/tokens';
import { PostingService } from '../ledger/posting.service';
import {
  isPlatformReference,
  isPlatformSettlement,
  type PlatformCharges,
} from './platform-charges';
import { ProviderPaymentsService } from './provider-payments.service';

/** Reconciliation days are Accra days (architecture section 10: jobs run on Accra time). */
const RECONCILIATION_TIME_ZONE = 'Africa/Accra';

export interface TransactionRun {
  readonly listed: number;
  readonly matched: number;
  readonly processed: number;
  readonly exceptions: number;
}

/**
 * Daily reconciliation (CLAUDE.md section 8; M4b plan 4.8). Transactions first: each successful
 * charge the provider lists that we do not have goes through the normal path (verify, then post
 * or queue); each of ours the provider does not list, or lists differently, is flagged for a
 * person. Then settlements: each report is matched to its payments and posted as P22, one entry
 * per book, payment by payment; any difference is raised, never absorbed.
 */
@Injectable()
export class ReconciliationService {
  private platform: PlatformCharges | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(ProviderPaymentsService) private readonly payments: ProviderPaymentsService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** M10: the subscription module takes the platform's own charges (registered at start-up). */
  usePlatformCharges(handler: PlatformCharges): void {
    this.platform = handler;
  }

  /** The instants of an Accra day: from its first instant to the next day's. */
  static dayRange(day: string): { from: string; to: string } {
    const date = parseBusinessDate(day);
    return {
      from: startOfDay(date, RECONCILIATION_TIME_ZONE).toString(),
      to: startOfDay(addDays(date, 1), RECONCILIATION_TIME_ZONE).toString(),
    };
  }

  /** `payments.reconcile-transactions` for one provider and day (plan 4.12). */
  async transactions(provider: string, day: string): Promise<TransactionRun> {
    const port = this.providers.get(provider);
    const range = ReconciliationService.dayRange(day);
    const all = await port.listTransactions(range);
    // M10 decision 9: the platform's own charges (`SUB-`) are reconciled by subscriptions and
    // never matched to rent; everything below sees rent only.
    const listed = all.filter((t) => !isPlatformReference(t.reference));
    const references = listed.map((t) => t.reference);
    const known = await withSystem(this.database, {}, async (tx) => {
      const byRef = await tx.execute<{
        reference: string;
        company_id: string;
        payment_id: string;
        amount_minor: string;
        reversed: boolean;
      }>(
        sql`select reference, company_id, payment_id, amount_minor, reversed
            from app.provider_payment_refs(${provider}, ${`{${references.map((r) => `"${r.replace(/"/g, '')}"`).join(',')}}`}::text[])`,
      );
      const recorded = await tx.execute<{
        reference: string;
        company_id: string;
        payment_id: string;
        amount_minor: string;
        reversed: boolean;
      }>(
        sql`select reference, company_id, payment_id, amount_minor, reversed
            from app.provider_payments_between(${provider}, ${range.from}::timestamptz, ${range.to}::timestamptz)`,
      );
      const all = new Map<string, (typeof byRef.rows)[number]>();
      for (const r of [...byRef.rows, ...recorded.rows]) all.set(r.reference, r);
      return all;
    });
    const result = reconcileTransactions(
      listed.map((t) => ({
        reference: t.reference,
        status: t.status,
        amountMinor: t.amountMinor,
        currency: t.currency,
      })),
      [...known.values()].map((p) => ({
        reference: p.reference,
        amountMinor: Number(p.amount_minor),
        reversed: p.reversed,
      })),
    );
    let processed = 0;
    let exceptions = 0;
    const posted: string[] = [];
    for (const reference of result.toProcess) {
      // Missed by the webhook and verify-pending (an outage): the normal path posts it once.
      const outcome = await this.payments.processReference(provider, reference);
      if (
        [
          'posted',
          'posted_flagged',
          'matched_by_reference',
          'unmatched',
          'already_posted',
        ].includes(outcome)
      ) {
        processed += 1;
        posted.push(reference);
      }
      this.logger.info({ provider, outcome }, 'reconciliation processed a missed provider payment');
    }
    // A payment posted after its settlement was reconciled is settled now (review item 16).
    await this.settleLate(provider, posted);
    // Taken back at the provider and not reversed here: the chargeback path checks with the
    // provider, so a missed refund or dispute webhook is caught (review item 16). So are refunds
    // and disputes made today against charges paid on earlier days.
    const everyReversal = await port.listReversals(range);
    const platform = await this.platformTransactions(
      provider,
      range,
      all.filter((t) => isPlatformReference(t.reference)),
      everyReversal.filter((r) => isPlatformReference(r.reference)),
    );
    const listedReversals = everyReversal.filter((r) => !isPlatformReference(r.reference));
    const reversedRefs = [
      ...new Set([
        ...result.toReverse,
        ...listedReversals.filter((r) => r.status === 'processed').map((r) => r.reference),
      ]),
    ];
    for (const reference of reversedRefs) {
      if (await this.payments.ownRefund(provider, reference)) continue;
      const outcome = await this.payments.recordChargeback(provider, reference);
      this.logger.info({ provider, outcome }, 'reconciliation checked a reversal at the provider');
    }
    for (const exception of result.exceptions) {
      if (exception.kind === 'missing_here' && result.toProcess.includes(exception.reference)) {
        // Processed above: flagged only if it still is not here.
        const after = await withSystem(this.database, {}, (tx) =>
          tx.execute<{ payment_id: string }>(
            sql`select payment_id from app.provider_payment_refs(${provider}, ${`{"${exception.reference.replace(/"/g, '')}"}`}::text[])`,
          ),
        );
        if (after.rows.length > 0) continue;
      }
      if (exception.kind === 'missing_at_provider') {
        // Listed under another day (a charge started before midnight, paid after): ask directly.
        const verified = await port.verify(exception.reference).catch(() => null);
        const ours = known.get(exception.reference);
        if (
          verified?.status === 'success' &&
          ours &&
          verified.amountMinor === Number(ours.amount_minor)
        )
          continue;
      }
      const local = known.get(exception.reference);
      const companyId =
        local?.company_id ??
        (await this.payments.intentByReference(exception.reference))?.companyId ??
        null;
      if (!companyId && exception.kind === 'currency_differs') {
        // Not ours yet: its company is the one its subaccount settles to.
        const owner = await this.payments.companyOfCharge(provider, exception.reference);
        if (owner) {
          await withCompany(this.database, { companyId: owner, actorKind: 'system' }, (tx) =>
            this.payments.flag(tx, owner, {
              kind: 'amount_differs',
              provider,
              reference: exception.reference,
              detail: describe(exception),
              dedupeKey: `currency_differs:${provider}:${exception.reference}`,
            }),
          );
          exceptions += 1;
          continue;
        }
      }
      if (!companyId) {
        await this.alerts.raise({
          severity: 'warning',
          code: 'payments.reconciliation_unowned',
          message: 'Reconciliation found a provider transaction that belongs to no company',
          context: { provider, kind: exception.kind },
        });
        continue;
      }
      await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
        this.payments.flag(tx, companyId, {
          // A charge in another currency is shown as an amount that differs (review item 7).
          kind: exception.kind === 'currency_differs' ? 'amount_differs' : exception.kind,
          provider,
          reference: exception.reference,
          paymentId: local?.payment_id ?? null,
          amountMinor:
            exception.kind === 'amount_differs'
              ? exception.providerMinor
              : local
                ? Number(local.amount_minor)
                : null,
          detail: describe(exception),
          dedupeKey: `${exception.kind}:${provider}:${exception.reference}`,
        }),
      );
      exceptions += 1;
    }
    return {
      listed: all.length,
      matched: result.matched + platform.matched,
      processed: processed + platform.processed,
      exceptions: exceptions + platform.exceptions,
    };
  }

  /** The platform's own transactions for the day, handed to subscriptions (M10 decision 9). */
  private async platformTransactions(
    provider: string,
    range: { readonly from: string; readonly to: string },
    transactions: Parameters<PlatformCharges['reconcile']>[2],
    reversals: Parameters<PlatformCharges['reconcile']>[3],
  ): Promise<{
    readonly matched: number;
    readonly processed: number;
    readonly exceptions: number;
  }> {
    if (this.platform) return this.platform.reconcile(provider, range, transactions, reversals);
    if (transactions.length > 0 || reversals.length > 0)
      await this.alerts.raise({
        severity: 'warning',
        code: 'payments.platform_unreconciled',
        message: 'Platform (subscription) transactions were not reconciled: nothing takes them',
        context: { provider, transactions: transactions.length, reversals: reversals.length },
      });
    return { matched: 0, processed: 0, exceptions: transactions.length };
  }

  /** `payments.reconcile-settlements` for one provider and day (plan 4.12). */
  async settlements(provider: string, day: string): Promise<number> {
    const port = this.providers.get(provider);
    const listed = await port.listSettlements(ReconciliationService.dayRange(day));
    let posted = 0;
    for (const settlement of listed) {
      if (settlement.status !== 'success') continue;
      // M10 decision 9: a payout of the platform's own balance is the subscription's (P26).
      if (isPlatformSettlement(settlement)) {
        if (this.platform) {
          if (await this.platform.settlement(provider, settlement)) posted += 1;
        } else
          await this.alerts.raise({
            severity: 'warning',
            code: 'payments.platform_unreconciled',
            message: 'A payout of the platform balance was not reconciled: nothing takes it',
            context: { provider },
          });
        continue;
      }
      if (await this.settlement(provider, settlement)) posted += 1;
    }
    await this.clearing(provider, day);
    return posted;
  }

  /**
   * One settlement, once (keyed on the provider's settlement id per company): P22 per book, with
   * each payment's share of the fees, and the deductions for chargebacks and refunds. Anything the
   * report does not explain is raised as an exception (invariant 11).
   */
  async settlement(provider: string, s: ProviderSettlement): Promise<boolean> {
    const found = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ company_id: string; settlement_account_id: string }>(
        sql`select company_id, settlement_account_id from app.settlement_by_subaccount(${provider}, ${s.subaccountCode})`,
      ),
    );
    const owner = found.rows[0];
    if (!owner) {
      await this.alerts.raise({
        severity: 'warning',
        code: 'payments.settlement_unowned',
        message: 'A settlement arrived for a subaccount we do not know',
        context: { provider },
      });
      return false;
    }
    const companyId = owner.company_id;
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [existing] = await tx
        .select({ id: schema.providerSettlement.id })
        .from(schema.providerSettlement)
        .where(
          and(
            eq(schema.providerSettlement.provider, provider),
            eq(schema.providerSettlement.settlementRef, s.settlementId),
          ),
        );
      if (existing) {
        // Reconciled before: settle any of its payments posted since (review item 16).
        await this.settleLateIn(tx, companyId, provider, existing.id);
        return false;
      }
      const [account] = await tx
        .select()
        .from(schema.settlementAccount)
        .where(eq(schema.settlementAccount.id, owner.settlement_account_id));
      const company = await companyRecord(tx, companyId);
      const to = cashAccountFor(account!.holder as 'owner' | 'agency', company!.kind);
      const [row] = await tx
        .insert(schema.providerSettlement)
        .values({
          companyId,
          provider,
          settlementRef: s.settlementId,
          settlementAccountId: account!.id,
          subaccountCode: s.subaccountCode,
          grossMinor: s.grossMinor,
          feesMinor: s.feesMinor,
          deductionsMinor: s.deductionsMinor,
          netMinor: s.netMinor,
          settledAt: new Date(s.settledAt),
          chargeReferences: [...s.references],
        })
        .returning({ id: schema.providerSettlement.id });
      const settlementRowId = row!.id;
      const refs = [...s.references, ...s.deductedReferences.map((d) => d.reference)];
      const payments = refs.length
        ? await tx
            .select({
              id: schema.payment.id,
              reference: schema.payment.providerReference,
              bookId: schema.payment.bookId,
              amountMinor: schema.payment.amountMinor,
            })
            .from(schema.payment)
            .where(
              and(
                eq(schema.payment.provider, provider),
                inArray(schema.payment.providerReference, refs),
              ),
            )
        : [];
      // A matched payment's money moved to its lease's book (P23): it settles there.
      const books = await this.booksOf(
        tx,
        payments.map((p) => p.id),
      );
      const settled = payments
        .filter((p) => s.references.includes(p.reference!))
        .map((p) => ({
          reference: p.reference!,
          paymentId: p.id,
          bookId: books.get(p.id) ?? p.bookId,
          amountMinor: p.amountMinor,
        }));
      const result = reconcileSettlement(
        {
          settlementId: s.settlementId,
          grossMinor: s.grossMinor,
          feesMinor: s.feesMinor,
          netMinor: s.netMinor + s.deductionsMinor,
          references: s.references,
        },
        settled,
      );
      // Deductions: the reversed payments the provider names, in the book their reversal took
      // the money back from (P21b, Cr 1050).
      // Deductions: the reversed or refunded payments the provider names (P21b or P31, Cr 1050).
      const deductionBooks = await this.reversalBooks(
        tx,
        payments.map((p) => p.id),
      );
      const deductions = s.deductedReferences.flatMap((d) => {
        const payment = payments.find((p) => p.reference === d.reference);
        const bookId = payment ? deductionBooks.get(payment.id) : undefined;
        return payment && bookId
          ? [{ paymentId: payment.id, amountMinor: d.amountMinor, bookId }]
          : [];
      });
      const named = deductions.reduce((sum, d) => sum + d.amountMinor, 0);
      const books2 = new Set([
        ...result.parts.map((p) => p.bookId),
        ...deductions.map((d) => d.bookId),
      ]);
      const unposted: string[] = [];
      for (const bookId of books2) {
        const part = result.parts.find((p) => p.bookId === bookId);
        const shares = part
          ? shareSettlementFees(
              settled
                .filter((p) => p.bookId === bookId)
                .map((p) => ({ paymentId: p.paymentId, amountMinor: p.amountMinor })),
              part.feesMinor,
            )
          : [];
        const lines = settlementEntryLines({
          bookId,
          to,
          provider,
          settlementId: settlementRowId,
          settlementAccountId: account!.id,
          shares,
          deductions: deductions.filter((d) => d.bookId === bookId),
        });
        if (lines.length === 0) continue;
        // Each book in a savepoint: one that cannot post is raised, and the rest still post
        // (review F6).
        try {
          await tx.transaction((sp) =>
            this.posting.post(sp, {
              companyId,
              rule: 'P22',
              key: `P22:${settlementRowId}:${bookId}`,
              valueDate: toIsoDate(
                businessDateOf(instantFrom(new Date(s.settledAt)), company!.timeZone),
              ),
              lines,
              record: { type: 'provider_settlement', id: settlementRowId },
              causedBy: null,
            }),
          );
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          unposted.push(error.message);
        }
      }
      const problems: string[] = [];
      for (const reason of unposted)
        problems.push(`part of it could not be posted (${reason.slice(0, 120)})`);
      if (s.netMinor < 0)
        problems.push(
          `the provider paid out nothing and kept back ${format(money(-s.netMinor))} more than this settlement held; check how it recovers that sum`,
        );
      if (result.unknownReferences.length > 0)
        problems.push(
          `${result.unknownReferences.length} payment(s) in the report are not ours or not posted yet`,
        );
      if (result.grossDifferenceMinor !== 0)
        problems.push(
          `the report's gross differs from the payments it names by ${format(money(result.grossDifferenceMinor))}`,
        );
      if (!result.arithmeticHolds)
        problems.push("the report's gross less fees and deductions is not its net");
      if (named !== s.deductionsMinor)
        problems.push(
          `${format(money(s.deductionsMinor - named))} of deductions name no reversed payment of ours`,
        );
      if (problems.length > 0)
        await this.payments.flag(tx, companyId, {
          kind: 'settlement_difference',
          provider,
          settlementRef: s.settlementId,
          ownerId: account!.ownerId,
          amountMinor: result.grossDifferenceMinor || s.deductionsMinor - named || null,
          detail: `Settlement ${s.settlementId}: ${problems.join('; ')}.`,
          dedupeKey: `settlement_difference:${provider}:${s.settlementId}`,
        });
      return true;
    });
  }

  /**
   * Payments posted after the settlement that paid them out was reconciled (review item 16):
   * each settled now, once, by its own P22 entry keyed on the payment. Its share of the fees was
   * already taken with the others (recorded as a known gap in the plan), so it settles in full.
   */
  async settleLate(provider: string, references: readonly string[]): Promise<number> {
    if (references.length === 0) return 0;
    const refs = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ company_id: string }>(
        sql`select distinct company_id from app.provider_payment_refs(${provider}, ${`{${references.map((r) => `"${r.replace(/"/g, '')}"`).join(',')}}`}::text[])`,
      ),
    );
    let settled = 0;
    for (const { company_id: companyId } of refs.rows)
      settled += await withCompany(
        this.database,
        { companyId, actorKind: 'system' },
        async (tx) => {
          const rows = await tx
            .select({ id: schema.providerSettlement.id })
            .from(schema.providerSettlement)
            .where(
              and(
                eq(schema.providerSettlement.provider, provider),
                sql`${schema.providerSettlement.chargeReferences} && ${`{${references.map((r) => `"${r.replace(/"/g, '')}"`).join(',')}}`}::text[]`,
              ),
            );
          let n = 0;
          for (const row of rows) n += await this.settleLateIn(tx, companyId, provider, row.id);
          return n;
        },
      );
    return settled;
  }

  /** Settles a reconciled settlement's payments that have no P22 line yet. */
  private async settleLateIn(
    tx: Tx,
    companyId: string,
    provider: string,
    settlementRowId: string,
  ): Promise<number> {
    const [row] = await tx
      .select()
      .from(schema.providerSettlement)
      .where(eq(schema.providerSettlement.id, settlementRowId));
    if (!row || row.chargeReferences.length === 0) return 0;
    const late = await tx
      .select({
        id: schema.payment.id,
        bookId: schema.payment.bookId,
        amountMinor: schema.payment.amountMinor,
      })
      .from(schema.payment)
      .where(
        and(
          eq(schema.payment.provider, provider),
          inArray(schema.payment.providerReference, row.chargeReferences),
          sql`not exists (select 1 from journal_line l where l.company_id = ${schema.payment.companyId}
                and l.payment_id = ${schema.payment.id} and l.account_code = '1050'
                and l.settlement_id is not null and l.amount_minor < 0)`,
        ),
      );
    if (late.length === 0) return 0;
    const [account] = await tx
      .select()
      .from(schema.settlementAccount)
      .where(eq(schema.settlementAccount.id, row.settlementAccountId));
    const company = await companyRecord(tx, companyId);
    const to = cashAccountFor(account!.holder as 'owner' | 'agency', company!.kind);
    const books = await this.booksOf(
      tx,
      late.map((p) => p.id),
    );
    for (const payment of late) {
      await this.posting.post(tx, {
        companyId,
        rule: 'P22',
        key: `P22:${settlementRowId}:payment:${payment.id}`,
        valueDate: toIsoDate(businessDateOf(instantFrom(row.settledAt), company!.timeZone)),
        lines: settlementEntryLines({
          bookId: books.get(payment.id) ?? payment.bookId,
          to,
          provider,
          settlementId: settlementRowId,
          settlementAccountId: account!.id,
          shares: [{ paymentId: payment.id, grossMinor: payment.amountMinor, feesMinor: 0 }],
          deductions: [],
        }),
        record: { type: 'provider_settlement', id: settlementRowId },
        causedBy: null,
      });
    }
    return late.length;
  }

  /**
   * Invariant 11 (review item 11): provider clearing (1050) for each settlement account equals
   * what the provider still holds unsettled for its subaccount: successful charges of the last
   * 14 days not yet paid out, less refunds and chargebacks not yet deducted. Any difference is
   * raised for a person, once a day per account.
   */
  async clearing(provider: string, day: string): Promise<number> {
    const port = this.providers.get(provider);
    const from = ReconciliationService.dayRange(
      toIsoDate(addDays(parseBusinessDate(day), -13)),
    ).from;
    // To the end of the day after: everything posted so far, whatever the clock's lag.
    const range = {
      from,
      to: ReconciliationService.dayRange(toIsoDate(addDays(parseBusinessDate(day), 1))).to,
    };
    const [charges, settlements, reversals] = [
      await port.listTransactions(range),
      await port.listSettlements(range),
      await port.listReversals(range),
    ];
    const paidOut = new Set(settlements.flatMap((x) => x.references));
    const deducted = new Map<string, number>();
    for (const d of settlements.flatMap((x) => x.deductedReferences))
      deducted.set(d.reference, (deducted.get(d.reference) ?? 0) + d.amountMinor);
    const owed = new Map<string, number>();
    const add = (code: string, amount: number) => owed.set(code, (owed.get(code) ?? 0) + amount);
    const subaccountOf = new Map<string, string>();
    // Every account the provider shows activity for is compared, even with nothing unsettled.
    for (const settlement of settlements) add(settlement.subaccountCode, 0);
    for (const c of charges) {
      add(c.subaccountCode, 0);
      subaccountOf.set(c.reference, c.subaccountCode);
      if (c.currency !== 'GHS') continue;
      if ((c.status === 'success' || c.status === 'reversed') && !paidOut.has(c.reference))
        add(c.subaccountCode, c.amountMinor);
    }
    const taken = new Map<string, number>();
    for (const r of reversals)
      if (r.status === 'processed')
        taken.set(r.reference, (taken.get(r.reference) ?? 0) + r.amountMinor);
    for (const [reference, amount] of taken) {
      const code = subaccountOf.get(reference);
      const left = amount - (deducted.get(reference) ?? 0);
      if (code && left > 0) add(code, -left);
    }
    let raised = 0;
    for (const [code, providerMinor] of owed) {
      const found = await withSystem(this.database, {}, (tx) =>
        tx.execute<{ company_id: string; settlement_account_id: string }>(
          sql`select company_id, settlement_account_id from app.settlement_by_subaccount(${provider}, ${code})`,
        ),
      );
      const owner = found.rows[0];
      if (!owner) continue;
      const companyId = owner.company_id;
      raised += await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
        const held = await tx.execute<{ total: string | null }>(
          sql`select coalesce(sum(amount_minor), 0)::text as total from journal_line
                where account_code = '1050' and provider = ${provider}
                  and settlement_account_id = ${owner.settlement_account_id}`,
        );
        const ourMinor = Number(held.rows[0]?.total ?? 0);
        if (ourMinor === providerMinor) return 0;
        const [account] = await tx
          .select({ ownerId: schema.settlementAccount.ownerId })
          .from(schema.settlementAccount)
          .where(eq(schema.settlementAccount.id, owner.settlement_account_id));
        await this.payments.flag(tx, companyId, {
          kind: 'settlement_difference',
          provider,
          ownerId: account?.ownerId ?? null,
          amountMinor: Math.abs(ourMinor - providerMinor),
          detail: `Provider clearing does not agree with the provider: our books hold ${format(money(ourMinor))} not yet paid out to this account, the provider ${format(money(providerMinor))} (invariant 11). Check recent payments, refunds and chargebacks.`,
          dedupeKey: `clearing:${provider}:${owner.settlement_account_id}:${day}`,
        });
        return 1;
      });
    }
    return raised;
  }

  /** The book each payment's money now sits in: its match's book when matched, else its own. */
  private async booksOf(tx: Tx, paymentIds: readonly string[]): Promise<Map<string, string>> {
    if (paymentIds.length === 0) return new Map();
    const rows = await tx
      .select({ paymentId: schema.paymentMatch.paymentId, bookId: schema.paymentMatch.bookId })
      .from(schema.paymentMatch)
      .where(inArray(schema.paymentMatch.paymentId, [...paymentIds]));
    return new Map(rows.map((r) => [r.paymentId, r.bookId]));
  }

  /** The book a reversal took each payment's money back from provider clearing in. */
  private async reversalBooks(tx: Tx, paymentIds: readonly string[]): Promise<Map<string, string>> {
    if (paymentIds.length === 0) return new Map();
    const rows = await tx.execute<{ payment_id: string; book_id: string }>(
      sql`select distinct l.payment_id, l.book_id from journal_line l
          join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
          where e.rule in ('P21', 'P31') and l.account_code = '1050' and l.amount_minor < 0
            and l.payment_id = any(${`{${paymentIds.join(',')}}`}::uuid[])`,
    );
    return new Map(rows.rows.map((r) => [r.payment_id, r.book_id]));
  }
}

function describe(e: ReturnType<typeof reconcileTransactions>['exceptions'][number]): string {
  switch (e.kind) {
    case 'missing_here':
      return 'The provider lists a successful payment we have not recorded; processing it did not record it either.';
    case 'missing_at_provider':
      return 'We recorded a provider payment that the provider does not list for its day.';
    case 'amount_differs':
      return `The provider lists ${format(money(e.providerMinor))} where we recorded ${format(money(e.localMinor))}.`;
    case 'not_successful_at_provider':
      return `We recorded a payment the provider lists as ${e.status}.`;
    case 'currency_differs':
      return `The provider lists a charge in ${e.currency.slice(0, 3)}, not cedis. Nothing was posted; check it with the provider.`;
  }
}
