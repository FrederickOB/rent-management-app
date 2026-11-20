import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, schema, sql, type Tx } from '@rent/db';
import { lineBalance } from '@rent/domain/billing';
import { parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { rentTaxLines, rentTaxReversalLines, type PaymentAmount } from '@rent/domain/ledger';
import {
  receiptTax,
  receiptTaxBase,
  rentTaxDueDate,
  taxedPerReceipt,
  taxPeriodsFromWalk,
  type TaxItemKind,
  type TaxPeriod,
  type WithholdingTaxTreatment,
} from '@rent/domain/tax';
import type { AlertPort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { BillingEngine, type LeaseState, type TaxHooks } from '../billing/engine';
import {
  dimsOf,
  openingPaymentIds,
  paymentsByIds,
  requireBook,
  type PaymentRecord,
} from '../billing/records';
import { ownerFacts } from '../companies/owners.service';
import { ALERT_PORT } from '../core/tokens';
import { PostingService } from '../ledger/posting.service';
import { RulesService, type ResolvedRule } from '../rules/rules.service';
import {
  appendTaxEvent,
  lockOwnersTax,
  netItemLines,
  NOT_ASSESSED_ACTION,
  taxedByPeriod,
  uuids,
  type NotAssessedEvent,
} from './tax-records';

/** The rules a rent tax calculation reads as of its business date, each recorded (TX-08). */
export interface RentTaxRuleSet {
  readonly rate: ResolvedRule;
  readonly base: ResolvedRule;
  readonly rounding: ResolvedRule;
  readonly serviceCharge: ResolvedRule;
  readonly due: ResolvedRule;
  readonly alert: ResolvedRule;
  readonly rateBps: number;
  readonly includesServiceCharge: boolean;
  readonly dueDays: number;
}

/** The basis this build implements (D9); any other base or rounding is refused, never guessed. */
export const SUPPORTED_BASE = 'rent_received_including_advances';
export const SUPPORTED_ROUNDING = 'half_up_per_receipt';

/**
 * Whether an event's rent tax can be assessed as of its business date (TX-08; M5 review 7):
 * `assess` with the rules; `not_per_receipt` for an owner in the letting business (decision 2);
 * `not_assessed` when a rules row it needs is missing, or is not one this build applies. The
 * money posts all the same; a person is alerted and a later run assesses it.
 */
export type RentTaxAssessment =
  | { readonly kind: 'assess'; readonly rules: RentTaxRuleSet }
  | { readonly kind: 'not_per_receipt' }
  | {
      readonly kind: 'not_assessed';
      readonly reason: 'rule_missing' | 'rule_unsupported';
      readonly ruleKey: string | null;
      readonly message: string;
    };

/** A withholding as its rent tax reads it. */
export interface WithholdingTax {
  readonly id: string;
  readonly paymentId: string | null;
  readonly valueDate: string;
  readonly lines: readonly { readonly lineId: string; readonly amountMinor: number }[];
  readonly rateBps: number;
  readonly rateRuleId: string;
  readonly causedBy: string | null;
  /** Cash it returned to credit, by payment (review 2). */
  readonly released: readonly PaymentAmount[];
}

/** What a withholding's rent tax was (review 1), from its assessment. */
export const treatmentOf = (a: RentTaxAssessment): WithholdingTaxTreatment =>
  a.kind === 'assess'
    ? 'accrued'
    : a.kind === 'not_per_receipt'
      ? 'letting_business'
      : 'not_assessed';

class MissingRentTaxRule extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
  }
}

interface NewItem {
  readonly kind: TaxItemKind;
  readonly rule: 'P17' | 'P21';
  readonly key: string;
  readonly paymentId: string | null;
  readonly withholdingId?: string | null;
  readonly reversesItemId?: string | null;
  readonly valueDate: string;
  readonly dueDate: string | null;
  readonly rateBps: number;
  readonly lines: readonly {
    readonly chargePeriodId: string;
    readonly invoiceLineId: string | null;
    readonly baseMinor: number;
    readonly taxMinor: number;
  }[];
  readonly receiptNumber?: number | null;
  readonly unitCode?: string;
  readonly tenantName?: string;
  readonly rules: {
    readonly rateRuleId: string;
    readonly baseRuleId?: string | null;
    readonly roundingRuleId?: string | null;
    readonly serviceChargeRuleId?: string | null;
    readonly dueRuleId?: string | null;
    readonly alertRuleId?: string | null;
  };
  readonly causedBy: string | null;
}

