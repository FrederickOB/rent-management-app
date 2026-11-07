import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, sql, type Tx } from '@rent/db';
import { templates, type InvoiceDocumentData, type ReceiptDocumentData } from '@rent/documents';
import {
  applyCreditToOpenLines,
  creditPools,
  cyclesForAdvance,
  expectedTaxMinor,
  cyclesToIssue,
  depositDue,
  draftTotal,
  drawFromPools,
  forwardWalk,
  inAccrualOrder,
  invoiceCycles,
  invoiceLinesFor,
  isRecurring,
  isTax,
  LINE_KIND_LABELS,
  lineBalance,
  linesToAccrue,
  advancePaymentCapMinor,
  monthsPaidAhead,
  paymentCredit,
  paymentShares,
  planAccrual,
  planAllocation,
  planCreditNote,
  planTaxDraws,
  planPaymentReversal,
  planWithholding,
  planReopenedDraws,
  planWriteOff,
  referenceFrom,
  refundCredits,
  REFERENCE_PAYLOAD_LENGTH,
  walkLines,
  type AllocationSource,
  type InvoiceCycle,
  type InvoiceLineDraft,
  type LateDraw,
  type ScheduledPeriod,
  type ScheduleRow,
  type VatRates,
  type WalkResult,
  withheldOn,
  withholdingDrawsFor,
} from '@rent/domain/billing';
import { parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { format, money } from '@rent/domain/money';
import { verificationWarning } from '@rent/domain/rules';
import {
  accrualLines,
  carryOverLines,
  compactLines,
  creditApplicationLines,
  creditDrawLines,
  creditNoteLines,
  depositApplicationLines,
  depositRefundApprovedLines,
  depositUnwindLines,
  lateDrawLines,
  oneOffChargeLines,
  paymentReversalLines,
  receiptLines,
  refundApprovedLines,
  refundPaidLines,
  unmatchedArrivalLines,
  unmatchedMatchLines,
  vatChargeLines,
  withholdingDrawLines,
  withholdingLines,
  writeOffLines,
  type CashAccount,
  type CashSide,
  type JournalLineDraft,
  type PaymentAmount,
  type PostingRule,
} from '@rent/domain/ledger';
import { billingSettingsOf, parseCompanySettings } from '@rent/domain/settings';
import { v7 as uuidv7 } from 'uuid';
import { companyRecord, type CompanyRecord } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { Clock } from '../core/clock';
import { AppError, conflict, invalid } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { personContact } from '../identity/person-directory';
import { balance } from '../ledger/ledger.queries';
import { PostingService, type PostedEntry } from '../ledger/posting.service';
import { RulesService, type ResolvedRule } from '../rules/rules.service';
import {
  billingLeaseOf,
  renewedLeaseOf,
  scheduleRowsOf,
  startedRenewalOf,
  type BillingLease,
} from '../tenancy/billing-facts';
import {
  allocationRecord,
  dimsOf,
  formatInvoiceNumber,
  formatReceiptNumber,
  isoNow,
  leaseBookOf,
  loadAllocations,
  loadLines,
  lockCollectorCash,
  nextNumber,
  paymentOrder,
  paymentsByIds,
  poolPayments,
  requireBook,
  type AllocationRecord,
  type LeaseBook,
  type LineRecord,
  type PaymentRecord,
} from './records';

export const INVOICE_TEMPLATE = { key: 'billing.invoice', version: 1 } as const;
export const RECEIPT_TEMPLATE = { key: 'billing.receipt', version: 1 } as const;
/** Emitted when a payment is posted; M4b's payments module sends the receipt from it (BC-06). */
export const PAYMENT_POSTED_EVENT = 'payment.posted';

/** A lease's money, loaded in one transaction under its billing lock. Mutated as it is written. */
export interface LeaseState {
  readonly company: CompanyRecord;
  readonly lease: BillingLease;
  readonly book: LeaseBook;
  readonly schedule: readonly ScheduleRow[];
  lines: LineRecord[];
  allocations: AllocationRecord[];
  /** Live payments whose credit sits on this lease, first in, first out. */
  payments: PaymentRecord[];
  /** VAT and levy rates for lines not invoiced yet (CT-04), or null: the walk expects them. */
  vatRates: VatRates | null;
}

export interface VatSetting {
  readonly rates: VatRates;
  readonly rateRule: ResolvedRule;
  readonly serviceRule: ResolvedRule;
}

/**
 * What the tax module (layer 6) does in the posting transaction of a receipt, a payment reversal
 * and a carry-over (M5 plan 5.1; TX-01, P17, P21): billing sits below tax and never imports it
 * (architecture section 2), so tax registers these when it starts. Each runs after the event's
 * own postings, on the lease state as they left it.
 */
export interface TaxHooks {
  afterReceipt(
    tx: Tx,
    state: LeaseState,
    receipt: {
      readonly payment: PaymentRecord;
      readonly receiptId: string;
      readonly causedBy: string | null;
    },
  ): Promise<void>;
  afterReversal(
    tx: Tx,
    states: readonly LeaseState[],
    payment: PaymentRecord,
    reversal: {
      readonly reversalId: string;
      readonly valueDate: string;
      readonly causedBy: string | null;
    },
  ): Promise<void>;
  /** Credit carried to a renewal (P29): applied to its rent, it is taxed now (plan 5.1). */
  afterCarryOver(
    tx: Tx,
    to: LeaseState,
    carried: {
      readonly key: string;
      readonly valueDate: string;
      readonly credits: readonly PaymentAmount[];
      /** The lease the credit came from (M5 review N2: what it was taxed on there). */
      readonly fromLeaseId?: string;
    },
  ): Promise<void>;
}

/**
 * M9 (P14; M9 review, must-fix 1): the management fee follows the allocations. Every write of
 * allocations is handed to the fee hook in its own transaction, after it is written: a rent or
 * service-charge allocation of money carries its fee, and a negative allocation takes back the
 * fee of what it undoes. Billing sits below reporting and never imports it, so reporting registers
 * the hook when it starts.
 */
export interface AllocationWrite {
  readonly valueDate: string;
  readonly recordType: string;
  readonly recordId: string;
  readonly entryId: string | null;
  readonly causedBy: string | null;
}

export interface FeeHooks {
  afterAllocations(
    tx: Tx,
    state: LeaseState,
    rows: readonly (typeof schema.allocation.$inferSelect)[],
    write: AllocationWrite,
  ): Promise<void>;
}

/** The advance rule for a term (AR-05; Act 220 s.25(5), unverified; OQ-51 for 2 to 6 months). */
export function advanceRuleKeyFor(periodCount: number): string | null {
  return periodCount <= 1
    ? 'advance_rent.max_months.monthly_or_shorter'
    : periodCount > 6
      ? 'advance_rent.max_months.over_six_months'
      : null;
}

/** Money coming in for a lease (P03, P06, P28): where it sits and where it came from. */
export interface MoneyIn {
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly method: 'cash' | 'cheque' | 'bank_transfer' | 'momo' | 'card' | 'test';
  readonly rule: Extract<PostingRule, 'P03' | 'P06' | 'P28'>;
  readonly cashAccount: CashAccount;
  readonly collectorPersonId?: string | null;
  readonly provider?: string | null;
  readonly sourceType:
    'cash_record' | 'direct_receipt' | 'provider_test' | 'payment_intent' | 'provider_charge';
  readonly sourceId: string;
  /** M4b: a provider payment's reference with the provider, for reconciliation. */
  readonly providerReference?: string | null;
  /** M4b: the settlement account the money settles to (ADR-008). */
  readonly settlementAccountId?: string | null;
  /** M4b: the paying MoMo number as a keyed hash and masked; never in the clear. */
  readonly payerPhoneIndex?: string | null;
  readonly payerPhoneMasked?: string | null;
  readonly payerName?: string | null;
  readonly senderReference?: string | null;
  readonly chequeNumber?: string | null;
  readonly chequeBank?: string | null;
  readonly note?: string | null;
  readonly proofDocumentId?: string | null;
  readonly recordedBy?: string | null;
  readonly causedBy?: string | null;
}

const METHOD_LABELS: Record<MoneyIn['method'], string> = {
  cash: 'Cash',
  cheque: 'Cheque',
  bank_transfer: 'Bank transfer',
  momo: 'Mobile money',
  card: 'Card',
  test: 'Test payment',
};

export const lineLabel = (line: Pick<LineRecord, 'kind'>) => LINE_KIND_LABELS[line.kind];

/** The last day a lease is billed for: its move-out or end, else open (held over month by month). */
export function lastBillableDay(lease: BillingLease): string | null {
  return lease.moveOutDate ?? lease.endedOn ?? null;
}

/**
 * The billing engine (M4a plan 4.4 to 4.11): each operation runs the domain's planning and posting
 * functions in the order of the reference model (packages/domain/src/billing/testing/
 * lease-ledger.ts) and writes the result in the caller's transaction, which holds the lease's
 * billing lock. Invoice lines, accruals, allocations, payments and receipts are written here and
 * nowhere else; journal rows go through the posting service.
 */
@Injectable()
export class BillingEngine {
  private taxHooks: TaxHooks | null = null;
  private feeHooks: FeeHooks | null = null;

  constructor(
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  today(state: { readonly company: CompanyRecord }): string {
    return isoNow(this.clock, state.company.timeZone);
  }

  /** The tax module registers its hooks once (M5); without them no rent tax is assessed. */
  useTaxHooks(hooks: TaxHooks): void {
    this.taxHooks = hooks;
  }

  get taxHooksRegistered(): boolean {
    return this.taxHooks !== null;
  }

  /** The reporting module registers its fee hook once (M9); without it no fee is charged. */
  useFeeHooks(hooks: FeeHooks): void {
    this.feeHooks = hooks;
  }

  // Loading -------------------------------------------------------------------------------------

  async load(tx: Tx, companyId: string, leaseId: string): Promise<LeaseState> {
    const company = await companyRecord(tx, companyId);
    if (!company) throw new Error('Company not found');
    const lease = await billingLeaseOf(tx, leaseId);
    const [lines, payments, schedule] = [
      await loadLines(tx, [leaseId]),
      await poolPayments(tx, leaseId),
      await scheduleRowsOf(tx, leaseId),
    ];
    const allocations = await loadAllocations(tx, {
      leaseIds: [leaseId],
      paymentIds: payments.map((p) => p.id),
    });
    const book = await leaseBookOf(tx, lease, isoNow(this.clock, company.timeZone));
    const state: LeaseState = {
      company,
      lease,
      book,
      schedule,
      lines,
      allocations,
      payments,
      vatRates: null,
    };
    state.vatRates =
      (await this.vatFor(tx, state, isoNow(this.clock, company.timeZone)))?.rates ?? null;
    return state;
  }

  // Invoices (BC-01; plan 4.4) -------------------------------------------------------------------

  /** The lease's invoice cycles from its billing start, with the company's lead days. */
  cycles(state: LeaseState): InvoiceCycle[] {
    const lease = state.lease;
    if (!lease.billingStartDate) return [];
    return invoiceCycles({
      cycle: lease.cycle,
      initialAdvanceMonths: lease.initialAdvanceMonths,
      schedule: state.schedule,
      billingStartDate: lease.billingStartDate,
      lastBillableDay: lastBillableDay(lease),
      leadDays: billingSettingsOf(parseCompanySettings(state.company.settings)).invoiceLeadDays,
    });
  }

  issuedCycleStarts(tx: Tx, leaseId: string): Promise<Set<string>> {
    return tx
      .select({ cycleStart: schema.invoice.cycleStart })
      .from(schema.invoice)
      .where(and(eq(schema.invoice.leaseId, leaseId), eq(schema.invoice.kind, 'cycle')))
      .then((rows) => new Set(rows.flatMap((r) => (r.cycleStart ? [r.cycleStart] : []))));
  }

  /**
   * VAT and levies for a commercial lease whose owner is VAT-registered (CT-04, P32), with the
   * rules in force on the date; null for every other lease (dwellings are exempt).
   */
  async vatFor(tx: Tx, state: LeaseState, date: string): Promise<VatSetting | null> {
    if (state.lease.use !== 'commercial' || state.book.kind !== 'book') return null;
    const owner = (await ownerFacts(tx, [state.book.ownerId])).get(state.book.ownerId);
    if (!owner?.vatRegistered) return null;
    const asOf = parseBusinessDate(date);
    const rateRule = await this.rules.resolveIn(
      tx,
      state.company.countryCode,
      'vat.commercial_rent',
      asOf,
    );
    const serviceRule = await this.rules.resolveIn(
      tx,
      state.company.countryCode,
      'vat.applies_to_service_charge',
      asOf,
    );
    const value = rateRule.value as { vatBps: number; nhilBps: number; getfundBps: number };
    return {
      rates: {
        vatBps: value.vatBps,
        nhilBps: value.nhilBps,
        getfundBps: value.getfundBps,
        appliesToServiceCharge: serviceRule.value === true,
      },
      rateRule,
      serviceRule,
    };
  }

  /** Issues the cycles due by `today` that have no invoice yet. A rerun issues nothing new. */
  async generate(tx: Tx, state: LeaseState, today: string, causedBy?: string | null) {
    if (state.book.kind !== 'book') return [];
    const due = cyclesToIssue(
      this.cycles(state),
      today,
      await this.issuedCycleStarts(tx, state.lease.id),
    );
    const issued = [];
    for (const cycle of due) issued.push(await this.issueCycle(tx, state, cycle, today, causedBy));
    return issued;
  }

  async issueCycle(
    tx: Tx,
    state: LeaseState,
    cycle: InvoiceCycle,
    today: string,
    causedBy?: string | null,
    /** The tax point when a payment made it issue (decision 4): that payment's value date. */
    taxPoint?: string,
  ) {
    // VAT as of the tax point: an advance recorded late is taxed at its own day's rate (review).
    const vat = await this.vatFor(tx, state, taxPoint ?? today);
    return this.issue(tx, state, {
      taxPoint,
      kind: 'cycle',
      drafts: invoiceLinesFor(cycle, vat?.rates ?? null),
      dueDate: cycle.dueDate,
      issueDate: today,
      periodFrom: cycle.periodFrom,
      periodTo: cycle.periodTo,
      cycleStart: cycle.cycleStart,
      holdingOver: cycle.holdingOver,
      vat,
      causedBy,
    });
  }

  /**
   * The deposit invoice at signing (decision 2), due on the start date, for what the carried
   * deposit of a renewal does not cover; none for a paper lease billed from a later date.
   */
  async issueDeposit(tx: Tx, state: LeaseState, carriedDepositMinor: number, today: string) {
    const amount = depositDue({
      depositMinor: state.lease.depositMinor,
      startDate: state.lease.startDate,
      billingStartDate: state.lease.billingStartDate ?? state.lease.startDate,
      carriedDepositMinor,
    });
    if (amount <= 0 || state.book.kind !== 'book') return null;
    if (state.lines.some((l) => l.invoiceKind === 'deposit')) return null;
    return this.issue(tx, state, {
      kind: 'deposit',
      drafts: [
        {
          kind: 'deposit',
          chargePeriodId: null,
          periodStart: null,
          periodEnd: null,
          amountMinor: amount,
          rateBps: null,
          baseIndex: null,
        },
      ],
      dueDate: state.lease.startDate,
      issueDate: today,
      periodFrom: null,
      periodTo: null,
      cycleStart: null,
      holdingOver: false,
      vat: null,
    });
  }

  /** Issues an invoice: its lines, P01 for one-off lines and P32 for VAT lines, and its PDF. */
  private async issue(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly kind: 'cycle' | 'deposit' | 'one_off';
      readonly drafts: readonly InvoiceLineDraft[];
      readonly dueDate: string;
      readonly issueDate: string;
      readonly periodFrom: string | null;
      readonly periodTo: string | null;
      readonly cycleStart: string | null;
      readonly holdingOver: boolean;
      readonly vat: VatSetting | null;
      readonly causedBy?: string | null;
      /** When its one-off and tax lines are charged (P01, P32); the issue date by default. */
      readonly taxPoint?: string;
      /** What the PDF calls each line (agreed termination charges, M5); the kind's label by default. */
      readonly labels?: readonly string[];
    },
  ) {
    const { company, lease } = state;
    const taxPoint = input.taxPoint ?? input.issueDate;
    const book = requireBook(state.book);
    if (input.drafts.length === 0) throw new Error('An invoice needs a line');
    const owner = (await ownerFacts(tx, [book.ownerId])).get(book.ownerId);
    if (!owner) throw new Error('The owner of this lease is not visible');
    const reference = await this.ensureReference(tx, lease);
    const number = await nextNumber(tx, company.id, 'invoice');
    const invoiceId = uuidv7();
    const ids = input.drafts.map(() => uuidv7());
    const rows = input.drafts.map((d, i) => ({
      id: ids[i]!,
      companyId: company.id,
      invoiceId,
      propertyId: lease.propertyId,
      tenantId: lease.tenantId,
      leaseId: lease.id,
      position: i + 1,
      kind: d.kind,
      baseLineId: d.baseIndex === null ? null : ids[d.baseIndex]!,
      chargePeriodId: d.chargePeriodId,
      periodStart: d.periodStart,
      periodEnd: d.periodEnd,
      dueDate: input.dueDate,
      amountMinor: d.amountMinor,
      rateBps: d.rateBps,
      ruleId: isTax(d.kind) ? (input.vat?.rateRule.ruleId ?? null) : null,
    }));
    const vatTotal = rows.filter((r) => isTax(r.kind)).reduce((s, r) => s + r.amountMinor, 0);
    const data: InvoiceDocumentData = {
      number: formatInvoiceNumber(number),
      kind: input.kind,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      paymentReference: reference,
      billedTo: { name: lease.tenantName, tin: lease.tenantTinMasked },
      billedFrom: { name: owner.name, tin: owner.tinMasked },
      unit: { code: lease.unitCode, propertyName: lease.propertyName },
      lines: rows.map((r, i) => ({
        label: input.labels?.[i] ?? LINE_KIND_LABELS[r.kind],
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        rateBps: r.rateBps,
        amountMinor: r.amountMinor,
        isTax: isTax(r.kind),
      })),
      totalMinor: draftTotal(input.drafts),
      vatTotalMinor: input.vat && vatTotal > 0 ? vatTotal : null,
      notes: [],
    };
    templates.get(INVOICE_TEMPLATE.key, INVOICE_TEMPLATE.version).schema.parse(data);
    const renderRequestId = await this.documents.requestRender(tx, {
      companyId: company.id,
      templateKey: INVOICE_TEMPLATE.key,
      templateVersion: INVOICE_TEMPLATE.version,
      data,
      requestedBy: input.causedBy ?? null,
    });
    await tx.insert(schema.invoice).values({
      id: invoiceId,
      companyId: company.id,
      number,
      kind: input.kind,
      propertyId: lease.propertyId,
      tenantId: lease.tenantId,
      leaseId: lease.id,
      unitId: lease.unitId,
      ownerId: book.ownerId,
      bookId: book.bookId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      cycleStart: input.cycleStart,
      holdingOver: input.holdingOver,
      paymentReference: reference,
      unitCode: lease.unitCode,
      propertyName: lease.propertyName,
      billedToName: lease.tenantName,
      billedToTin: lease.tenantTinMasked,
      billedFromName: owner.name,
      billedFromTin: owner.tinMasked,
      vatRuleId: input.vat && vatTotal > 0 ? input.vat.rateRule.ruleId : null,
      vatServiceRuleId: input.vat && vatTotal > 0 ? input.vat.serviceRule.ruleId : null,
      renderRequestId,
      createdBy: input.causedBy ?? null,
    });
    await tx.insert(schema.invoiceLine).values(rows);
    const base = state.lines.length;
    const added: LineRecord[] = rows.map((r, i) => ({
      id: r.id,
      kind: r.kind,
      baseLineId: r.baseLineId,
      rateBps: r.rateBps,
      dueDate: r.dueDate,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      amountMinor: r.amountMinor,
      accrued: false,
      sequence: base + i + 1,
      invoiceId,
      invoiceNumber: number,
      invoiceKind: input.kind,
      issueDate: input.issueDate,
      leaseId: lease.id,
      propertyId: lease.propertyId,
      tenantId: lease.tenantId,
      ownerId: book.ownerId,
      bookId: book.bookId,
      chargePeriodId: r.chargePeriodId,
      ruleId: r.ruleId,
      accruedOn: null,
      accruedAccounting: null,
      chargedOn: isRecurring(r.kind) || r.kind === 'deposit' ? null : taxPoint,
    }));
    state.lines.push(...added);
    const dims = dimsOf(lease);
    const oneOff = added.filter((l) => l.kind === 'one_off');
    await this.posting.post(tx, {
      companyId: company.id,
      rule: 'P01',
      key: `P01:${invoiceId}`,
      valueDate: taxPoint,
      lines: oneOffChargeLines({
        bookId: book.bookId,
        lease: dims,
        lines: oneOff.map((l) => ({ invoiceLineId: l.id, amountMinor: l.amountMinor })),
      }),
      record: { type: 'invoice', id: invoiceId },
      causedBy: input.causedBy ?? null,
    });
    const taxes = added.filter((l) => isTax(l.kind));
    await this.posting.post(tx, {
      companyId: company.id,
      rule: 'P32',
      key: `P32:${invoiceId}`,
      valueDate: taxPoint,
      lines: vatChargeLines({
        bookId: book.bookId,
        lease: dims,
        lines: taxes.map((l) => ({ invoiceLineId: l.id, amountMinor: l.amountMinor })),
      }),
      record: { type: 'invoice', id: invoiceId },
      causedBy: input.causedBy ?? null,
    });
    return { invoiceId, number, lines: added };
  }

  /**
   * The lease's payment reference (BC-03; decision 8): drawn with server randomness the first
   * time it is needed (at signing), unique across the platform, never changed.
   */
  async ensureReference(
    tx: Tx,
    lease: Pick<BillingLease, 'id' | 'companyId' | 'propertyId' | 'tenantId'>,
  ): Promise<string> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const [existing] = await tx
        .select({ reference: schema.paymentReference.reference })
        .from(schema.paymentReference)
        .where(eq(schema.paymentReference.leaseId, lease.id));
      if (existing) return existing.reference;
      const reference = referenceFrom(
        Array.from({ length: REFERENCE_PAYLOAD_LENGTH }, () => randomInt(0, 32)),
      );
      if (!reference) continue;
      const inserted = await tx
        .insert(schema.paymentReference)
        .values({
          companyId: lease.companyId,
          propertyId: lease.propertyId,
          tenantId: lease.tenantId,
          leaseId: lease.id,
          reference,
        })
        .onConflictDoNothing()
        .returning({ reference: schema.paymentReference.reference });
      if (inserted[0]) return inserted[0].reference;
    }
    throw new Error('Could not draw a free payment reference');
  }

  // Accrual (AR-01; plan 4.6) ---------------------------------------------------------------------

  /**
   * P02 for every started line not yet accrued, in accrual order: each draws its own advance
   * allocations, then the lease's credit first in, first out (each draw is a new allocation), and
   * the rest is owed. A line credited to nothing is recorded as accrued with nothing posted.
   */
  async accrue(tx: Tx, state: LeaseState, date: string): Promise<number> {
    // Never a period after the lease's known last day: it is cancelled, not earned (review 1).
    const last = lastBillableDay(state.lease);
    const due = linesToAccrue(state.lines, date).filter(
      (l) => last === null || (l.periodStart as string) <= last,
    );
    if (due.length === 0) return 0;
    const book = requireBook(state.book);
    const dims = dimsOf(state.lease);
    let pools = creditPools(state.payments, state.allocations);
    for (const line of due) {
      const record = line as LineRecord;
      const plan = planAccrual(record, state.allocations, pools);
      const valueDate = record.periodStart!;
      let posted: PostedEntry | null = null;
      if (plan.amountMinor > 0)
        posted = await this.posting.post(tx, {
          companyId: state.company.id,
          rule: 'P02',
          key: `P02:${record.id}`,
          valueDate,
          lines: accrualLines({
            bookId: book.bookId,
            lease: dims,
            invoiceLineId: record.id,
            chargeType: record.kind as 'rent' | 'service_charge',
            amountMinor: plan.amountMinor,
            advance: plan.advance,
            draws: plan.draws,
          }),
          record: { type: 'invoice_line', id: record.id },
        });
      const accountingDate =
        posted?.accountingDate ?? (await this.posting.accountingDate(tx, [book.bookId], valueDate));
      await this.writeAllocations(
        tx,
        state,
        plan.draws.map((d) => ({
          lineId: record.id,
          source: 'payment' as const,
          paymentId: d.paymentId,
          amountMinor: d.amountMinor,
        })),
        {
          valueDate,
          accountingDate,
          recordType: 'accrual',
          recordId: record.id,
          entryId: posted?.entryId ?? null,
        },
      );
      await tx.insert(schema.invoiceLineAccrual).values({
        companyId: state.company.id,
        propertyId: state.lease.propertyId,
        tenantId: state.lease.tenantId,
        leaseId: state.lease.id,
        invoiceLineId: record.id,
        amountMinor: plan.amountMinor,
        valueDate,
        accountingDate,
        entryId: posted?.entryId ?? null,
      });
      // Decision 8: tax withheld on the month while it had not started pays it now, each
      // withholding on its own key (Dr 2010, Cr 1100).
      for (const { withholdingId, amountMinor: amount } of withholdingDrawsFor(
        record.id,
        state.allocations,
      ))
        await this.posting.post(tx, {
          companyId: state.company.id,
          rule: 'P02',
          key: `P02:${record.id}:withholding:${withholdingId}`,
          valueDate,
          lines: withholdingDrawLines({
            bookId: book.bookId,
            lease: dims,
            invoiceLineId: record.id,
            amountMinor: amount,
          }),
          record: { type: 'invoice_line', id: record.id },
        });
      pools = drawFromPools(pools, plan.draws);
      // Its VAT and levies, from the credit left (review 10).
      for (const tax of planTaxDraws(
        state.lines.filter((l) => l.baseLineId === record.id),
        state.allocations,
        pools,
      )) {
        const drawn = await this.posting.post(tx, {
          companyId: state.company.id,
          rule: 'P02',
          key: `P02:${tax.lineId}`,
          valueDate,
          lines: creditDrawLines({
            bookId: book.bookId,
            lease: dims,
            invoiceLineId: tax.lineId,
            draws: tax.draws,
          }),
          record: { type: 'invoice_line', id: tax.lineId },
        });
        await this.writeAllocations(
          tx,
          state,
          tax.draws.map((d) => ({
            lineId: tax.lineId,
            source: 'payment' as const,
            paymentId: d.paymentId,
            amountMinor: d.amountMinor,
          })),
          {
            valueDate,
            accountingDate:
              drawn?.accountingDate ??
              (await this.posting.accountingDate(tx, [book.bookId], valueDate)),
            recordType: 'accrual',
            recordId: tax.lineId,
            entryId: drawn?.entryId ?? null,
          },
        );
        pools = drawFromPools(pools, tax.draws);
      }
      const index = state.lines.findIndex((l) => l.id === record.id);
      state.lines[index] = {
        ...record,
        accrued: true,
        accruedOn: valueDate,
        accruedAccounting: accountingDate,
      };
    }
    return due.length;
  }

  private async writeAllocations(
    tx: Tx,
    state: LeaseState,
    rows: readonly {
      readonly lineId: string;
      readonly source: AllocationSource;
      readonly paymentId: string | null;
      readonly amountMinor: number;
    }[],
    meta: {
      readonly valueDate: string;
      readonly accountingDate: string;
      readonly recordType:
        | 'payment'
        | 'match'
        | 'accrual'
        | 'reversal'
        | 'credit_note'
        | 'write_off'
        | 'withholding'
        | 'termination'
        | 'move_out';
      readonly recordId: string;
      readonly entryId: string | null;
    },
    leaseOf: (lineId: string) => Pick<BillingLease, 'id' | 'propertyId' | 'tenantId'> = () =>
      state.lease,
  ): Promise<void> {
    const values = rows
      .filter((r) => r.amountMinor !== 0)
      .map((r) => {
        const lease = leaseOf(r.lineId);
        return {
          companyId: state.company.id,
          propertyId: lease.propertyId,
          tenantId: lease.tenantId,
          leaseId: lease.id,
          invoiceLineId: r.lineId,
          source: r.source,
          paymentId: r.paymentId,
          amountMinor: r.amountMinor,
          ...meta,
        };
      });
    if (values.length === 0) return;
    const inserted = await tx.insert(schema.allocation).values(values).returning();
    state.allocations.push(...inserted.map(allocationRecord));
    // P14: each allocation of money carries its fee; a negative one takes back what it undoes.
    await this.feeHooks?.afterAllocations(tx, state, inserted, {
      valueDate: meta.valueDate,
      recordType: meta.recordType,
      recordId: meta.recordId,
      entryId: meta.entryId,
      causedBy: null,
    });
  }

  /**
   * The late draws of an allocation (P03 by value date): a period that had not started when the
   * money arrived, but has accrued since, is paid out of the advance at once, dated at its start.
   */
  private async postLateDraws(
    tx: Tx,
    state: LeaseState,
    draws: readonly LateDraw[],
    causedBy: string | null,
  ): Promise<void> {
    const book = requireBook(state.book);
    for (const draw of draws)
      await this.posting.post(tx, {
        companyId: state.company.id,
        rule: 'P02',
        key: `P02:${draw.lineId}:${draw.paymentId}`,
        valueDate: draw.valueDate,
        lines: lateDrawLines({
          bookId: book.bookId,
          lease: dimsOf(state.lease),
          invoiceLineId: draw.lineId,
          paymentId: draw.paymentId,
          amountMinor: draw.amountMinor,
        }),
        record: { type: 'invoice_line', id: draw.lineId },
        causedBy,
      });
  }

  // Money in (BC-07; plan 4.5) --------------------------------------------------------------------

  /**
   * Decision 4: for a VAT-registered owner's commercial lease, a payment that reaches beyond the
   * invoices already issued first issues the invoices it pays for, up to the lease end, so the
   * payment is their tax point.
   */
  async issueForAdvance(
    tx: Tx,
    state: LeaseState,
    amountMinor: number,
    today: string,
    /** The payment's value date: the tax point of what it makes issue (decision 4). */
    valueDate: string = today,
  ) {
    const vat = await this.vatFor(tx, state, valueDate);
    if (!vat) return [];
    const issued = await this.issuedCycleStarts(tx, state.lease.id);
    const pending = this.cycles(state).filter((c) => !issued.has(c.cycleStart));
    const open = state.lines.reduce(
      (s, l) => s + lineBalance(l, state.allocations).outstandingMinor,
      0,
    );
    // The payment pays every open line before any new cycle, so it reaches beyond the issued
    // invoices only when it is larger than what is open. Credit is applied before the payment
    // (oldest money first) to the lines not charged yet and to the cycles after them, so the
    // payment's money reaches `payment − open + credit` into the new cycles (review D2).
    if (amountMinor <= open) return [];
    const credit = creditPools(state.payments, state.allocations).reduce(
      (s, p) => s + p.amountMinor,
      0,
    );
    const chosen = cyclesForAdvance({
      pending,
      openMinor: open - credit,
      paymentMinor: amountMinor,
      vat: vat.rates,
    });
    const out = [];
    for (const cycle of chosen)
      out.push(await this.issueCycle(tx, state, cycle, today, null, valueDate));
    return out;
  }

  /**
   * BC-07, oldest debt first: money can arrive before the worker has handled the lease's signing
   * (`lease.signed`), for example cash approved a moment after a paper lease is recorded. A lease
   * with no invoice yet gets what that job issues (the deposit and the cycles due) before the
   * money is allocated, so the money pays them instead of waiting as credit. Both steps are
   * idempotent, so the job, when it runs, finds them issued. Callers hold the lease and counter
   * locks, as for the receipt's number.
   */
  async issueAtSigningIfNone(tx: Tx, state: LeaseState, today: string): Promise<void> {
    if (state.book.kind !== 'book' || state.lines.length > 0) return;
    await this.issueDeposit(tx, state, await this.carriedDeposit(tx, state), today);
    await this.generate(tx, state, today);
  }

  /**
   * The deposit a renewal brings with it (M9 review #7): what its old lease still holds, plus what
   * P29 has already carried onto the renewal. P29 runs when the renewal starts, which may come
   * before billing handles its signing, so the old lease alone can read zero. None for a lease that
   * renews nothing.
   */
  async carriedDeposit(tx: Tx, state: LeaseState): Promise<number> {
    if (!state.lease.renewsLeaseId) return 0;
    return (
      (await this.depositHeld(tx, state.lease.renewsLeaseId)) +
      (await this.depositHeld(tx, state.lease.id))
    );
  }

  /**
   * The one way money is taken for a lease (plan 4.5): the lease is accrued first, the payment is
   * allocated oldest debt first, posted with its cash side, and its receipt numbered and queued,
   * all in the caller's transaction. A payment is made once per source record.
   */
  async receive(
    tx: Tx,
    state: LeaseState,
    input: MoneyIn,
  ): Promise<{ paymentId: string; receiptId: string }> {
    const [existing] = await tx
      .select({ id: schema.payment.id })
      .from(schema.payment)
      .where(
        and(
          eq(schema.payment.sourceType, input.sourceType),
          eq(schema.payment.sourceId, input.sourceId),
        ),
      );
    if (existing) {
      const [receipt] = await tx
        .select({ id: schema.receipt.id })
        .from(schema.receipt)
        .where(and(eq(schema.receipt.paymentId, existing.id), eq(schema.receipt.kind, 'receipt')));
      return { paymentId: existing.id, receiptId: receipt!.id };
    }
    if (
      !['signed', 'active', 'ending', 'holding_over', 'ended', 'terminated'].includes(
        state.lease.status,
      )
    )
      throw conflict('lease_not_billable', 'Money can be recorded only for a signed lease');
    const book = requireBook(state.book);
    const today = this.today(state);
    if (input.receivedOn > today)
      throw invalid('received_in_future', 'The day the money was received cannot be in the future');
    await this.carryOverIfStarted(tx, state, today);
    await this.issueAtSigningIfNone(tx, state, today);
    await this.issueForAdvance(tx, state, input.amountMinor, today, input.receivedOn);
    await this.accrue(tx, state, today);
    const paymentId = uuidv7();
    const plan = planAllocation({
      lines: state.lines,
      allocations: state.allocations,
      paymentId,
      amountMinor: input.amountMinor,
      lease: dimsOf(state.lease),
      valueDate: input.receivedOn,
      lastDay: lastBillableDay(state.lease),
    });
    const cash: CashSide = {
      bookId: book.bookId,
      account: input.cashAccount,
      collectorId: input.collectorPersonId ?? null,
      provider: input.provider ?? null,
      settlementAccountId: input.settlementAccountId ?? null,
    };
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: input.rule,
      key: `${input.rule}:${paymentId}`,
      valueDate: input.receivedOn,
      lines: receiptLines({
        cash,
        bookId: book.bookId,
        paymentId,
        lease: dimsOf(state.lease),
        allocations: plan.postings,
        surplusMinor: plan.surplusMinor,
      }),
      record: { type: 'payment', id: paymentId },
      causedBy: input.causedBy ?? null,
    });
    await tx.insert(schema.payment).values({
      id: paymentId,
      companyId: state.company.id,
      method: input.method,
      amountMinor: input.amountMinor,
      receivedOn: input.receivedOn,
      accountingDate: posted!.accountingDate,
      propertyId: state.lease.propertyId,
      unitId: state.lease.unitId,
      tenantId: state.lease.tenantId,
      leaseId: state.lease.id,
      ownerId: book.ownerId,
      bookId: book.bookId,
      cashAccount: input.cashAccount,
      collectorPersonId: input.collectorPersonId ?? null,
      provider: input.provider ?? null,
      payerName: input.payerName ?? null,
      senderReference: input.senderReference ?? null,
      chequeNumber: input.chequeNumber ?? null,
      chequeBank: input.chequeBank ?? null,
      note: input.note ?? null,
      proofDocumentId: input.proofDocumentId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      entryId: posted!.entryId,
      recordedBy: input.recordedBy ?? null,
      ...this.providerColumns(input),
    });
    const [record] = await paymentsByIds(tx, [paymentId]);
    state.payments.push(record!);
    state.payments.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    await this.writeAllocations(
      tx,
      state,
      plan.allocations.map((a) => ({ ...a, source: 'payment' as const })),
      {
        valueDate: input.receivedOn,
        accountingDate: posted!.accountingDate,
        recordType: 'payment',
        recordId: paymentId,
        entryId: posted!.entryId,
      },
    );
    await this.postLateDraws(tx, state, plan.lateDraws, input.causedBy ?? null);
    if (plan.surplusMinor > 0) await this.carryStranded(tx, state, record!, today);
    const receiptId = await this.issueReceipt(tx, state, {
      payment: record!,
      kind: 'receipt',
      allocations: plan.allocations.map((a) => ({ lineId: a.lineId, amountMinor: a.amountMinor })),
      creditMinor: plan.surplusMinor,
      reverses: null,
    });
    await this.afterReceipt(tx, state, record!, receiptId, input.causedBy ?? null);
    await enqueueOutbox(tx, {
      companyId: state.company.id,
      type: PAYMENT_POSTED_EVENT,
      payload: { paymentId, receiptId, leaseId: state.lease.id },
      idempotencyKey: `${PAYMENT_POSTED_EVENT}:${paymentId}`,
    });
    return { paymentId, receiptId };
  }

  /**
   * P23 on arrival: money whose lease nobody knows yet waits in suspense (2090) in the book of
   * whoever received it: the owner's book for the owner's account, the company book for the
   * agency's. No receipt until it is matched.
   */
  async receiveUnmatched(
    tx: Tx,
    input: Omit<MoneyIn, 'rule'> & {
      readonly companyId: string;
      readonly bookId: string;
      readonly ownerId: string | null;
    },
  ): Promise<string> {
    const [existing] = await tx
      .select({ id: schema.payment.id })
      .from(schema.payment)
      .where(
        and(
          eq(schema.payment.sourceType, input.sourceType),
          eq(schema.payment.sourceId, input.sourceId),
        ),
      );
    if (existing) return existing.id;
    const paymentId = uuidv7();
    const posted = await this.posting.post(tx, {
      companyId: input.companyId,
      rule: 'P23',
      key: `P23:${paymentId}`,
      valueDate: input.receivedOn,
      lines: unmatchedArrivalLines({
        cash: {
          bookId: input.bookId,
          account: input.cashAccount,
          provider: input.provider ?? null,
          settlementAccountId: input.settlementAccountId ?? null,
        },
        paymentId,
        amountMinor: input.amountMinor,
      }),
      record: { type: 'payment', id: paymentId },
      causedBy: input.causedBy ?? null,
    });
    await tx.insert(schema.payment).values({
      id: paymentId,
      companyId: input.companyId,
      method: input.method,
      amountMinor: input.amountMinor,
      receivedOn: input.receivedOn,
      accountingDate: posted!.accountingDate,
      ownerId: input.ownerId,
      bookId: input.bookId,
      cashAccount: input.cashAccount,
      provider: input.provider ?? null,
      payerName: input.payerName ?? null,
      senderReference: input.senderReference ?? null,
      note: input.note ?? null,
      proofDocumentId: input.proofDocumentId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      entryId: posted!.entryId,
      recordedBy: input.recordedBy ?? null,
      ...this.providerColumns(input),
    });
    return paymentId;
  }

  /** The M4b columns of a provider payment (empty for every other kind of money). */
  private providerColumns(
    input: Pick<
      MoneyIn,
      'providerReference' | 'settlementAccountId' | 'payerPhoneIndex' | 'payerPhoneMasked'
    >,
  ) {
    return {
      providerReference: input.providerReference ?? null,
      settlementAccountId: input.settlementAccountId ?? null,
      payerPhoneIndex: input.payerPhoneIndex ?? null,
      payerPhoneMasked: input.payerPhoneMasked ?? null,
    };
  }

  /**
   * Where unmatched provider money sits now in the book that received it (P23 across books): with
   * the provider (1050) until P22 settles it, then its net in the account it was paid into and
   * its fee in 5200, as P22 posted them payment by payment (M4b plan 4.5).
   */
  private async settledHoldings(
    tx: Tx,
    payment: PaymentRecord,
  ): Promise<
    | {
        side: {
          bookId: string;
          account: '1010' | '1070' | '5200';
          provider?: string | null;
          settlementAccountId?: string | null;
        };
        amountMinor: number;
      }[]
    | null
  > {
    if (payment.row.cashAccount !== '1050') return null;
    const rows = await tx.execute<{ account_code: string; total: string }>(
      sql`select l.account_code, sum(l.amount_minor)::bigint as total
          from journal_line l join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
          where l.payment_id = ${payment.id} and l.book_id = ${payment.row.bookId} and e.rule = 'P22'
            and l.account_code in ('1010', '1070', '5200')
          group by l.account_code`,
    );
    if (rows.rows.length === 0) return null;
    return rows.rows
      .filter((r) => Number(r.total) > 0)
      .map((r) => ({
        side: {
          bookId: payment.row.bookId,
          account: r.account_code as '1010' | '1070' | '5200',
          provider: r.account_code === '5200' ? null : payment.row.provider,
          settlementAccountId: r.account_code === '5200' ? null : payment.row.settlementAccountId,
        },
        amountMinor: Number(r.total),
      }));
  }

  /**
   * P23 on matching: a person matches unmatched money to a lease. The suspense clears and the
   * money is allocated as P03; from the company book into an owner's book, the asset holding it
   * moves between the books so each balances. Its receipt is issued now.
   */
  async match(
    tx: Tx,
    state: LeaseState,
    payment: PaymentRecord,
    matchedBy: string | null,
  ): Promise<{ matchId: string; receiptId: string }> {
    if (payment.leaseId)
      throw conflict('payment_matched', 'This payment is already matched to a lease');
    if (payment.reversedAccountingDate)
      throw conflict('payment_reversed', 'This payment was reversed');
    const book = requireBook(state.book);
    if (payment.row.ownerId && payment.row.bookId !== book.bookId)
      throw conflict(
        'payment_other_owner',
        'This money was received into another owner’s account; match it to one of their leases',
      );
    const today = this.today(state);
    // The money arrived when it arrived: allocation is classified, and posted, as of that day.
    const arrived = payment.row.receivedOn;
    await this.carryOverIfStarted(tx, state, today);
    // Matched money pays what is due, as money received does (M9 review #7).
    await this.issueAtSigningIfNone(tx, state, today);
    await this.issueForAdvance(tx, state, payment.amountMinor, today, arrived);
    await this.accrue(tx, state, today);
    const plan = planAllocation({
      lines: state.lines,
      allocations: state.allocations,
      paymentId: payment.id,
      amountMinor: payment.amountMinor,
      lease: dimsOf(state.lease),
      valueDate: arrived,
      lastDay: lastBillableDay(state.lease),
    });
    const matchId = uuidv7();
    const holdings =
      payment.row.bookId === book.bookId ? null : await this.settledHoldings(tx, payment);
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P23',
      key: `P23:${matchId}`,
      valueDate: arrived,
      lines: unmatchedMatchLines({
        suspenseBookId: payment.row.bookId,
        bookId: book.bookId,
        holding: {
          bookId: book.bookId,
          account: payment.row.cashAccount as CashAccount,
          provider: payment.row.provider,
          settlementAccountId: payment.row.settlementAccountId,
        },
        ...(holdings ? { holdings } : {}),
        paymentId: payment.id,
        lease: dimsOf(state.lease),
        allocations: plan.postings,
        surplusMinor: plan.surplusMinor,
      }),
      record: { type: 'payment_match', id: matchId },
      causedBy: matchedBy,
    });
    await tx.insert(schema.paymentMatch).values({
      id: matchId,
      companyId: state.company.id,
      paymentId: payment.id,
      propertyId: state.lease.propertyId,
      tenantId: state.lease.tenantId,
      leaseId: state.lease.id,
      unitId: state.lease.unitId,
      bookId: book.bookId,
      entryId: posted!.entryId,
      valueDate: arrived,
      accountingDate: posted!.accountingDate,
      matchedBy,
    });
    const [record] = await paymentsByIds(tx, [payment.id]);
    state.payments.push(record!);
    state.payments.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    await this.writeAllocations(
      tx,
      state,
      plan.allocations.map((a) => ({ ...a, source: 'payment' as const })),
      {
        valueDate: arrived,
        accountingDate: posted!.accountingDate,
        recordType: 'match',
        recordId: matchId,
        entryId: posted!.entryId,
      },
    );
    await this.postLateDraws(tx, state, plan.lateDraws, matchedBy);
    if (plan.surplusMinor > 0) await this.carryStranded(tx, state, record!, today);
    const receiptId = await this.issueReceipt(tx, state, {
      payment: record!,
      kind: 'receipt',
      allocations: plan.allocations.map((a) => ({ lineId: a.lineId, amountMinor: a.amountMinor })),
      creditMinor: plan.surplusMinor,
      reverses: null,
    });
    await this.afterReceipt(tx, state, record!, receiptId, matchedBy);
    await enqueueOutbox(tx, {
      companyId: state.company.id,
      type: PAYMENT_POSTED_EVENT,
      payload: { paymentId: payment.id, receiptId, leaseId: state.lease.id },
      idempotencyKey: `${PAYMENT_POSTED_EVENT}:${payment.id}`,
    });
    return { matchId, receiptId };
  }

  // Corrections (plan 4.9) ------------------------------------------------------------------------

  /** Where a payment's money can be taken back from now (P21b): the reversal's options. */
  async reversalOptions(
    tx: Tx,
    payment: PaymentRecord,
    companyKind: string,
  ): Promise<('collector' | 'owner_account' | 'agency_account' | 'provider')[]> {
    switch (payment.row.cashAccount) {
      case '1050': {
        // Once the provider has paid it out (P22), the money sits in the account it settled to,
        // so a reversal takes it from there (architecture P21b; M4b review F3).
        const settled = await this.settledInto(tx, payment.id);
        return settled === '1010'
          ? ['owner_account']
          : settled === '1070'
            ? ['agency_account']
            : ['provider'];
      }
      case '1010':
        return ['owner_account'];
      case '1070':
        return ['agency_account'];
      default: {
        const options: ('collector' | 'owner_account' | 'agency_account')[] = [];
        const held = await this.collectorHeld(
          tx,
          payment.row.collectorPersonId!,
          payment.row.bookId,
        );
        if (held >= payment.amountMinor) options.push('collector');
        options.push('owner_account');
        if (companyKind === 'agency') options.push('agency_account');
        return options;
      }
    }
  }

  /**
   * Where a provider payment's money went when the provider paid it out (P22: Dr 1010 or 1070 on
   * the payment), or null while it is still with the provider.
   */
  async settledInto(tx: Tx, paymentId: string): Promise<'1010' | '1070' | null> {
    const rows = await tx.execute<{ account_code: string }>(
      sql`select l.account_code from journal_line l
          join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
          where e.rule = 'P22' and l.payment_id = ${paymentId}
            and l.account_code in ('1010', '1070') and l.amount_minor > 0
          limit 1`,
    );
    const code = rows.rows[0]?.account_code;
    return code === '1010' || code === '1070' ? code : null;
  }

  /** What a collector holds in a book (1060 for that collector), from the journal. */
  async collectorHeld(tx: Tx, collectorId: string, bookId: string): Promise<number> {
    return balance(tx, { accounts: ['1060'], collectorIds: [collectorId], bookIds: [bookId] });
  }

  /**
   * P21(b): reverses a payment from what it pays for now, never from its first entry. Its
   * allocations come off every line, its credit leaves prepayments, and the money is taken back
   * from where it sits now. A credit receipt is issued. An unmatched payment is reversed line for
   * line (P21a), since nothing has used it.
   */
  async reverse(
    tx: Tx,
    states: readonly LeaseState[],
    payment: PaymentRecord,
    input: {
      readonly reason: string;
      readonly note: string;
      readonly moneyNowIn: 'collector' | 'owner_account' | 'agency_account' | 'provider';
      /** Every staff correction has one (M4a decision 3); a chargeback has none (M4b). */
      readonly approvalRequestId: string | null;
      readonly requestedBy: string | null;
      readonly today: string;
    },
  ): Promise<{
    reversalId: string;
    receiptId: string | null;
    /** P21b (M8 review): the deposit shares a move-out had used, taken back, by move-out. */
    depositUnwound: readonly DepositUnwound[];
  }> {
    if (payment.reversedAccountingDate)
      throw conflict('payment_reversed', 'This payment was already reversed');
    // A deposit a move-out has used is never reversed by a staff correction (M8 review): its
    // settlement stands. A chargeback cannot be refused, so it takes the share back (P21b below).
    if (input.approvalRequestId !== null && (await this.depositUsed(tx, payment.id)) > 0)
      throw depositSettled();
    const reversalId = uuidv7();
    const companyId = payment.row.companyId;
    if (!payment.leaseId) {
      const posted = await this.posting.reverse(tx, {
        companyId,
        entryId: payment.row.entryId,
        key: `P21:${payment.id}`,
        valueDate: input.today,
        record: { type: 'payment_reversal', id: reversalId },
        causedBy: input.requestedBy,
      });
      await tx.insert(schema.paymentReversal).values({
        id: reversalId,
        companyId,
        paymentId: payment.id,
        reason: input.reason,
        note: input.note,
        moneyNowIn: input.moneyNowIn,
        approvalRequestId: input.approvalRequestId,
        entryId: posted!.entryId,
        valueDate: input.today,
        accountingDate: posted!.accountingDate,
        requestedBy: input.requestedBy,
      });
      return { reversalId, receiptId: null, depositUnwound: [] };
    }
    const lines = states.flatMap((s) => s.lines);
    const allocations = dedupe(states.flatMap((s) => s.allocations));
    const leaseOfLine = new Map(
      lines.map((l) => [l.id, states.find((s) => s.lease.id === l.leaseId)!]),
    );
    const plan = planPaymentReversal({
      payment,
      lines,
      allocations,
      leaseOf: (lineId) => dimsOf(leaseOfLine.get(lineId)!.lease),
    });
    // A deposit carried to a renewal is taken back from the lease holding it now (review 9); a
    // carry-back row keeps each lease's deposit sub-ledger right.
    const carriedBack: { from: string; to: LeaseState; amountMinor: number }[] = [];
    const postings = [];
    for (const posting of plan.postings) {
      if (posting.postingClass !== 'deposit') {
        postings.push(posting);
        continue;
      }
      const paidOn = leaseOfLine.get(posting.invoiceLineId)!;
      const holder = await this.depositHolder(tx, payment.id, paidOn.lease.id);
      if (holder === paidOn.lease.id) {
        postings.push(posting);
        continue;
      }
      const lease = await billingLeaseOf(tx, holder);
      postings.push({ ...posting, lease: dimsOf(lease) });
      carriedBack.push({ from: holder, to: paidOn, amountMinor: posting.amountMinor });
    }
    const creditState = states.find((s) => s.lease.id === payment.creditLeaseId) ?? states[0]!;
    const leaseState = states.find((s) => s.lease.id === payment.leaseId) ?? states[0]!;
    // A matched payment's money moved into the lease's book when it was matched.
    const book = requireBook(leaseState.book).bookId;
    const cash = this.cashSideFor(payment, input.moneyNowIn, book);
    if (input.moneyNowIn === 'collector') {
      await lockCollectorCash(tx, companyId, payment.row.collectorPersonId!, book);
      if (
        (await this.collectorHeld(tx, payment.row.collectorPersonId!, book)) < payment.amountMinor
      )
        throw conflict(
          'collector_cash_short',
          'The collector no longer holds this much cash; say where the money is now',
        );
    }
    const posted = await this.posting.post(tx, {
      companyId,
      rule: 'P21',
      key: `P21:${payment.id}`,
      valueDate: input.today,
      lines: paymentReversalLines({
        cash,
        bookId: book,
        paymentId: payment.id,
        allocations: postings,
        credit:
          plan.creditMinor > 0
            ? { lease: dimsOf(creditState.lease), amountMinor: plan.creditMinor }
            : null,
      }),
      record: { type: 'payment_reversal', id: reversalId },
      causedBy: input.requestedBy,
    });
    await tx.insert(schema.paymentReversal).values({
      id: reversalId,
      companyId,
      paymentId: payment.id,
      propertyId: leaseState.lease.propertyId,
      tenantId: leaseState.lease.tenantId,
      leaseId: leaseState.lease.id,
      reason: input.reason,
      note: input.note,
      moneyNowIn: input.moneyNowIn,
      approvalRequestId: input.approvalRequestId,
      entryId: posted!.entryId,
      valueDate: input.today,
      accountingDate: posted!.accountingDate,
      requestedBy: input.requestedBy,
    });
    for (const back of carriedBack)
      await tx.insert(schema.creditCarryOver).values({
        companyId,
        propertyId: back.to.lease.propertyId,
        tenantId: back.to.lease.tenantId,
        leaseId: back.to.lease.id,
        fromLeaseId: back.from,
        kind: 'deposit',
        paymentId: payment.id,
        amountMinor: back.amountMinor,
        entryId: posted!.entryId,
        valueDate: input.today,
        accountingDate: posted!.accountingDate,
      });
    for (const s of states) {
      const mine = plan.rows.filter((r) => leaseOfLine.get(r.lineId) === s);
      await this.writeAllocations(tx, s, mine, {
        valueDate: input.today,
        accountingDate: posted!.accountingDate,
        recordType: 'reversal',
        recordId: reversalId,
        entryId: posted!.entryId,
      });
      s.payments = s.payments.filter((p) => p.id !== payment.id);
    }
    const receiptId = await this.issueReceipt(tx, leaseState, {
      payment,
      kind: 'credit_receipt',
      allocations: plan.rows.map((r) => ({ lineId: r.lineId, amountMinor: -r.amountMinor })),
      creditMinor: plan.creditMinor,
      reverses: { reversalId, reason: input.note },
      linesFrom: lines,
    });
    const depositUnwound = await this.unwindDepositShares(tx, states, payment, {
      reversalId,
      today: input.today,
      causedBy: input.requestedBy,
    });
    for (const s of states) await this.drawCreditToOpen(tx, s, input.today, input.requestedBy);
    // The payment's rent tax is mirrored (P21; M5 plan 5.1).
    await this.taxHooks?.afterReversal(tx, states, payment, {
      reversalId,
      valueDate: input.today,
      causedBy: input.requestedBy,
    });
    return { reversalId, receiptId, depositUnwound };
  }

  /**
   * What move-outs have used of a payment's deposit share and not yet given back: applied to
   * lines, retained for deductions or approved for refund (P11, P12), less what a P21b took back.
   */
  async depositUsed(tx: Tx, paymentId: string): Promise<number> {
    const [row] = (
      await tx.execute<{ total: number }>(
        sql`select coalesce(sum(case when kind = 'unwound' then -amount_minor else amount_minor end), 0)::bigint as total
            from deposit_application where payment_id = ${paymentId}`,
      )
    ).rows;
    return Number(row?.total ?? 0);
  }

  /**
   * P21b on a deposit share a move-out already used (M8 review; CLAUDE.md section 4: a reversal is
   * built from the payment's current allocations, its deposit applications included). For each
   * move-out that used the payment's share, the share comes back to 2100 from where the settlement
   * put it: the lines its deposit paid are owed again (negative `deposit` allocations, newest
   * first), and the deductions kept and the refund approved from it are taken back. The reversal
   * then takes it out of 2100, so no deposit goes below zero. Recorded as an `unwound` deposit
   * application, once per move-out and payment.
   */
  private async unwindDepositShares(
    tx: Tx,
    states: readonly LeaseState[],
    payment: PaymentRecord,
    input: {
      readonly reversalId: string;
      readonly today: string;
      readonly causedBy: string | null;
    },
  ): Promise<DepositUnwound[]> {
    const rows = (
      await tx.execute<{ move_out_id: string; lease_id: string; kind: string; total: number }>(
        sql`select move_out_id, lease_id, kind, sum(amount_minor)::bigint as total
            from deposit_application where payment_id = ${payment.id}
            group by move_out_id, lease_id, kind`,
      )
    ).rows;
    const byMoveOut = new Map<
      string,
      { leaseId: string; applied: number; retained: number; refund: number; unwound: number }
    >();
    for (const r of rows) {
      const g = byMoveOut.get(r.move_out_id) ?? {
        leaseId: r.lease_id,
        applied: 0,
        retained: 0,
        refund: 0,
        unwound: 0,
      };
      const amount = Number(r.total);
      if (r.kind === 'applied') g.applied += amount;
      else if (r.kind === 'retained') g.retained += amount;
      else if (r.kind === 'refund') g.refund += amount;
      else if (r.kind === 'unwound') g.unwound += amount;
      byMoveOut.set(r.move_out_id, g);
    }
    const out: DepositUnwound[] = [];
    for (const [moveOutId, g] of byMoveOut) {
      if (g.unwound > 0 || g.applied + g.retained + g.refund === 0) continue;
      const state =
        states.find((s) => s.lease.id === g.leaseId) ??
        (await this.load(tx, payment.row.companyId, g.leaseId));
      const book = requireBook(state.book);
      // The lines the move-out's deposit paid, newest first, up to this payment's applied share.
      const paid = new Map<string, { amount: number; at: number }>();
      for (const a of state.allocations)
        if (a.source === 'deposit' && a.recordType === 'move_out' && a.recordId === moveOutId) {
          const p = paid.get(a.lineId) ?? { amount: 0, at: 0 };
          paid.set(a.lineId, {
            amount: p.amount + a.amountMinor,
            at: Math.max(p.at, a.createdAt.getTime()),
          });
        }
      for (const a of state.allocations)
        if (a.source === 'deposit' && a.recordType === 'reversal' && paid.has(a.lineId)) {
          const p = paid.get(a.lineId)!;
          p.amount += a.amountMinor;
        }
      const order = [...paid.entries()]
        .filter(([, p]) => p.amount > 0)
        .sort((x, y) => y[1].at - x[1].at || (x[0] < y[0] ? 1 : -1));
      let left = g.applied;
      const lines: { invoiceLineId: string; amountMinor: number }[] = [];
      for (const [lineId, p] of order) {
        if (left === 0) break;
        const take = Math.min(left, p.amount);
        lines.push({ invoiceLineId: lineId, amountMinor: take });
        left -= take;
      }
      // Every applied share was paid onto these lines: anything left is a broken ledger, which a
      // person must see rather than an account guessed for it.
      if (left > 0)
        throw new Error(
          `Move-out ${moveOutId}: the deposit lines no longer cover payment ${payment.id}'s share`,
        );
      const applied = g.applied;
      const total = applied + g.retained + g.refund;
      const posted = await this.posting.post(tx, {
        companyId: state.company.id,
        rule: 'P21',
        key: `P21:${payment.id}:deposit:${moveOutId}`,
        valueDate: input.today,
        lines: depositUnwindLines({
          bookId: book.bookId,
          lease: dimsOf(state.lease),
          paymentId: payment.id,
          lines,
          retainedMinor: g.retained,
          refundMinor: g.refund,
        }),
        record: { type: 'payment_reversal', id: input.reversalId },
        causedBy: input.causedBy,
      });
      await this.writeAllocations(
        tx,
        state,
        lines.map((l) => ({
          lineId: l.invoiceLineId,
          source: 'deposit' as const,
          paymentId: null,
          amountMinor: -l.amountMinor,
        })),
        {
          valueDate: input.today,
          accountingDate: posted!.accountingDate,
          recordType: 'reversal',
          recordId: input.reversalId,
          entryId: posted!.entryId,
        },
      );
      await tx.insert(schema.depositApplication).values({
        companyId: state.company.id,
        propertyId: state.lease.propertyId,
        tenantId: state.lease.tenantId,
        leaseId: state.lease.id,
        moveOutId,
        kind: 'unwound',
        paymentId: payment.id,
        amountMinor: total,
        entryId: posted!.entryId,
        valueDate: input.today,
        accountingDate: posted!.accountingDate,
      });
      out.push({
        moveOutId,
        leaseId: state.lease.id,
        propertyId: state.lease.propertyId,
        ownerId: book.ownerId,
        amountMinor: total,
        appliedMinor: applied,
        retainedMinor: g.retained,
        refundMinor: g.refund,
      });
    }
    return out;
  }

  private cashSideFor(
    payment: PaymentRecord,
    location: 'collector' | 'owner_account' | 'agency_account' | 'provider',
    bookId: string,
  ): CashSide {
    switch (location) {
      case 'collector':
        if (!payment.row.collectorPersonId)
          throw invalid('money_location', 'This payment was not received in cash');
        return { bookId, account: '1060', collectorId: payment.row.collectorPersonId };
      case 'owner_account':
        return { bookId, account: '1010' };
      case 'agency_account':
        return { bookId, account: '1070' };
      case 'provider':
        return {
          bookId,
          account: '1050',
          provider: payment.row.provider ?? 'test',
          settlementAccountId: payment.row.settlementAccountId,
        };
    }
  }

  /**
   * P27: a credit note on a line, its VAT and levy lines following it (approval required, or a
   * system credit note for the periods after a lease ends). The unpaid part stops being owed;
   * payments' money released returns to their credit, latest payment first.
   */
  async credit(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly lineId: string;
      readonly amountMinor: number;
      readonly reason: string;
      readonly kind: 'approved' | 'system';
      readonly approvalRequestId: string | null;
      readonly createdBy: string | null;
      readonly valueDate: string;
    },
  ): Promise<string> {
    const line = state.lines.find((l) => l.id === input.lineId);
    if (!line) throw invalid('line_not_found', 'That invoice line is not on this lease');
    this.refuseWithheldCredit(state, line.id, input.amountMinor);
    const taxLines = state.lines.filter((l) => l.baseLineId === line.id);
    const sharing = new Set(
      [line, ...taxLines].flatMap((l) => [...paymentShares(l.id, state.allocations).keys()]),
    );
    const payments = (await paymentsByIds(tx, [...sharing])).filter(
      (p) => !p.reversedAccountingDate,
    );
    const parts = planCreditNote({
      line,
      taxLines,
      allocations: state.allocations,
      payments,
      amountMinor: input.amountMinor,
    });
    // Money released for a payment whose credit has moved to a renewal returns to it there, so
    // no credit is stranded on an ended lease (review 11).
    const creditLeases = new Map<string, ReturnType<typeof dimsOf>>();
    for (const payment of payments)
      if (payment.creditLeaseId && payment.creditLeaseId !== state.lease.id)
        creditLeases.set(payment.id, dimsOf(await billingLeaseOf(tx, payment.creditLeaseId)));
    const book = requireBook(state.book);
    const dims = dimsOf(state.lease);
    const creditNoteId = uuidv7();
    const lines: JournalLineDraft[] = parts.flatMap((part) =>
      creditNoteLines({
        bookId: book.bookId,
        lease: dims,
        invoiceLineId: part.line.id,
        chargedTo: part.chargedTo,
        unpaidMinor: part.unpaidMinor,
        released: part.released,
        creditLeaseOf: (paymentId) => creditLeases.get(paymentId) ?? dims,
      }),
    );
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P27',
      key: `P27:${creditNoteId}`,
      valueDate: input.valueDate,
      lines,
      record: { type: 'credit_note', id: creditNoteId },
      causedBy: input.createdBy,
    });
    const accountingDate =
      posted?.accountingDate ??
      (await this.posting.accountingDate(tx, [book.bookId], input.valueDate));
    await tx.insert(schema.creditNote).values({
      id: creditNoteId,
      companyId: state.company.id,
      propertyId: state.lease.propertyId,
      tenantId: state.lease.tenantId,
      leaseId: state.lease.id,
      invoiceLineId: line.id,
      amountMinor: input.amountMinor,
      reason: input.reason,
      kind: input.kind,
      approvalRequestId: input.approvalRequestId,
      entryId: posted?.entryId ?? null,
      valueDate: input.valueDate,
      accountingDate,
      createdBy: input.createdBy,
    });
    await this.writeAllocations(
      tx,
      state,
      parts.flatMap((p) => p.rows),
      {
        valueDate: input.valueDate,
        accountingDate,
        recordType: 'credit_note',
        recordId: creditNoteId,
        entryId: posted?.entryId ?? null,
      },
    );
    // Credit released here, on a lease whose renewal has started, moves to it (review 11).
    for (const payment of payments)
      if (
        payment.creditLeaseId === state.lease.id &&
        parts.some((p) => p.released.some((r) => r.paymentId === payment.id))
      )
        await this.carryStranded(tx, state, payment, input.valueDate);
    await this.drawCreditToOpen(tx, state, input.valueDate, input.createdBy);
    return creditNoteId;
  }

  /**
   * Decision 9 (M5): a credit note that would have to take back tax the tenant withheld on the
   * month is refused, plainly: only payments' money returns to credit, and how withheld tax is
   * treated when rent is credited back is for the tax adviser (OQ-56).
   */
  refuseWithheldCredit(state: LeaseState, lineId: string, amountMinor: number): void {
    const line = state.lines.find((l) => l.id === lineId);
    if (!line || withheldOn(lineId, state.allocations) <= 0) return;
    const balance = lineBalance(line, state.allocations);
    let fromPayments = 0;
    for (const share of paymentShares(lineId, state.allocations).values()) fromPayments += share;
    if (amountMinor > balance.outstandingMinor + fromPayments) throw creditNoteWithheld();
  }

  /**
   * Spare credit pays debt a correction reopened (M4b review F4): after a reversal or a credit
   * note, an accrued period left owing while the lease holds credit is paid from it at once,
   * oldest payment first, by a P02 credit draw keyed on the line and its allocations so far.
   * So ageing, reminders and paid-until agree with the credit the tenant holds.
   */
  async drawCreditToOpen(
    tx: Tx,
    state: LeaseState,
    valueDate: string,
    causedBy: string | null,
  ): Promise<number> {
    const pools = creditPools(state.payments, state.allocations);
    if (pools.length === 0) return 0;
    const book = requireBook(state.book);
    const plans = planReopenedDraws(state.lines, state.allocations, pools);
    for (const plan of plans) {
      const n = state.allocations.filter((a) => a.lineId === plan.lineId).length;
      const posted = await this.posting.post(tx, {
        companyId: state.company.id,
        rule: 'P02',
        key: `P02:${plan.lineId}:redraw:${n}`,
        valueDate,
        lines: creditDrawLines({
          bookId: book.bookId,
          lease: dimsOf(state.lease),
          invoiceLineId: plan.lineId,
          draws: plan.draws,
        }),
        record: { type: 'invoice_line', id: plan.lineId },
        causedBy,
      });
      await this.writeAllocations(
        tx,
        state,
        plan.draws.map((d) => ({
          lineId: plan.lineId,
          source: 'payment' as const,
          paymentId: d.paymentId,
          amountMinor: d.amountMinor,
        })),
        {
          valueDate,
          accountingDate:
            posted?.accountingDate ??
            (await this.posting.accountingDate(tx, [book.bookId], valueDate)),
          recordType: 'accrual',
          recordId: plan.lineId,
          entryId: posted?.entryId ?? null,
        },
      );
    }
    return plans.length;
  }

  /** P24: writes off a debt still owed on a charged line (two-person approval). */
  async writeOff(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly lineId: string;
      readonly amountMinor: number;
      readonly reason: string;
      readonly approvalRequestId: string;
      readonly createdBy: string | null;
      readonly valueDate: string;
    },
  ): Promise<string> {
    const line = state.lines.find((l) => l.id === input.lineId);
    if (!line) throw invalid('line_not_found', 'That invoice line is not on this lease');
    const row = planWriteOff({
      line,
      allocations: state.allocations,
      amountMinor: input.amountMinor,
    });
    const book = requireBook(state.book);
    const writeOffId = uuidv7();
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P24',
      key: `P24:${writeOffId}`,
      valueDate: input.valueDate,
      lines: writeOffLines({
        bookId: book.bookId,
        lease: dimsOf(state.lease),
        invoiceLineId: line.id,
        amountMinor: input.amountMinor,
      }),
      record: { type: 'write_off', id: writeOffId },
      causedBy: input.createdBy,
    });
    await tx.insert(schema.writeOff).values({
      id: writeOffId,
      companyId: state.company.id,
      propertyId: state.lease.propertyId,
      tenantId: state.lease.tenantId,
      leaseId: state.lease.id,
      invoiceLineId: line.id,
      amountMinor: input.amountMinor,
      reason: input.reason,
      approvalRequestId: input.approvalRequestId,
      entryId: posted!.entryId,
      valueDate: input.valueDate,
      accountingDate: posted!.accountingDate,
      createdBy: input.createdBy,
    });
    await this.writeAllocations(tx, state, [row], {
      valueDate: input.valueDate,
      accountingDate: posted!.accountingDate,
      recordType: 'write_off',
      recordId: writeOffId,
      entryId: posted!.entryId,
    });
    return writeOffId;
  }

  /**
   * P29: when a renewal starts, the old lease's credit, payment by payment (so first in, first out
   * is kept), and its deposit move to the new lease within the owner's book. Debts stay on the old
   * lease's invoices. Once per renewal.
   */
  async carryOver(tx: Tx, from: LeaseState, to: LeaseState, valueDate: string): Promise<boolean> {
    const key = `P29:${to.lease.id}`;
    if (await this.posting.findByKey(tx, to.company.id, key)) return false;
    const book = requireBook(from.book);
    const credits = creditPools(from.payments, from.allocations).map((p) => ({
      paymentId: p.paymentId,
      amountMinor: p.amountMinor,
    }));
    const deposit = await this.depositHeld(tx, from.lease.id);
    const deposits = await this.depositParts(tx, from, deposit);
    const lines = carryOverLines({
      bookId: book.bookId,
      from: dimsOf(from.lease),
      to: dimsOf(to.lease),
      credits,
      depositMinor: deposit,
      deposits,
    });
    const posted = await this.posting.post(tx, {
      companyId: to.company.id,
      rule: 'P29',
      key,
      valueDate,
      lines,
      record: { type: 'lease', id: to.lease.id },
    });
    if (!posted) return false;
    const rows = [
      ...credits.map((c) => ({
        kind: 'credit' as const,
        paymentId: c.paymentId,
        amountMinor: c.amountMinor,
      })),
      ...deposits
        .filter((d) => d.amountMinor > 0)
        .map((d) => ({
          kind: 'deposit' as const,
          paymentId: d.paymentId,
          amountMinor: d.amountMinor,
        })),
    ];
    if (rows.length > 0)
      await tx.insert(schema.creditCarryOver).values(
        rows.map((r) => ({
          companyId: to.company.id,
          propertyId: to.lease.propertyId,
          tenantId: to.lease.tenantId,
          leaseId: to.lease.id,
          fromLeaseId: from.lease.id,
          kind: r.kind,
          paymentId: r.paymentId,
          amountMinor: r.amountMinor,
          entryId: posted.entryId,
          valueDate,
          accountingDate: posted.accountingDate,
        })),
      );
    const moved = from.payments.filter((p) => credits.some((c) => c.paymentId === p.id));
    from.payments = from.payments.filter((p) => !moved.includes(p));
    const reloaded = await paymentsByIds(
      tx,
      moved.map((p) => p.id),
    );
    to.payments = [...to.payments, ...reloaded].sort((a, b) =>
      a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
    );
    to.allocations = dedupe([
      ...to.allocations,
      ...(await loadAllocations(tx, { leaseIds: [], paymentIds: reloaded.map((p) => p.id) })),
    ]);
    if (credits.length > 0)
      await this.taxHooks?.afterCarryOver(tx, to, {
        key,
        valueDate,
        credits,
        fromLeaseId: from.lease.id,
      });
    return true;
  }

  /**
   * The deposit a lease holds, by the payment that paid it (review 9): its deposit lines' payment
   * shares, plus deposits carried in, less deposits carried out. What the parts do not explain
   * (carried before parts were kept) has no payment. The parts add up to `held`.
   */
  async depositParts(
    tx: Tx,
    state: LeaseState,
    held: number,
  ): Promise<{ paymentId: string | null; amountMinor: number }[]> {
    const parts = new Map<string, number>();
    const add = (id: string, amount: number) => parts.set(id, (parts.get(id) ?? 0) + amount);
    for (const line of state.lines.filter((l) => l.kind === 'deposit'))
      for (const [paymentId, share] of paymentShares(line.id, state.allocations))
        add(paymentId, share);
    const carried = await tx
      .select()
      .from(schema.creditCarryOver)
      .where(
        and(
          eq(schema.creditCarryOver.kind, 'deposit'),
          sql`(${schema.creditCarryOver.leaseId} = ${state.lease.id} or ${schema.creditCarryOver.fromLeaseId} = ${state.lease.id})`,
        ),
      );
    for (const c of carried)
      if (c.paymentId)
        add(c.paymentId, c.leaseId === state.lease.id ? c.amountMinor : -c.amountMinor);
    // M8: what a move-out took (applied, retained or refunded) has left the deposit.
    const used = await tx
      .select({
        paymentId: schema.depositApplication.paymentId,
        amountMinor: schema.depositApplication.amountMinor,
      })
      .from(schema.depositApplication)
      .where(eq(schema.depositApplication.leaseId, state.lease.id));
    // A share with no payment (carried before shares were kept) is what the journal holds beyond
    // the payments' shares, so its use needs no subtracting here.
    for (const u of used) if (u.paymentId) add(u.paymentId, -u.amountMinor);
    const out = [...parts]
      .filter(([, amount]) => amount > 0)
      .map(([paymentId, amountMinor]) => ({ paymentId: paymentId as string | null, amountMinor }));
    const explained = out.reduce((sum, p) => sum + p.amountMinor, 0);
    if (explained > held)
      throw new Error(`Lease ${state.lease.id} holds less deposit than its payments paid`);
    if (held > explained) out.push({ paymentId: null, amountMinor: held - explained });
    return out;
  }

  /**
   * Where a payment's deposit, paid on `leaseId`, sits now: the lease it was carried to last
   * (P29, per payment), or `leaseId` when it never moved.
   */
  async depositHolder(tx: Tx, paymentId: string, leaseId: string): Promise<string> {
    let holder = leaseId;
    for (let hops = 0; hops < 50; hops += 1) {
      const [next] = await tx
        .select({ leaseId: schema.creditCarryOver.leaseId })
        .from(schema.creditCarryOver)
        .where(
          and(
            eq(schema.creditCarryOver.kind, 'deposit'),
            eq(schema.creditCarryOver.paymentId, paymentId),
            eq(schema.creditCarryOver.fromLeaseId, holder),
          ),
        );
      if (!next) return holder;
      holder = next.leaseId;
    }
    throw new Error('A deposit carried round in a circle');
  }

  /**
   * P29 once a renewal has started: the old lease is accrued to date first, then carried over.
   * Every path that takes money for a lease runs it first, as it accrues first (review 10). The
   * caller holds both leases' locks.
   */
  async carryOverIfStarted(tx: Tx, renewal: LeaseState, date: string): Promise<void> {
    const lease = renewal.lease;
    const oldId = await renewedLeaseOf(tx, lease.id);
    if (!oldId || lease.startDate > date) return;
    if (!['active', 'ending', 'holding_over', 'ended', 'terminated'].includes(lease.status)) return;
    const old = await this.load(tx, renewal.company.id, oldId);
    if (old.book.kind !== 'book') return;
    await this.accrue(tx, old, date);
    await this.carryOver(tx, old, renewal, lease.startDate);
  }

  /**
   * Credit that appears on a lease after its renewal has started (a payment recorded against the
   * old lease) moves to the renewal at once, under the payment's own key (review 11).
   */
  async carryStranded(tx: Tx, from: LeaseState, payment: PaymentRecord, valueDate: string) {
    const renewalId = await startedRenewalOf(tx, from.lease.id);
    if (!renewalId) return;
    const credit = paymentCredit(payment, from.allocations);
    if (credit <= 0) return;
    const to = await this.load(tx, from.company.id, renewalId);
    const book = requireBook(from.book);
    const posted = await this.posting.post(tx, {
      companyId: from.company.id,
      rule: 'P29',
      key: `P29:${renewalId}:${payment.id}`,
      valueDate,
      lines: carryOverLines({
        bookId: book.bookId,
        from: dimsOf(from.lease),
        to: dimsOf(to.lease),
        credits: [{ paymentId: payment.id, amountMinor: credit }],
        depositMinor: 0,
      }),
      record: { type: 'lease', id: renewalId },
    });
    if (!posted) return;
    await tx.insert(schema.creditCarryOver).values({
      companyId: from.company.id,
      propertyId: to.lease.propertyId,
      tenantId: to.lease.tenantId,
      leaseId: renewalId,
      fromLeaseId: from.lease.id,
      kind: 'credit',
      paymentId: payment.id,
      amountMinor: credit,
      entryId: posted.entryId,
      valueDate,
      accountingDate: posted.accountingDate,
    });
    from.payments = from.payments.filter((p) => p.id !== payment.id);
    if (this.taxHooks)
      await this.taxHooks.afterCarryOver(tx, await this.load(tx, from.company.id, renewalId), {
        key: `P29:${renewalId}:${payment.id}`,
        valueDate,
        credits: [{ paymentId: payment.id, amountMinor: credit }],
        fromLeaseId: from.lease.id,
      });
  }

  /** The deposit a lease holds now (2100 on the lease), from the journal. */
  async depositHeld(tx: Tx, leaseId: string): Promise<number> {
    return 0 - (await balance(tx, { accounts: ['2100'], leaseIds: [leaseId] }));
  }

  // Receipts (plan 4.10) ---------------------------------------------------------------------------

  /** Numbers a receipt in the posting transaction and queues its PDF. */
  private async issueReceipt(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly payment: PaymentRecord;
      readonly kind: 'receipt' | 'credit_receipt';
      readonly allocations: readonly { readonly lineId: string; readonly amountMinor: number }[];
      readonly creditMinor: number;
      readonly reverses: { readonly reversalId: string; readonly reason: string } | null;
      readonly linesFrom?: readonly LineRecord[];
    },
  ): Promise<string> {
    const { company, lease } = state;
    const book = requireBook(state.book);
    const owner = (await ownerFacts(tx, [book.ownerId])).get(book.ownerId);
    const number = await nextNumber(tx, company.id, 'receipt');
    const receiptId = uuidv7();
    const issuedAt = this.clock.now();
    const linesById = new Map((input.linesFrom ?? state.lines).map((l) => [l.id, l]));
    const walk = this.walk(state);
    const payment = input.payment.row;
    const collector = payment.collectorPersonId
      ? await personContact(tx, payment.collectorPersonId)
      : null;
    let reverses: ReceiptDocumentData['reverses'] = null;
    if (input.reverses) {
      const [original] = await tx
        .select({ number: schema.receipt.number })
        .from(schema.receipt)
        .where(and(eq(schema.receipt.paymentId, payment.id), eq(schema.receipt.kind, 'receipt')));
      reverses = original
        ? {
            number: formatReceiptNumber(original.number),
            reason: input.reverses.reason.slice(0, 300),
          }
        : null;
    }
    const reference = await this.ensureReference(tx, lease);
    const allocations = input.allocations.filter((a) => a.amountMinor !== 0);
    const data: ReceiptDocumentData = {
      number: formatReceiptNumber(number),
      kind: input.kind,
      issuedAt: issuedAt.toISOString(),
      timeZone: company.timeZone,
      receivedOn: payment.receivedOn,
      method:
        payment.method === 'cheque' && payment.chequeNumber
          ? `Cheque ${payment.chequeNumber}${payment.chequeBank ? ` (${payment.chequeBank})` : ''}`.slice(
              0,
              120,
            )
          : METHOD_LABELS[payment.method as MoneyIn['method']],
      receivedFrom: (payment.payerName ?? lease.tenantName).slice(0, 200),
      tenant: { name: lease.tenantName.slice(0, 200), tin: lease.tenantTinMasked },
      billedFrom: {
        name: (owner?.name ?? company.displayName).slice(0, 200),
        tin: owner?.tinMasked ?? null,
      },
      unit: { code: lease.unitCode, propertyName: lease.propertyName.slice(0, 200) },
      paymentReference: reference,
      amountMinor: payment.amountMinor,
      allocations: allocations.map((a) => {
        const line = linesById.get(a.lineId)!;
        return {
          label: lineLabel(line),
          invoiceNumber: formatInvoiceNumber(line.invoiceNumber),
          amountMinor: a.amountMinor,
        };
      }),
      creditMinor: input.creditMinor,
      vatMinor: allocations.some((a) => isTax(linesById.get(a.lineId)!.kind))
        ? allocations
            .filter((a) => isTax(linesById.get(a.lineId)!.kind))
            .reduce((s, a) => s + a.amountMinor, 0)
        : null,
      paidUntil: walk.paidUntil,
      partial: walk.partial,
      receivedBy:
        (payment.method === 'cash' || payment.method === 'cheque') && collector
          ? collector.name.slice(0, 200)
          : null,
      reverses,
    };
    templates.get(RECEIPT_TEMPLATE.key, RECEIPT_TEMPLATE.version).schema.parse(data);
    const renderRequestId = await this.documents.requestRender(tx, {
      companyId: company.id,
      templateKey: RECEIPT_TEMPLATE.key,
      templateVersion: RECEIPT_TEMPLATE.version,
      data,
    });
    await tx.insert(schema.receipt).values({
      id: receiptId,
      companyId: company.id,
      number,
      kind: input.kind,
      paymentId: payment.id,
      reversalId: input.reverses?.reversalId ?? null,
      propertyId: lease.propertyId,
      tenantId: lease.tenantId,
      leaseId: lease.id,
      amountMinor: payment.amountMinor,
      issuedAt,
      renderRequestId,
    });
    return receiptId;
  }

  // M5: months paid ahead, withholding and early termination ------------------------------------

  /** After a receipt's postings: months paid ahead (AR-05), then the tax module's rent tax (P17). */
  private async afterReceipt(
    tx: Tx,
    state: LeaseState,
    payment: PaymentRecord,
    receiptId: string,
    causedBy: string | null,
  ): Promise<void> {
    await this.recordAdvance(tx, state, payment);
    await this.taxHooks?.afterReceipt(tx, state, { payment, receiptId, causedBy });
  }

  /**
   * AR-05 (M5 plan 5.5, decision 4): the months the lease is paid ahead after the payment, by the
   * forward walk, against the advance rule for its term as of the value date and the company's
   * `advance_rent_policy`. `off` records only; `warn` and `block` flag a payment over the limit
   * (money a provider confirmed under `block` arrives anyway, and is flagged for a person).
   */
  async recordAdvance(tx: Tx, state: LeaseState, payment: PaymentRecord): Promise<void> {
    const valueDate = payment.row.receivedOn;
    const months = monthsPaidAhead(this.walk(state), valueDate);
    const policy = parseCompanySettings(state.company.settings).advanceRentPolicy;
    const key = advanceRuleKeyFor(state.lease.terms.periodCount);
    const rule = key ? await this.ruleOrNull(tx, state.company.countryCode, key, valueDate) : null;
    const value = (rule?.value as { months?: unknown } | null | undefined)?.months;
    const limit = typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
    const over = limit !== null && months > limit;
    await tx
      .insert(schema.paymentAdvance)
      .values({
        companyId: state.company.id,
        paymentId: payment.id,
        propertyId: state.lease.propertyId,
        tenantId: state.lease.tenantId,
        leaseId: state.lease.id,
        valueDate,
        monthsAhead: months,
        policy,
        ruleKey: rule ? key : null,
        ruleId: rule?.ruleId ?? null,
        limitMonths: limit,
        overLimit: over,
        flagged: over && policy !== 'off',
      })
      .onConflictDoNothing();
  }

  /**
   * The advance rule for the lease's term as of a date, with the company's policy (AR-05): null
   * rule and limit where none applies (terms of two to six months, OQ-51).
   */
  async advanceLimit(
    tx: Tx,
    state: LeaseState,
    date: string,
  ): Promise<{
    readonly policy: 'off' | 'warn' | 'block';
    readonly ruleKey: string | null;
    readonly rule: ResolvedRule | null;
    readonly limitMonths: number | null;
  }> {
    const policy = parseCompanySettings(state.company.settings).advanceRentPolicy;
    const key = advanceRuleKeyFor(state.lease.terms.periodCount);
    const rule = key ? await this.ruleOrNull(tx, state.company.countryCode, key, date) : null;
    const value = (rule?.value as { months?: unknown } | null | undefined)?.months;
    const limit = typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
    return { policy, ruleKey: rule ? key : null, rule, limitMonths: limit };
  }

  /**
   * Decision 4 (AR-05): under `block`, cash and transfers are refused when they would pay more
   * months ahead than the limit; the most they may be is said. `off` and `warn` take any amount
   * (`warn` flags it once posted). Nothing calls an advance compliant.
   */
  async checkAdvanceCap(
    tx: Tx,
    state: LeaseState,
    amountMinor: number,
    valueDate: string,
  ): Promise<void> {
    const limit = await this.advanceLimit(tx, state, valueDate);
    if (limit.policy !== 'block' || limit.limitMonths === null) return;
    // Review 9: the same function as the pay page's.
    const max = advancePaymentCapMinor({
      lines: state.lines,
      allocations: state.allocations,
      walk: this.walk(state),
      valueDate,
      limitMonths: limit.limitMonths,
    });
    if (amountMinor <= max) return;
    const warning = limit.rule ? verificationWarning(limit.rule.verificationStatus) : null;
    throw new AppError(
      422,
      'advance_over_limit',
      `Your company’s setting refuses rent paid more than ${limit.limitMonths} month${limit.limitMonths === 1 ? '' : 's'} ahead for a lease of this length (Act 220 s.25(5)${warning ? `, ${warning}` : ''}). The most this payment may be is ${format(money(max))}.`,
      { maxMinor: String(max), limitMonths: String(limit.limitMonths) },
    );
  }

  /** AR-05 on the lease page: months paid ahead today, the limit, and the payments flagged. */
  async advanceStatus(tx: Tx, state: LeaseState) {
    const today = this.today(state);
    const limit = await this.advanceLimit(tx, state, today);
    const monthsAhead = monthsPaidAhead(this.walk(state), today);
    const recorded = await tx
      .select()
      .from(schema.paymentAdvance)
      .where(eq(schema.paymentAdvance.leaseId, state.lease.id))
      .orderBy(schema.paymentAdvance.valueDate, schema.paymentAdvance.createdAt);
    const row = (f: (typeof recorded)[number]) => ({
      paymentId: f.paymentId,
      valueDate: f.valueDate,
      monthsAhead: f.monthsAhead,
      limitMonths: f.limitMonths,
      ruleId: f.ruleId,
      policy: f.policy as 'off' | 'warn' | 'block',
      overLimit: f.overLimit,
      flagged: f.flagged,
    });
    return {
      policy: limit.policy,
      monthsAheadNow: monthsAhead,
      limitMonths: limit.limitMonths,
      rule: limit.rule
        ? {
            ruleId: limit.rule.ruleId,
            key: limit.rule.key,
            verificationStatus: limit.rule.verificationStatus,
          }
        : null,
      overLimitNow: limit.limitMonths !== null && monthsAhead > limit.limitMonths,
      flaggedPayments: recorded.filter((f) => f.flagged).map(row),
      /** Every payment's months paid ahead, as recorded when it was received (AR-05). */
      payments: recorded.map(row),
    };
  }

  /** A rule in force on a date, or null when the rules table has none (OQ-51). */
  async ruleOrNull(
    tx: Tx,
    country: string,
    key: string,
    date: string,
  ): Promise<ResolvedRule | null> {
    try {
      return await this.rules.resolveIn(tx, country, key, parseBusinessDate(date));
    } catch (error) {
      if (error instanceof DomainError && error.code === 'rule.missing') return null;
      throw error;
    }
  }

  /**
   * P19 (TX-04): tax a corporate tenant withheld, pinned to the lines it was withheld on, which
   * skips the oldest-first order (BC-07), with allocation rows of source `withholding`. A month
   * that has started: Dr 1150, Cr 1100. A month not yet started (decision 8): Dr 1150, Cr 2010 on
   * the line, its advance, drawn when the month starts. Rent and service charge only. The lease is
   * brought up to date first, as every money path does. The tax module records the withholding
   * itself and its rent tax.
   */
  async withhold(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly withholdingId: string;
      readonly paymentId: string | null;
      readonly lines: readonly { readonly lineId: string; readonly amountMinor: number }[];
      readonly valueDate: string;
      readonly causedBy: string | null;
    },
  ): Promise<{ readonly posted: PostedEntry; readonly released: readonly PaymentAmount[] }> {
    const book = requireBook(state.book);
    const today = this.today(state);
    if (input.valueDate > today)
      throw invalid('received_in_future', 'The day the tax was withheld cannot be in the future');
    await this.carryOverIfStarted(tx, state, today);
    await this.accrue(tx, state, today);
    // Decision 8: a month not yet started holds it as its advance (Cr 2010), drawn when the
    // month starts; a started month's receivable is settled (Cr 1100). Review 2: cash that
    // already paid the line moves back to its payment's credit first, as a credit note's does.
    const sharing = new Set(
      input.lines.flatMap((l) => [...paymentShares(l.lineId, state.allocations).keys()]),
    );
    const payments = (await paymentsByIds(tx, [...sharing])).filter(
      (p) => !p.reversedAccountingDate,
    );
    let plan: ReturnType<typeof planWithholding>;
    try {
      plan = planWithholding({
        lines: state.lines,
        allocations: state.allocations,
        payments,
        withheld: input.lines,
        paymentId: input.paymentId,
      });
    } catch (error) {
      // The codes the API has answered since M5 began, for the lines it refuses.
      if (error instanceof DomainError)
        throw invalid(
          error.code === 'withholding.line'
            ? 'withholding_line'
            : error.code === 'withholding.line_not_found'
              ? 'line_not_found'
              : error.code,
          error.message,
        );
      throw error;
    }
    const released = payments.filter((p) => plan.released.some((r) => r.paymentId === p.id));
    const creditLeases = new Map<string, ReturnType<typeof dimsOf>>();
    for (const payment of released)
      if (payment.creditLeaseId && payment.creditLeaseId !== state.lease.id)
        creditLeases.set(payment.id, dimsOf(await billingLeaseOf(tx, payment.creditLeaseId)));
    const dims = dimsOf(state.lease);
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P19',
      key: `P19:${input.withholdingId}`,
      valueDate: input.valueDate,
      lines: withholdingLines({
        bookId: book.bookId,
        lease: dims,
        paymentId: input.paymentId,
        lines: plan.lines.map((l) => ({
          invoiceLineId: l.line.id,
          amountMinor: l.amountMinor,
          prepaid: l.prepaid,
          released: l.released,
        })),
        creditLeaseOf: (paymentId) => creditLeases.get(paymentId) ?? dims,
      }),
      record: { type: 'withholding', id: input.withholdingId },
      causedBy: input.causedBy,
    });
    await this.writeAllocations(tx, state, plan.rows, {
      valueDate: input.valueDate,
      accountingDate: posted!.accountingDate,
      recordType: 'withholding',
      recordId: input.withholdingId,
      entryId: posted!.entryId,
    });
    if (plan.released.length > 0) {
      // Credit released on a lease whose renewal has started moves to it (review 11), and the
      // freed credit pays what is still owed, oldest first (M4b review F4).
      for (const payment of released)
        if (payment.creditLeaseId === state.lease.id)
          await this.carryStranded(tx, state, payment, input.valueDate);
      await this.drawCreditToOpen(tx, state, input.valueDate, input.causedBy);
    }
    return { posted: posted!, released: plan.released };
  }

  /** AR-04: agreed termination charges, one invoice of one-off lines (P01), named on the PDF. */
  async issueCharges(
    tx: Tx,
    state: LeaseState,
    charges: readonly { readonly description: string; readonly amountMinor: number }[],
    today: string,
    causedBy: string | null,
  ): Promise<string[]> {
    if (charges.length === 0) return [];
    const issued = await this.issue(tx, state, {
      kind: 'one_off',
      drafts: charges.map((c) => ({
        kind: 'one_off' as const,
        chargePeriodId: null,
        periodStart: null,
        periodEnd: null,
        amountMinor: c.amountMinor,
        rateBps: null,
        baseIndex: null,
      })),
      labels: charges.map((c) => c.description.slice(0, 120)),
      dueDate: today,
      issueDate: today,
      periodFrom: null,
      periodTo: null,
      cycleStart: null,
      holdingOver: false,
      vat: null,
      causedBy,
    });
    return issued.lines.map((l) => l.id);
  }

  /**
   * P13 apply (AR-04): the lease's credit pays its open charged lines, oldest debt first, each
   * draw first in, first out by payment (Dr 2010, Cr 1100). Deposits wait for the move-out (M8).
   * Returns what was applied to each line.
   */
  async applyCreditToOpen(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly terminationId: string;
      /** Which application of the settlement: the open lines, then the deductions. */
      readonly key: 'apply' | 'deductions';
      readonly valueDate: string;
      readonly causedBy: string | null;
      /** M8: the settlement is a move-out's (`terminationId` is then the move-out's id). */
      readonly subject?: 'early_termination' | 'move_out';
    },
  ): Promise<{ readonly lineId: string; readonly amountMinor: number }[]> {
    const moveOut = input.subject === 'move_out';
    const pools = creditPools(state.payments, state.allocations);
    const { applications } = applyCreditToOpenLines(state.lines, state.allocations, pools);
    if (applications.length === 0) return [];
    const book = requireBook(state.book);
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P13',
      key: `P13:${input.terminationId}:${input.key}`,
      valueDate: input.valueDate,
      lines: creditApplicationLines({
        bookId: book.bookId,
        lease: dimsOf(state.lease),
        applications: applications.map((a) => ({ invoiceLineId: a.lineId, draws: a.draws })),
      }),
      record: { type: moveOut ? 'move_out' : 'early_termination', id: input.terminationId },
      causedBy: input.causedBy,
    });
    const rows = applications.flatMap((a) =>
      a.draws.map((d) => ({
        lineId: a.lineId,
        source: 'payment' as const,
        paymentId: d.paymentId,
        amountMinor: d.amountMinor,
      })),
    );
    await this.writeAllocations(tx, state, rows, {
      valueDate: input.valueDate,
      accountingDate: posted!.accountingDate,
      recordType: moveOut ? 'move_out' : 'termination',
      recordId: input.terminationId,
      entryId: posted!.entryId,
    });
    return applications.map((a) => ({
      lineId: a.lineId,
      amountMinor: a.draws.reduce((sum, d) => sum + d.amountMinor, 0),
    }));
  }

  /**
   * P13 refund approved (AR-04, decision 6): the credit left becomes a refund payable, payment by
   * payment, first in first out (Dr 2010, Cr 2400). Each payment's share is recorded, so its
   * credit is reduced by what was refunded.
   */
  async approveRefund(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly terminationId: string;
      readonly amountMinor: number;
      readonly valueDate: string;
      readonly causedBy: string | null;
      /** False only in a preview, which has no termination row to hang the shares on. */
      readonly recordParts?: boolean;
      /** M8: a move-out's credit refund (its shares in move_out_refund_part). */
      readonly subject?: 'early_termination' | 'move_out';
    },
  ): Promise<PostedEntry> {
    const moveOut = input.subject === 'move_out';
    let credits: PaymentAmount[];
    try {
      credits = refundCredits(creditPools(state.payments, state.allocations), input.amountMinor);
    } catch (error) {
      if (error instanceof DomainError)
        throw conflict(
          'refund_over_credit',
          'The lease no longer holds this much credit to refund',
        );
      throw error;
    }
    const book = requireBook(state.book);
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P13',
      key: `P13:${input.terminationId}:refund`,
      valueDate: input.valueDate,
      lines: refundApprovedLines({ bookId: book.bookId, lease: dimsOf(state.lease), credits }),
      record: { type: moveOut ? 'move_out' : 'early_termination', id: input.terminationId },
      causedBy: input.causedBy,
    });
    if (input.recordParts === false) return posted!;
    if (moveOut)
      await tx.insert(schema.moveOutRefundPart).values(
        credits.map((c) => ({
          companyId: state.company.id,
          moveOutId: input.terminationId,
          propertyId: state.lease.propertyId,
          tenantId: state.lease.tenantId,
          leaseId: state.lease.id,
          paymentId: c.paymentId,
          amountMinor: c.amountMinor,
        })),
      );
    else
      await tx.insert(schema.earlyTerminationRefundPart).values(
        credits.map((c) => ({
          companyId: state.company.id,
          terminationId: input.terminationId,
          propertyId: state.lease.propertyId,
          tenantId: state.lease.tenantId,
          leaseId: state.lease.id,
          paymentId: c.paymentId,
          amountMinor: c.amountMinor,
        })),
      );
    state.payments = (
      await paymentsByIds(
        tx,
        state.payments.map((p) => p.id),
      )
    ).filter((p) => p.reversedAccountingDate === null);
    return posted!;
  }

  /** P13 refund paid outside the platform (D1), with a reference and proof: Dr 2400, Cr 1010 or 1070. */
  async payRefund(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly terminationId: string;
      readonly amountMinor: number;
      readonly from: '1010' | '1070';
      readonly valueDate: string;
      readonly causedBy: string | null;
      /** M8: a move-out's refund (credit and deposit together, P13 and P12 paid). */
      readonly subject?: 'early_termination' | 'move_out';
    },
  ): Promise<PostedEntry> {
    const book = requireBook(state.book);
    const moveOut = input.subject === 'move_out';
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: moveOut ? 'P12' : 'P13',
      key: moveOut ? `P12:${input.terminationId}:paid` : `P13:${input.terminationId}:paid`,
      valueDate: input.valueDate,
      lines: refundPaidLines({
        bookId: book.bookId,
        lease: dimsOf(state.lease),
        from: input.from,
        amountMinor: input.amountMinor,
      }),
      record: { type: moveOut ? 'move_out' : 'early_termination', id: input.terminationId },
      causedBy: input.causedBy,
    });
    return posted!;
  }

  // The deposit at move-out (M8 plan 4.8; P11, P12) ------------------------------------------------

  /**
   * P11: the deposit applied at a move-out, approved. It pays the open lines given (allocations of
   * source `deposit`, so rent settled this way is rent received) and keeps the deductions (4300).
   * The deposit is taken payment by payment, first in, first out; each share is recorded in
   * deposit_application, which the nightly check counts against 2100 (invariant 4). Returns the
   * shares left for the refund.
   */
  async applyDeposit(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly moveOutId: string;
      readonly lines: readonly { readonly lineId: string; readonly amountMinor: number }[];
      readonly retainedMinor: number;
      readonly valueDate: string;
      readonly causedBy: string | null;
    },
  ): Promise<{ readonly shares: readonly { paymentId: string | null; amountMinor: number }[] }> {
    const held = await this.depositHeld(tx, state.lease.id);
    let parts = await this.depositParts(tx, state, held);
    const applied = input.lines.reduce((s, l) => s + l.amountMinor, 0);
    const take = applied + input.retainedMinor;
    if (take > held)
      throw conflict('deductions_exceed_deposit', 'The lease no longer holds this much deposit');
    if (take === 0) return { shares: parts };
    const { taken, left } = takeShares(parts, take);
    parts = left;
    const book = requireBook(state.book);
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P11',
      key: `P11:${input.moveOutId}`,
      valueDate: input.valueDate,
      lines: depositApplicationLines({
        bookId: book.bookId,
        lease: dimsOf(state.lease),
        shares: taken,
        lines: input.lines
          .filter((l) => l.amountMinor > 0)
          .map((l) => ({ invoiceLineId: l.lineId, amountMinor: l.amountMinor })),
        retainedMinor: input.retainedMinor,
      }),
      record: { type: 'move_out', id: input.moveOutId },
      causedBy: input.causedBy,
    });
    await this.writeAllocations(
      tx,
      state,
      input.lines
        .filter((l) => l.amountMinor > 0)
        .map((l) => ({
          lineId: l.lineId,
          source: 'deposit' as const,
          paymentId: null,
          amountMinor: l.amountMinor,
        })),
      {
        valueDate: input.valueDate,
        accountingDate: posted!.accountingDate,
        recordType: 'move_out',
        recordId: input.moveOutId,
        entryId: posted!.entryId,
      },
    );
    // The shares, split between what paid the lines and what was retained, in the same order.
    const { taken: toLines, left: toRetained } = takeShares(taken, applied);
    for (const [kind, shares] of [
      ['applied', toLines],
      ['retained', toRetained],
    ] as const)
      for (const share of shares)
        await tx.insert(schema.depositApplication).values({
          companyId: state.company.id,
          propertyId: state.lease.propertyId,
          tenantId: state.lease.tenantId,
          leaseId: state.lease.id,
          moveOutId: input.moveOutId,
          kind,
          paymentId: share.paymentId,
          amountMinor: share.amountMinor,
          entryId: posted!.entryId,
          valueDate: input.valueDate,
          accountingDate: posted!.accountingDate,
        });
    return { shares: parts };
  }

  /** P12 approved: the deposit left becomes a refund payable (Dr 2100 per share, Cr 2400). */
  async approveDepositRefund(
    tx: Tx,
    state: LeaseState,
    input: {
      readonly moveOutId: string;
      readonly amountMinor: number;
      readonly valueDate: string;
      readonly causedBy: string | null;
    },
  ): Promise<PostedEntry | null> {
    if (input.amountMinor <= 0) return null;
    const held = await this.depositHeld(tx, state.lease.id);
    if (input.amountMinor > held)
      throw conflict('refund_over_deposit', 'The lease no longer holds this much deposit');
    const { taken } = takeShares(await this.depositParts(tx, state, held), input.amountMinor);
    const book = requireBook(state.book);
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P12',
      key: `P12:${input.moveOutId}:approved`,
      valueDate: input.valueDate,
      lines: depositRefundApprovedLines({
        bookId: book.bookId,
        lease: dimsOf(state.lease),
        shares: taken,
      }),
      record: { type: 'move_out', id: input.moveOutId },
      causedBy: input.causedBy,
    });
    for (const share of taken)
      await tx.insert(schema.depositApplication).values({
        companyId: state.company.id,
        propertyId: state.lease.propertyId,
        tenantId: state.lease.tenantId,
        leaseId: state.lease.id,
        moveOutId: input.moveOutId,
        kind: 'refund',
        paymentId: share.paymentId,
        amountMinor: share.amountMinor,
        entryId: posted!.entryId,
        valueDate: input.valueDate,
        accountingDate: posted!.accountingDate,
      });
    return posted;
  }

  // The forward walk (AR-02, AR-03; plan 4.7) -------------------------------------------------------

  /** The charge periods the lease will bill that have no invoice line yet. */
  scheduled(state: LeaseState): ScheduledPeriod[] {
    const lease = state.lease;
    if (!lease.billingStartDate) return [];
    const invoiced = new Set(
      state.lines.flatMap((l) => (l.chargePeriodId ? [l.chargePeriodId] : [])),
    );
    const last = lastBillableDay(lease);
    return state.schedule
      .filter(
        (s) =>
          !invoiced.has(s.id) &&
          s.periodStart >= lease.billingStartDate! &&
          (last === null || s.periodStart <= last),
      )
      .map((s) => ({
        id: s.id,
        chargeType: s.chargeType,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        amountMinor: s.amountMinor,
        taxMinor: expectedTaxMinor(s, state.vatRates),
      }));
  }

  walk(state: LeaseState): WalkResult {
    return forwardWalk(
      walkLines({
        lines: state.lines,
        allocations: state.allocations,
        scheduled: this.scheduled(state),
      }),
      creditPools(state.payments, state.allocations),
      { lastDay: lastBillableDay(state.lease) },
    );
  }

  /** A payment's credit: what it has not paid towards any line (BC-07, invariant 7). */
  creditOf(payment: PaymentRecord, allocations: readonly AllocationRecord[]): number {
    return paymentCredit(payment, allocations);
  }
}

