import { DomainError } from '../errors';
import { checkDeductionsWithinDeposit } from './moveout';

/**
 * The final statement of a move-out (TL-11, MI-11; M8 plan 4.8): M5's early-termination figures
 * plus the deposit, as a pure function. It is computed on the lease's lines after the early steps
 * (agreed charges, P01, and the break-clause credit, P27, already applied), and always balances:
 *
 *   deposit held + credit = arrears settled + deductions retained + refund
 *   arrears + deductions charged = arrears settled + still owed
 *
 * The order is the plan's: the credit pays open lines oldest first (P13 apply); the deposit pays
 * what is still open (P11, allocations of source `deposit`, so rent settled from it is rent
 * received and P17 follows); then the deductions are retained from what is left of the deposit
 * (P11, 4300). A deduction the deposit can no longer cover, because arrears used it first, becomes
 * a one-off charge (P01, 4200) that the credit pays if any is left, else stays owed. What remains
 * of the credit is refunded (P13), and of the deposit (P12).
 */
export interface StatementLine {
  readonly lineId: string;
  /** What is still owed on the line, above zero. */
  readonly outstandingMinor: number;
}

export interface FinalStatementInput {
  /** The deposit held for the lease (2100). */
  readonly depositHeldMinor: number;
  /** The lease's credit (2010: prepayment and surplus) after the early steps. */
  readonly creditMinor: number;
  /** Open charged lines (rent, service charge, one-off), oldest debt first. */
  readonly openLines: readonly StatementLine[];
  /** Typed deductions (damage, cleaning, keys, missing items, other). */
  readonly deductions: readonly { readonly amountMinor: number }[];
  /** For the statement only: the agreed early charges (P01) already among the open lines. */
  readonly chargesMinor?: number;
  /** For the statement only: the break-clause credit (P27) already applied to the lines. */
  readonly breakCreditMinor?: number;
}

export interface LineAmount {
  readonly lineId: string;
  readonly amountMinor: number;
}

export interface FinalStatement {
  readonly depositHeldMinor: number;
  readonly creditMinor: number;
  readonly arrearsMinor: number;
  readonly chargesMinor: number;
  readonly breakCreditMinor: number;
  /** P13 apply: the credit paid these lines, oldest first. */
  readonly creditToArrears: readonly LineAmount[];
  /** P11: the deposit paid these lines, oldest first. */
  readonly depositToArrears: readonly LineAmount[];
  readonly deductionsMinor: number;
  /** P11 to 4300: what the deposit keeps for the deductions. */
  readonly retainedMinor: number;
  /** P01: deductions the deposit could no longer cover, charged to the tenant. */
  readonly deductionsChargedMinor: number;
  /** P13 apply: the credit paid towards that charge. */
  readonly creditToDeductionChargeMinor: number;
  readonly creditAppliedMinor: number;
  readonly depositAppliedMinor: number;
  /** P13: the credit refunded. */
  readonly creditRefundMinor: number;
  /** P12: the deposit refunded. */
  readonly depositRefundMinor: number;
  readonly refundMinor: number;
  /** Still owed by the tenant after everything: arrears that stay on the lease. */
  readonly stillOwedMinor: number;
}

const amount = (value: number, what: string) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainError('moveout.bad_amount', `${what} must be zero or more pesewas`);
  return value;
};

/** Takes up to `available` from the lines, oldest first; returns what each paid. */
function payLines(
  lines: { lineId: string; outstandingMinor: number }[],
  available: number,
): LineAmount[] {
  const paid: LineAmount[] = [];
  let left = available;
  for (const line of lines) {
    if (left === 0) break;
    const take = Math.min(left, line.outstandingMinor);
    if (take <= 0) continue;
    paid.push({ lineId: line.lineId, amountMinor: take });
    line.outstandingMinor -= take;
    left -= take;
  }
  return paid;
}

const total = (items: readonly { readonly amountMinor: number }[]) =>
  items.reduce((sum, i) => sum + i.amountMinor, 0);

export function finalStatement(input: FinalStatementInput): FinalStatement {
  const depositHeld = amount(input.depositHeldMinor, 'The deposit');
  const credit = amount(input.creditMinor, 'The credit');
  for (const l of input.openLines) amount(l.outstandingMinor, 'A line');
  for (const d of input.deductions) amount(d.amountMinor, 'A deduction');
  checkDeductionsWithinDeposit(input.deductions, depositHeld);

  const open = input.openLines
    .filter((l) => l.outstandingMinor > 0)
    .map((l) => ({ lineId: l.lineId, outstandingMinor: l.outstandingMinor }));
  const arrears = total(open.map((l) => ({ amountMinor: l.outstandingMinor })));

  // 1. The credit pays open lines (P13 apply).
  const creditToArrears = payLines(open, credit);
  let creditLeft = credit - total(creditToArrears);
  // 2. The deposit pays what is still open (P11, source deposit).
  const depositToArrears = payLines(open, depositHeld);
  let depositLeft = depositHeld - total(depositToArrears);
  // 3. The deductions are retained from what is left of the deposit (P11, 4300).
  const deductions = total(input.deductions);
  const retained = Math.min(deductions, depositLeft);
  depositLeft -= retained;
  // 4. What the deposit could not cover is charged (P01) and paid from any credit left.
  const charged = deductions - retained;
  const creditToCharge = Math.min(charged, creditLeft);
  creditLeft -= creditToCharge;
  const stillOwed =
    total(open.map((l) => ({ amountMinor: l.outstandingMinor }))) + charged - creditToCharge;

  const statement: FinalStatement = {
    depositHeldMinor: depositHeld,
    creditMinor: credit,
    arrearsMinor: arrears,
    chargesMinor: amount(input.chargesMinor ?? 0, 'The charges'),
    breakCreditMinor: amount(input.breakCreditMinor ?? 0, 'The break-clause credit'),
    creditToArrears,
    depositToArrears,
    deductionsMinor: deductions,
    retainedMinor: retained,
    deductionsChargedMinor: charged,
    creditToDeductionChargeMinor: creditToCharge,
    creditAppliedMinor: total(creditToArrears) + creditToCharge,
    depositAppliedMinor: total(depositToArrears),
    creditRefundMinor: creditLeft,
    depositRefundMinor: depositLeft,
    refundMinor: creditLeft + depositLeft,
    stillOwedMinor: stillOwed,
  };
  checkStatementBalances(statement);
  return statement;
}

/** The two identities of the statement; a statement that breaks either is never used. */
export function checkStatementBalances(s: FinalStatement): void {
  const inMoney = s.depositHeldMinor + s.creditMinor;
  const outMoney =
    s.creditAppliedMinor +
    s.depositAppliedMinor +
    s.retainedMinor +
    s.creditRefundMinor +
    s.depositRefundMinor;
  const owed = s.arrearsMinor + s.deductionsChargedMinor;
  const settled = s.creditAppliedMinor + s.depositAppliedMinor + s.stillOwedMinor;
  if (inMoney !== outMoney || owed !== settled || s.retainedMinor > s.depositHeldMinor)
    throw new DomainError('moveout.statement_unbalanced', 'The final statement does not balance');
}

/** The statement's difference: zero for every statement this module makes (the property test). */
export function statementDifference(s: FinalStatement): number {
  return (
    s.depositHeldMinor +
    s.creditMinor -
    (s.creditAppliedMinor +
      s.depositAppliedMinor +
      s.retainedMinor +
      s.creditRefundMinor +
      s.depositRefundMinor)
  );
}
