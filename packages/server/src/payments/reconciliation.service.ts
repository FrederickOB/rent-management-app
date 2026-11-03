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
import type { AlertPort, ProviderSettlement } from '@rent/integrations';
import { companyRecord } from '../companies/companies.service';
import { cashAccountFor } from '../companies/settlement-destinations';
import type { AppLogger } from '../core/logging/logger';
import type { PaymentProviders } from '../core/payment-providers';
import { ALERT_PORT, DATABASE, LOGGER, PAYMENT_PROVIDERS } from '../core/tokens';
import { PostingService } from '../ledger/posting.service';
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
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(ProviderPaymentsService) private readonly payments: ProviderPaymentsService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

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
    const listed = await port.listTransactions(range);
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
      )
        processed += 1;
      this.logger.info({ provider, outcome }, 'reconciliation processed a missed provider payment');
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
          kind: exception.kind,
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
    return { listed: listed.length, matched: result.matched, processed, exceptions };
  }

  /** `payments.reconcile-settlements` for one provider and day (plan 4.12). */
  async settlements(provider: string, day: string): Promise<number> {
    const port = this.providers.get(provider);
    const listed = await port.listSettlements(ReconciliationService.dayRange(day));
    let posted = 0;
    for (const settlement of listed) {
      if (settlement.status !== 'success') continue;
      if (await this.settlement(provider, settlement)) posted += 1;
    }
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
      if (existing) return false;
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
        await this.posting.post(tx, {
          companyId,
          rule: 'P22',
          key: `P22:${settlementRowId}:${bookId}`,
          valueDate: toIsoDate(
            businessDateOf(instantFrom(new Date(s.settledAt)), company!.timeZone),
          ),
          lines,
          record: { type: 'provider_settlement', id: settlementRowId },
          causedBy: null,
        });
      }
      const problems: string[] = [];
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
          where e.rule = 'P21' and l.account_code = '1050' and l.amount_minor < 0
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
  }
}