/** Decision 9: the plain refusal of a credit note on tax a tenant withheld. */
/** P21b's take-back of one move-out's use of a reversed payment's deposit share (M8 review). */
export interface DepositUnwound {
  readonly moveOutId: string;
  readonly leaseId: string;
  readonly propertyId: string;
  readonly ownerId: string;
  readonly amountMinor: number;
  readonly appliedMinor: number;
  readonly retainedMinor: number;
  readonly refundMinor: number;
}

/** A staff reversal of a deposit a move-out has settled (M8 review). */
export const depositSettled = () =>
  conflict(
    'payment_deposit_settled',
    'A move-out has settled the deposit this payment paid, so it cannot be reversed here.',
  );

export const creditNoteWithheld = () =>
  new AppError(
    422,
    'credit_note_withheld',
    'This month has tax the tenant withheld; a credit note cannot take that back. Settle it by hand.',
  );

/** Allocation rows without repeats (a payment's rows can be loaded with its lease's). */
export function dedupe(rows: readonly AllocationRecord[]): AllocationRecord[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** The recurring lines of a lease in accrual order, for views. */
export const recurringInOrder = (lines: readonly LineRecord[]) =>
  inAccrualOrder(lines.filter((l) => isRecurring(l.kind)));

export { paymentOrder, DomainError, compactLines };

/**
 * M8: takes an amount from deposit shares in order (first in, first out), splitting the last one.
 * The shares taken and the shares left add up to the shares given.
 */
export function takeShares(
  shares: readonly { readonly paymentId: string | null; readonly amountMinor: number }[],
  amountMinor: number,
): {
  taken: { paymentId: string | null; amountMinor: number }[];
  left: { paymentId: string | null; amountMinor: number }[];
} {
  let need = amountMinor;
  const taken: { paymentId: string | null; amountMinor: number }[] = [];
  const left: { paymentId: string | null; amountMinor: number }[] = [];
  for (const share of shares) {
    const part = Math.min(need, share.amountMinor);
    if (part > 0) taken.push({ paymentId: share.paymentId, amountMinor: part });
    if (share.amountMinor - part > 0)
      left.push({ paymentId: share.paymentId, amountMinor: share.amountMinor - part });
    need -= part;
  }
  if (need > 0) throw new Error('The deposit shares do not cover the amount taken');
  return { taken, left };
}
