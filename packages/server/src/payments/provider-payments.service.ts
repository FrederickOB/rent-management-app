import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { compareVerified, exactMatch } from '@rent/domain/payments';
import { maskPhone, tryNormalisePhone } from '@rent/domain/phone';
import { ProviderError, type AlertPort, type ProviderTransaction } from '@rent/integrations';
import { v5 as uuidv5 } from 'uuid';
import { BillingEngine, type LeaseState } from '../billing/engine';
import {
  companyBookId,
  leaseGroup,
  lockCounters,
  lockLeases,
  lockPayment,
  ownerBookId,
  paymentsByIds,
} from '../billing/records';
import { companyRecord } from '../companies/companies.service';
import { cashAccountFor, destinationForOwner } from '../companies/settlement-destinations';
import type { Clock } from '../core/clock';
import type { FieldCipher } from '../core/crypto/field-cipher';
import { queueMessage } from '../core/messages';
import type { PaymentProviders } from '../core/payment-providers';
import { ALERT_PORT, CLOCK, DATABASE, FIELD_CIPHER, PAYMENT_PROVIDERS } from '../core/tokens';
import type { AppLogger } from '../core/logging/logger';
import { LOGGER } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import { membersWhoCan } from './members';

/** Namespace for the ids of provider payments with no intent: one per provider and reference. */
const PROVIDER_CHARGE_NAMESPACE = '4f0c6d8e-2b7a-5c1e-9d3f-8a6b4c2e1f00';

type IntentRow = typeof schema.paymentIntent.$inferSelect;

export type ConfirmOutcome =
  'posted' | 'posted_flagged' | 'already_posted' | 'pending' | 'failed' | 'abandoned' | 'rejected';

/** How a provider reference was dealt with, for the inbox and reconciliation. */
export type ReferenceOutcome =
  | ConfirmOutcome
  | 'matched_by_reference'
  | 'unmatched'
  | 'not_paid'
  | 'unknown_subaccount'
  | 'unknown';

/**
 * Provider payments (BC-02, BC-03, BC-07; M4b plan 4.4, 4.5 and 4.8). Money is posted only from
 * the provider's verify answer, compared exactly with our own intent; never from a webhook body.
 * Provider calls happen before any transaction opens. Posting reuses M4a's engine, so a provider
 * payment is accrued first, allocated oldest debt first and receipted in one transaction, and
 * replaying any of it changes nothing.
 */
