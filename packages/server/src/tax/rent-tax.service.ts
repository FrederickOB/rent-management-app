import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, schema, sql, type Tx } from '@rent/db';
import { lineBalance } from '@rent/domain/billing';
import { parseBusinessDate } from '@rent/domain/dates';
import { rentTaxLines, rentTaxReversalLines, type PaymentAmount } from '@rent/domain/ledger';
import {
  receiptTax,
  receiptTaxBase,
  rentTaxDueDate,
  taxedPerReceipt,
  taxPeriodsFromWalk,
  type TaxItemKind,
  type TaxPeriod,
} from '@rent/domain/tax';
import type { AlertPort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { BillingEngine, type LeaseState, type TaxHooks } from '../billing/engine';
import { dimsOf, requireBook, type PaymentRecord } from '../billing/records';
import { ownerFacts } from '../companies/owners.service';
import { ALERT_PORT } from '../core/tokens';
import { PostingService } from '../ledger/posting.service';
import { RulesService, type ResolvedRule } from '../rules/rules.service';
import { netItemLines, taxedByPeriod, uuids } from './tax-records';

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
    const get = (key: string) => this.rules.resolveIn(tx, country, key, at);
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
   * The rules for a lease's receipt, or null when its owner is not taxed per receipt (a letting
   * business, decision 2) or the lease has no owner book. A base or rounding this build does not
   * implement raises an alert and taxes nothing: a person must look, nothing is guessed.
   */
  async receiptRules(tx: Tx, state: LeaseState, date: string): Promise<RentTaxRuleSet | null> {
    if (state.book.kind !== 'book') return null;
    const owner = (await ownerFacts(tx, [state.book.ownerId])).get(state.book.ownerId);
    if (!owner || !taxedPerReceipt(owner)) return null;
    const rules = await this.rulesAt(tx, state.company.countryCode, state.lease.use, date);
    if (rules.base.value !== SUPPORTED_BASE || rules.rounding.value !== SUPPORTED_ROUNDING) {
      await this.alerts
        ?.raise({
          severity: 'critical',
          code: 'tax.rule_unsupported',
          message:
            'A rent tax rule in force is not one this build can apply; no rent tax was assessed',
          context: { companyId: state.company.id, leaseId: state.lease.id, date },
        })
        .catch(() => undefined);
      return null;
    }
    return rules;
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
    return taxPeriodsFromWalk({
      walk: this.engine.walk(state),
      periodKeyOf: (key) => keyOf.get(key) ?? key,
      taxed: await taxedByPeriod(tx, state.lease.id),
      withheld,
    });
  }

  private lineOfPeriod(state: LeaseState): (periodId: string) => string | null {
    const lines = new Map(
      state.lines.flatMap((l) => (l.chargePeriodId ? [[l.chargePeriodId, l.id] as const] : [])),
    );
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
    const rules = await this.receiptRules(tx, state, valueDate);
    if (!rules) return;
    const cap = this.receiptCap(state, payment, rules.includesServiceCharge);
    const periods = await this.periods(tx, state);
    const { baseMinor, pins } = receiptTaxBase(periods, rules, cap);
    if (baseMinor <= 0) return;
    const tax = receiptTax(pins, periods, rules.rateBps);
    const [number] = await tx
      .select({ number: schema.receipt.number })
      .from(schema.receipt)
      .where(eq(schema.receipt.id, receipt.receiptId));
    const lineOf = this.lineOfPeriod(state);
    await this.writeItem(tx, state, {
      kind: 'receipt',
      rule: 'P17',
      key: `P17:${payment.id}`,
      paymentId: payment.id,
      valueDate,
      dueDate: rentTaxDueDate(valueDate, rules.dueDays),
      rateBps: rules.rateBps,
      lines: tax.lines.map((l) => ({
        chargePeriodId: l.key,
        invoiceLineId: lineOf(l.key),
        baseMinor: l.baseMinor,
        taxMinor: l.taxMinor,
      })),
      receiptNumber: number?.number ?? null,
      rules: ruleIds(rules),
      causedBy: receipt.causedBy,
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
    },
  ): Promise<void> {
    const rules = await this.receiptRules(tx, to, carried.valueDate);
    if (!rules) return;
    const cap = carried.credits.reduce((s, c) => s + c.amountMinor, 0);
    const periods = await this.periods(tx, to);
    const { baseMinor, pins } = receiptTaxBase(periods, rules, cap);
    if (baseMinor <= 0) return;
    const tax = receiptTax(pins, periods, rules.rateBps);
    const lineOf = this.lineOfPeriod(to);
    await this.writeItem(tx, to, {
      kind: 'carry_over',
      rule: 'P17',
      key: `P17:${carried.key}`,
      paymentId: carried.credits.length === 1 ? carried.credits[0]!.paymentId : null,
      valueDate: carried.valueDate,
      dueDate: rentTaxDueDate(carried.valueDate, rules.dueDays),
      rateBps: rules.rateBps,
      lines: tax.lines.map((l) => ({
        chargePeriodId: l.key,
        invoiceLineId: lineOf(l.key),
        baseMinor: l.baseMinor,
        taxMinor: l.taxMinor,
      })),
      rules: ruleIds(rules),
      causedBy: null,
    });
  }

  /**
   * Withholding (P19; plan 5.2): the tax on the lines it was withheld on becomes the amount
   * withheld. Rent tax already accrued on their cash is reversed, item by item (P21), and the
   * withheld amount is accrued as its own item (P17), "withheld by the tenant", so TX-02 raises no
   * alert for it. An owner in the letting business gets neither (decision 2).
   */
  async onWithholding(
    tx: Tx,
    state: LeaseState,
    withholding: {
      readonly id: string;
      readonly paymentId: string | null;
      readonly valueDate: string;
      readonly lines: readonly { readonly lineId: string; readonly amountMinor: number }[];
      readonly rateBps: number;
      readonly rateRuleId: string;
      readonly causedBy: string | null;
    },
  ): Promise<void> {
    const rules = await this.receiptRules(tx, state, withholding.valueDate);
    if (!rules) return;
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
    for (const item of items.rows) {
      const net = (await netItemLines(tx, item.id)).filter(
        (l) => periods.has(l.chargePeriodId) && (l.baseMinor !== 0 || l.taxMinor !== 0),
      );
      if (net.length === 0) continue;
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
  }

  /**
   * Writes an item, its lines and its entry (P17 for tax accrued, P21 for tax taken back) in the
   * caller's transaction. A key posted before means the item exists: nothing new is written.
   */
  private async writeItem(tx: Tx, state: LeaseState, item: NewItem): Promise<string | null> {
    const book = requireBook(state.book);
    const id = uuidv7();
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