/**
 * Rent tax per receipt (TX-01, TX-02, TX-08; P17, P21; M5 plan 5.1 and 5.11). Registered as the
 * billing engine's tax hooks, it runs in the posting transaction of every receipt, payment
 * reversal and carry-over: a receipt is taxed on the rent it newly covers (the forward walk's
 * covered rent and service charge after it, less the base already taxed on the lease), within its
 * own money, at the rate for the lease's use as of its value date, rounded half up once; the tax
 * is split across the periods it covers and posted Dr 5300, Cr 2200. A reversal mirrors its
 * payment's tax; withholding replaces the tax accrued on the cash of the lines it was withheld on.
 * Owners in the business of letting are not taxed per receipt (decision 2).
 */
@Injectable()
export class RentTaxService implements TaxHooks {
  constructor(
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Optional() @Inject(ALERT_PORT) private readonly alerts?: AlertPort,
  ) {
    engine.useTaxHooks(this);
  }

  /** The rent tax rules as of a business date, for a lease's use (TX-08). */
  async rulesAt(
    tx: Tx,
    country: string,
    use: 'residential' | 'commercial',
    date: string,
  ): Promise<RentTaxRuleSet> {
    const at = parseBusinessDate(date);
    const get = async (key: string) => {
      try {
        return await this.rules.resolveIn(tx, country, key, at);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'rule.missing')
          throw new MissingRentTaxRule(key, error.message);
        throw error;
      }
    };
    const rate = await get(`rent_tax.rate.${use}`);
    const base = await get('rent_tax.base');
    const rounding = await get('rent_tax.rounding');
    const serviceCharge = await get('rent_tax.includes_service_charge');
    const due = await get('rent_tax.due_days_after_receipt');
    const alert = await get('rent_tax.alert_days');
    return {
      rate,
      base,
      rounding,
      serviceCharge,
      due,
      alert,
      rateBps: (rate.value as { bps: number }).bps,
      includesServiceCharge: serviceCharge.value === true,
      dueDays: (due.value as { days: number }).days,
    };
  }

  /**
   * Whether a lease's event can be assessed on a date (review 7): not per receipt for an owner in
   * the letting business (decision 2) or a lease with no owner book; not assessed when a rules row
   * is missing, or its base or rounding is not one this build implements (nothing is guessed).
   */
  async assessment(tx: Tx, state: LeaseState, date: string): Promise<RentTaxAssessment> {
    if (state.book.kind !== 'book') return { kind: 'not_per_receipt' };
    const owner = (await ownerFacts(tx, [state.book.ownerId])).get(state.book.ownerId);
    if (!owner || !taxedPerReceipt(owner)) return { kind: 'not_per_receipt' };
    return this.rulesAssessment(tx, state, date);
  }

  /**
   * The rules half of `assessment`: whether the rules in force on a date can be applied. A later
   * run uses it alone (review 7), since the event was recorded as not assessed only for an owner
   * taxed per receipt then, whatever the owner's flag says today (review 1).
   */
  async rulesAssessment(
    tx: Tx,
    state: LeaseState,
    date: string,
  ): Promise<Exclude<RentTaxAssessment, { kind: 'not_per_receipt' }>> {
    let rules: RentTaxRuleSet;
    try {
      rules = await this.rulesAt(tx, state.company.countryCode, state.lease.use, date);
    } catch (error) {
      if (error instanceof MissingRentTaxRule)
        return {
          kind: 'not_assessed',
          reason: 'rule_missing',
          ruleKey: error.key,
          message: `No rules row ${error.key} is in force on ${date}, so no rent tax was assessed`,
        };
      throw error;
    }
    if (rules.base.value !== SUPPORTED_BASE || rules.rounding.value !== SUPPORTED_ROUNDING)
      return {
        kind: 'not_assessed',
        reason: 'rule_unsupported',
        ruleKey: rules.base.value !== SUPPORTED_BASE ? 'rent_tax.base' : 'rent_tax.rounding',
        message:
          'A rent tax rule in force is not one this build can apply, so no rent tax was assessed',
      };
    return { kind: 'assess', rules };
  }

  /**
   * Records an event whose rent tax was not assessed (review 7): in the audit log, with what a
   * later run needs to assess it, and an alert for a person. The money has posted all the same.
   */
  async notAssessed(
    tx: Tx,
    state: LeaseState,
    a: Extract<RentTaxAssessment, { kind: 'not_assessed' }>,
    event: Pick<
      NotAssessedEvent,
      'event' | 'eventKey' | 'paymentId' | 'withholdingId' | 'valueDate' | 'capMinor' | 'released'
    > & { readonly capRentOnlyMinor?: number },
  ): Promise<void> {
    const book = requireBook(state.book);
    const data: NotAssessedEvent & { readonly capRentOnlyMinor?: number } = {
      ...event,
      leaseId: state.lease.id,
      ownerId: book.ownerId,
      propertyId: state.lease.propertyId,
      unitCode: state.lease.unitCode,
      reason: a.reason,
      ruleKey: a.ruleKey,
      message: a.message,
    };
    await appendTaxEvent(tx, state.company.id, NOT_ASSESSED_ACTION, event.eventKey, { ...data });
    await this.alerts
      ?.raise({
        severity: 'critical',
        code: 'tax.not_assessed',
        message: `${a.message}: ${event.event} on ${state.lease.unitCode}`,
        context: {
          companyId: state.company.id,
          leaseId: state.lease.id,
          eventKey: event.eventKey,
          ruleKey: a.ruleKey ?? '',
        },
      })
      .catch(() => undefined);
  }

  /** The lease's periods as the walk covers them now, with what is taxed and withheld on each. */
  async periods(tx: Tx, state: LeaseState): Promise<TaxPeriod[]> {
    const keyOf = new Map(
      state.lines.flatMap((l) => (l.chargePeriodId ? [[l.id, l.chargePeriodId] as const] : [])),
    );
    const withheld = new Set<string>();
    for (const line of state.lines) {
      if (!line.chargePeriodId) continue;
      const net = state.allocations
        .filter((a) => a.lineId === line.id && a.source === 'withholding')
        .reduce((s, a) => s + a.amountMinor, 0);
      if (net > 0) withheld.add(line.chargePeriodId);
    }
    // M11 (P25; OQ-64): money received before the platform (opening payments, and the deposit held
    // at the cut-over) is not rent received through it: what it covers is left out of every period,
    // paid onto a month or still credit the walk applies forward. Opening payments whose credit
    // moved to a renewal still paid this lease's lines, so they are found from the allocations too.
    const opening = await openingPaymentIds(tx, [
      ...state.payments.map((p) => p.id),
      ...state.allocations.map((a) => a.paymentId),
    ]);
    return taxPeriodsFromWalk({
      walk: this.engine.walk(state),
      periodKeyOf: (key) => keyOf.get(key) ?? key,
      taxed: await taxedByPeriod(tx, state.lease.id),
      withheld,
      opening: { paymentIds: opening, allocations: state.allocations },
    });
  }

  /**
   * The invoice line a period's rent tax line names. A month brought in at the cut-over and raised
   * later has more than one opening line (founder 2026-11-10): the earliest, in invoice order.
   */
  private lineOfPeriod(state: LeaseState): (periodId: string) => string | null {
    const lines = new Map<string, string>();
    for (const l of state.lines)
      if (l.chargePeriodId && !lines.has(l.chargePeriodId)) lines.set(l.chargePeriodId, l.id);
    return (periodId) => lines.get(periodId) ?? null;
  }

  /** P17 on a receipt (plan 5.1 and 5.11), in the payment's posting transaction. */
  async afterReceipt(
    tx: Tx,
    state: LeaseState,
    receipt: {
      readonly payment: PaymentRecord;
      readonly receiptId: string;
      readonly causedBy: string | null;
    },
  ): Promise<void> {
    const payment = receipt.payment;
    const valueDate = payment.row.receivedOn;
    const a = await this.assessment(tx, state, valueDate);
    if (a.kind === 'not_per_receipt') return;
    if (a.kind === 'not_assessed') {
      await this.notAssessed(tx, state, a, {
        event: 'receipt',
        eventKey: `P17:${payment.id}`,
        paymentId: payment.id,
        withholdingId: null,
        valueDate,
        capMinor: this.receiptCap(state, payment, true),
        capRentOnlyMinor: this.receiptCap(state, payment, false),
        released: [],
      });
      return;
    }
    const [number] = await tx
      .select({ number: schema.receipt.number })
      .from(schema.receipt)
      .where(eq(schema.receipt.id, receipt.receiptId));
    await this.assessReceipt(tx, state, {
      key: `P17:${payment.id}`,
      paymentId: payment.id,
      valueDate,
      capMinor: this.receiptCap(state, payment, a.rules.includesServiceCharge),
      receiptNumber: number?.number ?? null,
      rules: a.rules,
      causedBy: receipt.causedBy,
    });
  }

  /**
   * A receipt's P17 (plan 5.1 and 5.11): the rent it newly covers within `capMinor`, at the rate
   * for the lease's use, rounded half up once and split across its periods. Also the tax on cash
   * a withholding returned to credit (review 2), and on a receipt a later run assesses (review 7),
   * each on its own key.
   */
  async assessReceipt(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly key: string;
      readonly paymentId: string;
      /** Review 2: the withholding whose release of this payment's cash it taxes. */
      readonly withholdingId?: string | null;
      readonly valueDate: string;
      readonly capMinor: number;
      readonly receiptNumber: number | null;
      readonly rules: RentTaxRuleSet;
      readonly causedBy: string | null;
    },
  ): Promise<string | null> {
    const periods = await this.periods(tx, state);
    const { baseMinor, pins } = receiptTaxBase(periods, input.rules, input.capMinor);
    if (baseMinor <= 0) return null;
    const tax = receiptTax(pins, periods, input.rules.rateBps);
    const lineOf = this.lineOfPeriod(state);
    return this.writeItem(tx, state, {
      kind: 'receipt',
      rule: 'P17',
      key: input.key,
      paymentId: input.paymentId,
      withholdingId: input.withholdingId ?? null,
      valueDate: input.valueDate,
      dueDate: rentTaxDueDate(input.valueDate, input.rules.dueDays),
      rateBps: input.rules.rateBps,
      lines: tax.lines.map((l) => ({
        chargePeriodId: l.key,
        invoiceLineId: lineOf(l.key),
        baseMinor: l.baseMinor,
        taxMinor: l.taxMinor,
      })),
      receiptNumber: input.receiptNumber,
      rules: ruleIds(input.rules),
      causedBy: input.causedBy,
    });
  }

  /**
   * A receipt is never taxed on more than its own rent money (plan 5.11): the payment less what it
   * paid towards deposits, VAT and levies, one-off charges, and service charge while it is not
   * taxed. Credit beyond the lease end is not covered rent, so the walk leaves it out anyway.
   */
  receiptCap(state: LeaseState, payment: PaymentRecord, includesServiceCharge: boolean): number {
    const kindOf = new Map(state.lines.map((l) => [l.id, l.kind]));
    let other = 0;
    for (const a of state.allocations) {
      if (a.source !== 'payment' || a.paymentId !== payment.id) continue;
      const kind = kindOf.get(a.lineId);
      if (kind === 'rent' || (kind === 'service_charge' && includesServiceCharge)) continue;
      other += a.amountMinor;
    }
    return Math.max(0, payment.amountMinor - other);
  }

  /** P21 mirrors the payment's rent tax (plan 5.1): what is left of each of its items, negated. */
  async afterReversal(
    tx: Tx,
    states: readonly LeaseState[],
    payment: PaymentRecord,
    reversal: {
      readonly reversalId: string;
      readonly valueDate: string;
      readonly causedBy: string | null;
    },
  ): Promise<void> {
    // Review 10: the owners' tax locks after the lease locks the caller holds, so no GRA payment
    // settles these items while their tax is taken back.
    const owners = await tx.execute<{ owner_id: string }>(
      sql`select distinct owner_id from rent_tax_item where payment_id = ${payment.id} and kind = 'receipt'`,
    );
    await lockOwnersTax(
      tx,
      payment.row.companyId,
      owners.rows.map((o) => o.owner_id),
    );
    const items = await tx.execute<{
      id: string;
      lease_id: string;
      rate_bps: number;
      rate_rule_id: string;
      unit_code: string;
      tenant_name: string;
    }>(
      sql`select id, lease_id, rate_bps, rate_rule_id, unit_code, tenant_name from rent_tax_item
          where payment_id = ${payment.id} and kind = 'receipt' order by created_at, id`,
    );
    for (const item of items.rows) {
      const net = (await netItemLines(tx, item.id)).filter(
        (l) => l.baseMinor !== 0 || l.taxMinor !== 0,
      );
      if (net.length === 0) continue;
      const state =
        states.find((s) => s.lease.id === item.lease_id) ??
        (await this.engine.load(tx, payment.row.companyId, item.lease_id));
      await this.writeItem(tx, state, {
        kind: 'reversal',
        rule: 'P21',
        key: `P21:${payment.id}:tax:${item.id}`,
        paymentId: payment.id,
        reversesItemId: item.id,
        valueDate: reversal.valueDate,
        dueDate: null,
        rateBps: item.rate_bps,
        lines: net.map((l) => ({ ...l, baseMinor: -l.baseMinor, taxMinor: -l.taxMinor })),
        unitCode: item.unit_code,
        tenantName: item.tenant_name,
        rules: { rateRuleId: item.rate_rule_id },
        causedBy: reversal.causedBy,
      });
    }
  }

  /**
   * Credit carried to a renewal (P29) and applied to its rent is taxed then (plan 5.1): the walk of
   * the renewal now covers more, within the credit carried.
   */
  async afterCarryOver(
    tx: Tx,
    to: LeaseState,
    carried: {
      readonly key: string;
      readonly valueDate: string;
      readonly credits: readonly PaymentAmount[];
      readonly fromLeaseId?: string;
    },
  ): Promise<void> {
    const a = await this.assessment(tx, to, carried.valueDate);
    if (a.kind === 'not_per_receipt') return;
    // Review N2: credit a correction released after it was taxed as rent on the old lease (a
    // credit note leaves the tax in place, OQ-19) is not taxed again when it pays the renewal.
    let cap = 0;
    for (const c of carried.credits)
      cap += carried.fromLeaseId
        ? await this.untaxedCredit(
            tx,
            carried.fromLeaseId,
            c,
            a.kind === 'assess' ? a.rules.includesServiceCharge : true,
          )
        : c.amountMinor;
    const paymentId = carried.credits.length === 1 ? carried.credits[0]!.paymentId : null;
    if (a.kind === 'not_assessed') {
      await this.notAssessed(tx, to, a, {
        event: 'carry_over',
        eventKey: `P17:${carried.key}`,
        paymentId,
        withholdingId: null,
        valueDate: carried.valueDate,
        capMinor: cap,
        released: [],
      });
      return;
    }
    await this.assessCarryOver(tx, to, {
      key: `P17:${carried.key}`,
      paymentId,
      valueDate: carried.valueDate,
      capMinor: cap,
      rules: a.rules,
    });
  }

  /**
   * The part of a payment's credit never taxed on the lease it leaves (review N2): the credit,
   * less what the payment's rent tax there was charged on beyond the rent its cash still pays
   * (its net taxed base, less its allocations to rent, and to service charge while taxed).
   */
  private async untaxedCredit(
    tx: Tx,
    fromLeaseId: string,
    credit: PaymentAmount,
    includesServiceCharge: boolean,
  ): Promise<number> {
    const kinds = includesServiceCharge ? sql`('rent', 'service_charge')` : sql`('rent')`;
    const rows = await tx.execute<{ taxed: string; covered: string }>(
      sql`select
            coalesce((select sum(i.base_minor) from rent_tax_item i where i.lease_id = ${fromLeaseId}
              and i.payment_id = ${credit.paymentId} and i.kind <> 'withholding'), 0)::bigint as taxed,
            coalesce((select sum(a.amount_minor) from allocation a
              join invoice_line l on l.company_id = a.company_id and l.id = a.invoice_line_id
              where a.lease_id = ${fromLeaseId} and a.source = 'payment' and a.payment_id = ${credit.paymentId}
                and l.kind in ${kinds}), 0)::bigint as covered`,
    );
    const excess = Math.max(0, Number(rows.rows[0]!.taxed) - Number(rows.rows[0]!.covered));
    return Math.max(0, credit.amountMinor - excess);
  }

  /**
   * M8 (P11, plan 4.8): rent a move-out settled from the deposit is rent received then, so it is
   * taxed as a carry-over is: the rent the walk now covers, within what the deposit paid towards
   * rent (and service charge while it is taxed). One key per settlement, `P17:P11:<move-out>`.
   */
  async afterDepositApplied(
    tx: Tx,
    state: LeaseState,
    applied: {
      readonly moveOutId: string;
      readonly valueDate: string;
      /** The deposit's draw on rent lines, and on service charge lines. */
      readonly rentMinor: number;
      readonly serviceChargeMinor: number;
    },
  ): Promise<void> {
    const key = `P17:P11:${applied.moveOutId}`;
    const a = await this.assessment(tx, state, applied.valueDate);
    if (a.kind === 'not_per_receipt') return;
    const cap =
      applied.rentMinor +
      (a.kind === 'assess' && !a.rules.includesServiceCharge ? 0 : applied.serviceChargeMinor);
    if (cap <= 0) return;
    if (a.kind === 'not_assessed') {
      await this.notAssessed(tx, state, a, {
        event: 'deposit_applied',
        eventKey: key,
        paymentId: null,
        withholdingId: null,
        valueDate: applied.valueDate,
        capMinor: cap,
        released: [],
      });
      return;
    }
    await this.assessCarryOver(tx, state, {
      key,
      paymentId: null,
      valueDate: applied.valueDate,
      capMinor: cap,
      rules: a.rules,
      kind: 'deposit_applied',
    });
  }

  /** P17 on credit carried to a renewal and applied to its rent, within the credit carried. */
  async assessCarryOver(
    tx: Tx,
    to: LeaseState,
    input: {
      readonly key: string;
      readonly paymentId: string | null;
      readonly valueDate: string;
      readonly capMinor: number;
      readonly rules: RentTaxRuleSet;
      /** M8: the same assessment for rent the deposit settled at move-out. */
      readonly kind?: 'carry_over' | 'deposit_applied';
    },
  ): Promise<string | null> {
    const periods = await this.periods(tx, to);
    const { baseMinor, pins } = receiptTaxBase(periods, input.rules, input.capMinor);
    if (baseMinor <= 0) return null;
    const tax = receiptTax(pins, periods, input.rules.rateBps);
    const lineOf = this.lineOfPeriod(to);
    return this.writeItem(tx, to, {
      kind: input.kind ?? 'carry_over',
      rule: 'P17',
      key: input.key,
      paymentId: input.paymentId,
      valueDate: input.valueDate,
      dueDate: rentTaxDueDate(input.valueDate, input.rules.dueDays),
      rateBps: input.rules.rateBps,
      lines: tax.lines.map((l) => ({
        chargePeriodId: l.key,
        invoiceLineId: lineOf(l.key),
        baseMinor: l.baseMinor,
        taxMinor: l.taxMinor,
      })),
      rules: ruleIds(input.rules),
      causedBy: null,
    });
  }

  /**
   * Withholding (P19; plan 5.2): the tax on the lines it was withheld on becomes the amount
   * withheld. Rent tax already accrued on their cash is reversed, item by item (P21), and the
   * withheld amount is accrued as its own item (P17), "withheld by the tenant", so TX-02 raises no
   * alert for it. An owner in the letting business gets neither (decision 2); a missing rules row
   * leaves it not assessed (review 7). The caller records `treatmentOf(assessment)` with the
   * withholding, and P20 follows that record (review 1).
   */
  async onWithholding(
    tx: Tx,
    state: LeaseState,
    withholding: WithholdingTax,
    assessment: RentTaxAssessment,
  ): Promise<{ readonly paidToGraBeforeMinor: number }> {
    if (assessment.kind === 'not_per_receipt') return { paidToGraBeforeMinor: 0 };
    if (assessment.kind === 'not_assessed') {
      await this.notAssessed(tx, state, assessment, {
        event: 'withholding',
        eventKey: `P17:${withholding.id}`,
        paymentId: withholding.paymentId,
        withholdingId: withholding.id,
        valueDate: withholding.valueDate,
        capMinor: withholding.lines.reduce((sum, l) => sum + l.amountMinor, 0),
        released: withholding.released,
      });
      return { paidToGraBeforeMinor: 0 };
    }
    return this.taxWithholding(tx, state, withholding, assessment.rules);
  }

  /**
   * The rent tax of a withholding (P19; review 2 and N1), assessed now or by a later run: the
   * offsets, the amount withheld, and the tax on cash it returned to credit, which now pays other
   * months (each payment on its own key, within what it returned). Returns how much of the tax it
   * took back had already been paid to GRA: 2200 is then overpaid, and a person is alerted.
   */
  async taxWithholding(
    tx: Tx,
    state: LeaseState,
    withholding: WithholdingTax,
    rules: RentTaxRuleSet,
  ): Promise<{ readonly paidToGraBeforeMinor: number }> {
    const book = requireBook(state.book);
    // Review 10: after the lease locks the caller holds, so no GRA payment settles these items
    // while their tax is taken back.
    await lockOwnersTax(tx, state.company.id, [book.ownerId]);
    const lines = withholding.lines.map((w) => {
      const line = state.lines.find((l) => l.id === w.lineId);
      if (!line?.chargePeriodId) throw new Error(`Line ${w.lineId} has no charge period`);
      return { ...w, line, periodId: line.chargePeriodId };
    });
    const periods = new Set(lines.map((l) => l.periodId));
    // 1. Tax accrued on the cash of those periods is taken back, per item.
    const items = await tx.execute<{
      id: string;
      payment_id: string | null;
      rate_bps: number;
      rate_rule_id: string;
      unit_code: string;
      tenant_name: string;
    }>(
      sql`select distinct i.id, i.payment_id, i.rate_bps, i.rate_rule_id, i.unit_code, i.tenant_name, i.created_at
          from rent_tax_item i join rent_tax_item_line l on l.company_id = i.company_id and l.item_id = i.id
          where i.lease_id = ${state.lease.id} and i.kind in ('receipt', 'carry_over')
            and l.charge_period_id = any(${uuids([...periods])})
          order by i.created_at, i.id`,
    );
    let paidToGraBeforeMinor = 0;
    for (const item of items.rows) {
      const net = (await netItemLines(tx, item.id)).filter(
        (l) => periods.has(l.chargePeriodId) && (l.baseMinor !== 0 || l.taxMinor !== 0),
      );
      if (net.length === 0) continue;
      const before = await this.itemPaidAndNet(tx, item.id);
      await this.writeItem(tx, state, {
        kind: 'withholding_offset',
        rule: 'P21',
        key: `P21:${withholding.id}:${item.id}`,
        paymentId: item.payment_id,
        withholdingId: withholding.id,
        reversesItemId: item.id,
        valueDate: withholding.valueDate,
        dueDate: null,
        rateBps: item.rate_bps,
        lines: net.map((l) => ({ ...l, baseMinor: -l.baseMinor, taxMinor: -l.taxMinor })),
        unitCode: item.unit_code,
        tenantName: item.tenant_name,
        rules: { rateRuleId: item.rate_rule_id },
        causedBy: withholding.causedBy,
      });
      // N1: tax taken back after GRA was paid it leaves 2200 overpaid by that much.
      const after = await this.itemPaidAndNet(tx, item.id);
      paidToGraBeforeMinor +=
        Math.max(0, after.paidMinor - Math.max(0, after.netMinor)) -
        Math.max(0, before.paidMinor - Math.max(0, before.netMinor));
    }
    // 2. The amount withheld is the tax on those lines.
    await this.writeItem(tx, state, {
      kind: 'withholding',
      rule: 'P17',
      key: `P17:${withholding.id}`,
      paymentId: withholding.paymentId,
      withholdingId: withholding.id,
      valueDate: withholding.valueDate,
      dueDate: rentTaxDueDate(withholding.valueDate, rules.dueDays),
      rateBps: withholding.rateBps,
      lines: lines.map((l) => ({
        chargePeriodId: l.periodId,
        invoiceLineId: l.lineId,
        baseMinor: lineBalance(l.line, state.allocations).netMinor,
        taxMinor: l.amountMinor,
      })),
      rules: {
        rateRuleId: withholding.rateRuleId,
        dueRuleId: rules.due.ruleId,
        alertRuleId: rules.alert.ruleId,
      },
      causedBy: withholding.causedBy,
    });
    // 3. Review 2: cash it returned to credit now pays other months; it is taxed as it covers
    // them, within what each payment returned.
    const released = await paymentsByIds(
      tx,
      withholding.released.map((r) => r.paymentId),
    );
    for (const payment of [...released].sort((a, b) => (a.order < b.order ? -1 : 1))) {
      const amount = withholding.released.find((r) => r.paymentId === payment.id)!.amountMinor;
      const [number] = await tx
        .select({ number: schema.receipt.number })
        .from(schema.receipt)
        .where(
          sql`${schema.receipt.paymentId} = ${payment.id} and ${schema.receipt.kind} = 'receipt'`,
        );
      await this.assessReceipt(tx, state, {
        key: `P17:${withholding.id}:${payment.id}`,
        paymentId: payment.id,
        withholdingId: withholding.id,
        valueDate: withholding.valueDate,
        capMinor: amount,
        receiptNumber: number?.number ?? null,
        rules,
        causedBy: withholding.causedBy,
      });
    }
    if (paidToGraBeforeMinor > 0)
      await this.alerts
        ?.raise({
          severity: 'warning',
          code: 'tax.withheld_after_paid',
          message: `Tax withheld on ${state.lease.unitCode} replaces rent tax already paid to GRA; the owner's rent tax is overpaid by ${paidToGraBeforeMinor} pesewas`,
          context: {
            companyId: state.company.id,
            leaseId: state.lease.id,
            withholdingId: withholding.id,
          },
        })
        .catch(() => undefined);
    return { paidToGraBeforeMinor };
  }

  /** An item's tax net of its corrections, and what GRA payments settled of it. */
  private async itemPaidAndNet(
    tx: Tx,
    itemId: string,
  ): Promise<{ readonly paidMinor: number; readonly netMinor: number }> {
    const rows = await tx.execute<{ paid: string; net: string }>(
      sql`select
            coalesce((select sum(p.amount_minor) from gra_payment_item p where p.company_id = i.company_id and p.item_id = i.id), 0)::bigint as paid,
            (i.tax_minor + coalesce((select sum(c.tax_minor) from rent_tax_item c
              where c.company_id = i.company_id and c.reverses_item_id = i.id), 0))::bigint as net
          from rent_tax_item i where i.id = ${itemId}`,
    );
    return { paidMinor: Number(rows.rows[0]!.paid), netMinor: Number(rows.rows[0]!.net) };
  }

  /**
   * Writes an item, its lines and its entry (P17 for tax accrued, P21 for tax taken back) in the
   * caller's transaction. A key posted before means the item exists: nothing new is written.
   */
  private async writeItem(tx: Tx, state: LeaseState, given: NewItem): Promise<string | null> {
    const book = requireBook(state.book);
    const id = uuidv7();
    // One line per charge period (rent_tax_item_line_period_key): a month with two opening lines
    // (an opening line and its raise, founder 2026-11-10) is one period, named by its first line.
    const lineOf = this.lineOfPeriod(state);
    const byPeriod = new Map<string, NewItem['lines'][number]>();
    for (const l of given.lines) {
      const was = byPeriod.get(l.chargePeriodId);
      byPeriod.set(
        l.chargePeriodId,
        was
          ? {
              chargePeriodId: l.chargePeriodId,
              invoiceLineId: lineOf(l.chargePeriodId) ?? was.invoiceLineId,
              baseMinor: was.baseMinor + l.baseMinor,
              taxMinor: was.taxMinor + l.taxMinor,
            }
          : l,
      );
    }
    const item = { ...given, lines: [...byPeriod.values()] };
    const baseMinor = item.lines.reduce((s, l) => s + l.baseMinor, 0);
    const taxMinor = item.lines.reduce((s, l) => s + l.taxMinor, 0);
    if (await this.posting.findByKey(tx, state.company.id, item.key)) return null;
    const lease = dimsOf(state.lease);
    const posted =
      taxMinor === 0
        ? null
        : await this.posting.post(tx, {
            companyId: state.company.id,
            rule: item.rule,
            key: item.key,
            valueDate: item.valueDate,
            lines:
              taxMinor > 0
                ? rentTaxLines({
                    bookId: book.bookId,
                    lease,
                    paymentId: item.paymentId,
                    lines: item.lines.map((l) => ({
                      invoiceLineId: l.invoiceLineId,
                      taxMinor: l.taxMinor,
                    })),
                  })
                : rentTaxReversalLines({
                    bookId: book.bookId,
                    lease,
                    paymentId: item.paymentId,
                    lines: item.lines.map((l) => ({
                      invoiceLineId: l.invoiceLineId,
                      taxMinor: -l.taxMinor,
                    })),
                  }),
            record: { type: 'rent_tax_item', id },
            causedBy: item.causedBy,
          });
    const accountingDate =
      posted?.accountingDate ??
      (await this.posting.accountingDate(tx, [book.bookId], item.valueDate));
    await tx.insert(schema.rentTaxItem).values({
      id,
      companyId: state.company.id,
      propertyId: state.lease.propertyId,
      tenantId: state.lease.tenantId,
      leaseId: state.lease.id,
      unitId: state.lease.unitId,
      ownerId: book.ownerId,
      bookId: book.bookId,
      kind: item.kind,
      paymentId: item.paymentId,
      withholdingId: item.withholdingId ?? null,
      reversesItemId: item.reversesItemId ?? null,
      valueDate: item.valueDate,
      accountingDate,
      dueDate: item.dueDate,
      baseMinor,
      rateBps: item.rateBps,
      taxMinor,
      leaseUse: state.lease.use,
      unitCode: (item.unitCode ?? state.lease.unitCode).slice(0, 40),
      tenantName: (item.tenantName ?? state.lease.tenantName).slice(0, 200),
      receiptNumber: item.receiptNumber ?? null,
      rateRuleId: item.rules.rateRuleId,
      baseRuleId: item.rules.baseRuleId ?? null,
      roundingRuleId: item.rules.roundingRuleId ?? null,
      serviceChargeRuleId: item.rules.serviceChargeRuleId ?? null,
      dueRuleId: item.rules.dueRuleId ?? null,
      alertRuleId: item.rules.alertRuleId ?? null,
      entryId: posted?.entryId ?? null,
      createdBy: item.causedBy,
    });
    const rows = item.lines.filter((l) => l.baseMinor !== 0 || l.taxMinor !== 0);
    if (rows.length > 0)
      await tx.insert(schema.rentTaxItemLine).values(
        rows.map((l) => ({
          companyId: state.company.id,
          itemId: id,
          propertyId: state.lease.propertyId,
          tenantId: state.lease.tenantId,
          leaseId: state.lease.id,
          chargePeriodId: l.chargePeriodId,
          invoiceLineId: l.invoiceLineId,
          baseMinor: l.baseMinor,
          taxMinor: l.taxMinor,
        })),
      );
    return id;
  }
}

const ruleIds = (rules: RentTaxRuleSet) => ({
  rateRuleId: rules.rate.ruleId,
  baseRuleId: rules.base.ruleId,
  roundingRuleId: rules.rounding.ruleId,
  serviceChargeRuleId: rules.serviceCharge.ruleId,
  dueRuleId: rules.due.ruleId,
  alertRuleId: rules.alert.ruleId,
});