@Injectable()
export class ProviderPaymentsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  /**
   * Verifies a reference with its provider and posts what was verified: through its intent when
   * our pay page started it, otherwise as a payment that matches only on an exact lease reference
   * (BC-03) or waits in the unmatched queue (P23). Used by the webhook processor, verify-pending,
   * the pay page's status check and reconciliation alike.
   */
  async processReference(provider: string, reference: string): Promise<ReferenceOutcome> {
    if (!this.providers.has(provider)) return 'unknown';
    const port = this.providers.get(provider);
    const intent = await this.intentByReference(reference);
    let verified: ProviderTransaction;
    try {
      verified = await port.verifyTransaction(reference);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return 'unknown';
      throw error;
    }
    if (intent) return this.confirmIntent(intent.companyId, intent.intentId, provider, verified);
    if (verified.status !== 'success') return 'not_paid';
    return this.receiveCharge(provider, verified);
  }

  /** The company and intent a reference belongs to, from the narrow system function (ids only). */
  async intentByReference(
    reference: string,
  ): Promise<{ companyId: string; intentId: string } | null> {
    const result = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ company_id: string; intent_id: string }>(
        sql`select company_id, intent_id from app.payment_intent_by_reference(${reference})`,
      ),
    );
    const row = result.rows[0];
    return row ? { companyId: row.company_id, intentId: row.intent_id } : null;
  }

  /**
   * Posts an intent from what its provider verified (plan 4.4): amount, currency, status and
   * reference compared exactly. A different amount posts the money received and is flagged for a
   * person; a different reference or currency posts nothing and raises a security alert. A
   * confirmed intent is final, so a second confirmation (a webhook after the page's own check)
   * does nothing.
   */
  async confirmIntent(
    companyId: string,
    intentId: string,
    provider: string,
    verified: ProviderTransaction,
  ): Promise<ConfirmOutcome> {
    const ctx = { companyId, actorKind: 'system' as const };
    const outcome = await withCompany(this.database, ctx, async (tx) => {
      const unlocked = await this.intent(tx, intentId);
      await lockLeases(tx, companyId, await leaseGroup(tx, unlocked.leaseId));
      await lockCounters(tx, companyId);
      const intent = await this.intent(tx, intentId, { lock: true });
      if (intent.status === 'confirmed') return 'already_posted' as const;
      const now = this.clock.now();
      const result = compareVerified(
        { reference: intent.reference, amountMinor: intent.amountMinor, currency: intent.currency },
        verified,
      );
      const set = (values: Partial<typeof schema.paymentIntent.$inferInsert>) =>
        tx
          .update(schema.paymentIntent)
          .set({
            ...(intent.provider ? {} : { provider }),
            lastCheckedAt: now,
            updatedAt: now,
            ...values,
          })
          .where(eq(schema.paymentIntent.id, intent.id));
      switch (result.kind) {
        case 'reject':
          await set({ failureReason: `verification_${result.reason}` });
          return 'rejected' as const;
        case 'not_paid':
          if (result.status === 'pending') {
            await set({});
            return 'pending' as const;
          }
          await set({
            status: result.status === 'abandoned' ? 'abandoned' : 'failed',
            failureReason: result.status,
            message:
              result.status === 'abandoned'
                ? 'The payment was not completed. You can try again.'
                : 'The payment did not go through. You can try again.',
          });
          return result.status === 'abandoned' ? ('abandoned' as const) : ('failed' as const);
        case 'post':
        case 'post_and_flag': {
          const state = await this.engine.load(tx, companyId, intent.leaseId);
          const company = state.company;
          const receivedOn = this.dayOf(
            verified.paidAt,
            company.timeZone,
            this.engine.today(state),
          );
          const { paymentId } = await this.engine.receive(tx, state, {
            amountMinor: result.amountMinor,
            receivedOn,
            method: intent.method as 'momo' | 'card',
            rule: 'P03',
            cashAccount: '1050',
            provider,
            sourceType: 'payment_intent',
            sourceId: intent.id,
            providerReference: intent.reference,
            settlementAccountId: intent.settlementAccountId,
            payerPhoneIndex: intent.payerPhoneIndex,
            payerPhoneMasked: intent.payerPhoneMasked,
          });
          await set({
            status: 'confirmed',
            paymentId,
            confirmedAt: now,
            verifiedAmountMinor: result.amountMinor,
            message: null,
          });
          if (result.kind === 'post_and_flag')
            await this.flag(tx, companyId, {
              kind: 'verified_amount_differs',
              provider,
              reference: intent.reference,
              paymentId,
              propertyId: intent.propertyId,
              amountMinor: result.amountMinor,
              detail: `The provider confirmed ${format(money(result.amountMinor))} against a request for ${format(money(intent.amountMinor))}. The money received was posted; check it with the tenant.`,
              dedupeKey: `verified_amount_differs:${provider}:${intent.reference}`,
            });
          return result.kind === 'post' ? ('posted' as const) : ('posted_flagged' as const);
        }
      }
    });
    if (outcome === 'rejected')
      await this.alerts.raise({
        severity: 'critical',
        code: 'payments.verification_mismatch',
        message: 'A provider payment did not match its intent; nothing was posted',
        context: { companyId, intentId, provider },
      });
    return outcome;
  }

  /**
   * A successful provider payment that did not start on our pay page (BC-03, BC-12): its company
   * and account come from the subaccount the provider verified. An exact lease payment reference
   * in what the payer typed matches it at once; anything else waits in suspense (P23) in the book
   * of whoever's account it settles to, for a person to match.
   */
  async receiveCharge(provider: string, verified: ProviderTransaction): Promise<ReferenceOutcome> {
    const account = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ company_id: string; settlement_account_id: string }>(
        sql`select company_id, settlement_account_id from app.settlement_by_subaccount(${provider}, ${verified.subaccountCode})`,
      ),
    );
    const found = account.rows[0];
    if (!found) {
      await this.alerts.raise({
        severity: 'warning',
        code: 'payments.unknown_subaccount',
        message: 'A provider payment arrived for a subaccount we do not know',
        context: { provider },
      });
      return 'unknown_subaccount';
    }
    const companyId = found.company_id;
    const sourceId = uuidv5(`${provider}:${verified.reference}`, PROVIDER_CHARGE_NAMESPACE);
    const narration =
      verified.metadata.narration ??
      verified.metadata.reference ??
      verified.metadata.payment_reference ??
      null;
    const phone = verified.payerPhone ? tryNormalisePhone(verified.payerPhone) : null;
    const match = exactMatch({ intentId: null, narration });
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [existing] = await tx
        .select({ id: schema.payment.id })
        .from(schema.payment)
        .where(
          and(
            eq(schema.payment.sourceType, 'provider_charge'),
            eq(schema.payment.sourceId, sourceId),
          ),
        );
      if (existing) return 'already_posted' as const;
      const [settlementAccount] = await tx
        .select()
        .from(schema.settlementAccount)
        .where(eq(schema.settlementAccount.id, found.settlement_account_id));
      const company = await companyRecord(tx, companyId);
      if (!settlementAccount || !company) return 'unknown_subaccount' as const;
      const today = toIsoDate(businessDateOf(instantFrom(this.clock.now()), company.timeZone));
      const money = {
        amountMinor: verified.amountMinor,
        receivedOn: this.dayOf(verified.paidAt, company.timeZone, today),
        method: (verified.channel === 'bank' ? 'bank_transfer' : verified.channel) as
          'momo' | 'card' | 'bank_transfer',
        cashAccount: '1050' as const,
        provider,
        sourceType: 'provider_charge' as const,
        sourceId,
        senderReference: narration?.slice(0, 80) ?? null,
        providerReference: verified.reference,
        settlementAccountId: settlementAccount.id,
        payerPhoneIndex: phone ? this.cipher.blindIndex(companyId, `phone:${phone}`) : null,
        payerPhoneMasked: phone ? maskPhone(phone) : null,
      };
      if (match.kind === 'reference') {
        const lease = await this.leaseByReference(tx, match.reference);
        if (lease) {
          await lockLeases(tx, companyId, await leaseGroup(tx, lease));
          await lockCounters(tx, companyId);
          const state = await this.engine.load(tx, companyId, lease);
          if (await this.settlesTo(tx, state, settlementAccount.id)) {
            await this.engine.receive(tx, state, { ...money, rule: 'P03' });
            return 'matched_by_reference' as const;
          }
        }
      }
      const holder = settlementAccount.holder as 'owner' | 'agency';
      const bookId =
        holder !== 'agency' && settlementAccount.ownerId
          ? await ownerBookId(tx, settlementAccount.ownerId)
          : await companyBookId(tx);
      await this.engine.receiveUnmatched(tx, {
        ...money,
        companyId,
        bookId,
        ownerId: holder === 'agency' ? null : settlementAccount.ownerId,
      });
      return 'unmatched' as const;
    });
  }

  /**
   * A chargeback or a refund made at the provider (P21b; plan 4.8): once the provider verifies
   * the charge as reversed, the payment is reversed from what it pays for now, the money is taken
   * back from provider clearing (the next settlement deducts it), a credit receipt is issued and
   * managers are told. Our own refund of unmatched money (P31) is not a chargeback.
   */
  async recordChargeback(provider: string, reference: string): Promise<'reversed' | 'ignored'> {
    const refs = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ company_id: string; payment_id: string; reversed: boolean }>(
        sql`select company_id, payment_id, reversed from app.provider_payment_refs(${provider}, ${`{${reference}}`}::text[])`,
      ),
    );
    const ref = refs.rows[0];
    if (!ref || ref.reversed) return 'ignored';
    const verified = await this.providers.get(provider).verify(reference);
    if (verified.status !== 'reversed' || verified.reference !== reference) return 'ignored';
    const companyId = ref.company_id;
    const done = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => {
        await lockPayment(tx, companyId, ref.payment_id);
        const [refund] = await tx
          .select({ id: schema.unmatchedRefund.id })
          .from(schema.unmatchedRefund)
          .where(
            and(
              eq(schema.unmatchedRefund.paymentId, ref.payment_id),
              sql`${schema.unmatchedRefund.status} in ('approved', 'refunded')`,
            ),
          );
        if (refund) return false;
        const leases = await this.leasesOf(tx, ref.payment_id);
        await lockLeases(tx, companyId, leases);
        await lockCounters(tx, companyId);
        const [payment] = await paymentsByIds(tx, [ref.payment_id]);
        if (!payment || payment.reversedAccountingDate) return false;
        const states: LeaseState[] = [];
        for (const leaseId of leases) states.push(await this.engine.load(tx, companyId, leaseId));
        const company = await companyRecord(tx, companyId);
        await this.engine.reverse(tx, states, payment, {
          reason: 'chargeback',
          note: 'Charged back or refunded at the payment provider',
          moneyNowIn: 'provider',
          approvalRequestId: null,
          requestedBy: null,
          today: toIsoDate(businessDateOf(instantFrom(this.clock.now()), company!.timeZone)),
        });
        // Everyone who sees provider payments is told (plan 4.8: a manager alert).
        for (const personId of await membersWhoCan(tx, this.policy, company!, 'payments.view'))
          await queueMessage(tx, companyId, {
            recipient: { type: 'staff', personId },
            purpose: 'staff_notice',
            subject: 'A payment was charged back',
            body: `A provider payment of ${format(money(payment.amountMinor))} was charged back or refunded at the provider. It has been reversed with a credit receipt; the provider takes it out of the next settlement.`,
            channels: ['email'],
            propertyId: payment.row.propertyId,
            related: { type: 'payment', id: payment.id },
          });
        return true;
      },
    );
    if (!done) return 'ignored';
    await this.alerts.raise({
      severity: 'warning',
      code: 'payments.chargeback',
      message: 'A provider payment was charged back and reversed',
      context: { companyId, paymentId: ref.payment_id, provider },
    });
    return 'reversed';
  }

  /**
   * `payments.verify-pending` for one company (plan 4.4): intents still waiting after 5 minutes
   * are checked with their provider, so a lost webhook is caught within minutes. An intent never
   * charged (its request failed half-way) is looked for with each provider; after an hour with
   * nothing, it is abandoned.
   */
  async verifyPending(companyId: string): Promise<number> {
    const now = this.clock.now();
    const intents = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .select()
        .from(schema.paymentIntent)
        .where(
          and(
            sql`${schema.paymentIntent.status} in ('initiated', 'pending')`,
            sql`${schema.paymentIntent.createdAt} < ${new Date(now.getTime() - 5 * 60_000)}`,
          ),
        ),
    );
    let checked = 0;
    for (const intent of intents) {
      const candidates = intent.provider ? [intent.provider] : this.providers.names();
      let seen = false;
      for (const provider of candidates) {
        if (!this.providers.has(provider)) continue;
        try {
          const verified = await this.providers.get(provider).verifyTransaction(intent.reference);
          await this.confirmIntent(companyId, intent.id, provider, verified);
          seen = true;
          checked += 1;
          break;
        } catch (error) {
          if (error instanceof ProviderError && error.status === 404) continue;
          this.logger.warn(
            { err: error, intentId: intent.id },
            'verify-pending could not check an intent',
          );
          seen = true;
          break;
        }
      }
      if (
        !seen &&
        intent.status === 'initiated' &&
        now.getTime() - intent.createdAt.getTime() > 3_600_000
      )
        await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
          tx
            .update(schema.paymentIntent)
            .set({ status: 'abandoned', failureReason: 'never_charged', updatedAt: now })
            .where(
              and(
                eq(schema.paymentIntent.id, intent.id),
                eq(schema.paymentIntent.status, 'initiated'),
              ),
            ),
        );
    }
    return checked;
  }

  /** Records what reconciliation or verification could not explain, once per key. */
  async flag(
    tx: Tx,
    companyId: string,
    input: {
      readonly kind:
        | 'missing_here'
        | 'missing_at_provider'
        | 'amount_differs'
        | 'not_successful_at_provider'
        | 'settlement_difference'
        | 'verified_amount_differs'
        | 'receipt_late';
      readonly provider: string;
      readonly reference?: string | null;
      readonly settlementRef?: string | null;
      readonly paymentId?: string | null;
      readonly propertyId?: string | null;
      readonly ownerId?: string | null;
      readonly amountMinor?: number | null;
      readonly detail: string;
      readonly dedupeKey: string;
    },
  ): Promise<void> {
    await tx
      .insert(schema.reconciliationException)
      .values({
        companyId,
        kind: input.kind,
        provider: input.provider,
        reference: input.reference ?? null,
        settlementRef: input.settlementRef ?? null,
        paymentId: input.paymentId ?? null,
        propertyId: input.propertyId ?? null,
        ownerId: input.ownerId ?? null,
        amountMinor: input.amountMinor ?? null,
        detail: input.detail.slice(0, 500),
        dedupeKey: input.dedupeKey.slice(0, 200),
      })
      .onConflictDoNothing();
  }

  // Helpers -----------------------------------------------------------------------------------------

  /** Whether a lease's rent settles to this account now (its destination). */
  private async settlesTo(tx: Tx, state: LeaseState, accountId: string): Promise<boolean> {
    if (state.book.kind !== 'book') return false;
    const destination = await destinationForOwner(
      tx,
      state.company,
      state.book.ownerId,
      this.engine.today(state),
    );
    return destination.kind === 'ok' && destination.destination.accountId === accountId;
  }

  private async leaseByReference(tx: Tx, reference: string): Promise<string | null> {
    const [row] = await tx
      .select({ leaseId: schema.paymentReference.leaseId })
      .from(schema.paymentReference)
      .where(eq(schema.paymentReference.reference, reference));
    return row?.leaseId ?? null;
  }

  private async leasesOf(tx: Tx, paymentId: string): Promise<string[]> {
    const rows = await tx.execute<{ lease_id: string }>(
      sql`select lease_id from payment where id = ${paymentId} and lease_id is not null
          union select lease_id from payment_match where payment_id = ${paymentId}
          union select lease_id from allocation where payment_id = ${paymentId}
          union select lease_id from credit_carry_over where payment_id = ${paymentId}`,
    );
    return [...new Set(rows.rows.map((r) => r.lease_id))].sort();
  }

  /** The business day a payment was made, in the company's time zone; never after today. */
  private dayOf(paidAt: string | undefined, timeZone: string, today: string): string {
    if (!paidAt) return today;
    const day = toIsoDate(businessDateOf(instantFrom(new Date(paidAt)), timeZone));
    return day > today ? today : day;
  }

  async intent(tx: Tx, id: string, options: { lock?: boolean } = {}): Promise<IntentRow> {
    const query = tx.select().from(schema.paymentIntent).where(eq(schema.paymentIntent.id, id));
    const [row] = options.lock ? await query.for('update') : await query;
    if (!row) throw new Error(`Payment intent ${id} not found`);
    return row;
  }

  /** The settlement destination's cash account, for P22 (re-exported for reconciliation). */
  static cashAccountFor = cashAccountFor;
}
