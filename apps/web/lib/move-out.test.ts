import type { FinalStatementView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { approvalActionLabel, approvalFacts, approvalWarning, subjectHref } from './approvals';
import {
  chargesInput,
  checkStatement,
  currentMoveOut,
  deductionEvidence,
  deductionInput,
  depositLeftMinor,
  emptyDeduction,
  isEarly,
  mayOfferDepositSettlement,
  moveOutNext,
  moveOutReasonText,
  planInput,
  refundInput,
  rowsOfCharges,
  statementSections,
  type Deduction,
} from './move-out';

const LEASE = { startDate: '2026-01-15', endDate: '2027-01-14' };
const ID = '019a3000-0000-7000-8000-0000000000d1';

const deduction = (amountMinor: number, over: Partial<Deduction> = {}): Deduction => ({
  id: `${amountMinor}`,
  kind: 'damage',
  kindLabel: 'Damage',
  amountMinor,
  reason: 'Broken louvre blades',
  inspectionItemIds: [],
  photoIds: [],
  createdAt: '2026-11-05T09:00:00.000Z',
  createdByName: null,
  withdrawnAt: null,
  ...over,
});

/** A statement the API could send: deposit 200, credit 50 against arrears 120 and deductions 60. */
const STATEMENT: FinalStatementView = {
  lastDay: '2026-11-30',
  early: true,
  depositHeldMinor: 200_00,
  creditMinor: 50_00,
  arrearsMinor: 120_00,
  chargesMinor: 30_00,
  breakCreditMinor: 0,
  creditToArrears: [
    {
      lineId: ID,
      invoiceNumber: 'INV-1',
      label: 'Rent',
      periodStart: null,
      periodEnd: null,
      amountMinor: 50_00,
    },
  ],
  depositToArrears: [
    {
      lineId: ID,
      invoiceNumber: 'INV-1',
      label: 'Rent',
      periodStart: null,
      periodEnd: null,
      amountMinor: 70_00,
    },
  ],
  deductionsMinor: 60_00,
  retainedMinor: 60_00,
  deductionsChargedMinor: 0,
  creditAppliedMinor: 50_00,
  depositAppliedMinor: 70_00,
  creditRefundMinor: 0,
  depositRefundMinor: 70_00,
  refundMinor: 70_00,
  stillOwedMinor: 0,
};

describe('TL-11 plan the move-out', () => {
  it('takes the last day and the reason, and calls a date before the end an early end', () => {
    expect(
      planInput(
        { plannedDate: '2027-01-14', reason: 'end_of_term', noticeId: '', note: ' ' },
        LEASE,
      ),
    ).toEqual({
      input: { plannedDate: '2027-01-14', reason: 'end_of_term', noticeId: null, note: null },
      errors: {},
    });
    expect(
      planInput({ plannedDate: '2026-11-30', reason: 'end_of_term', noticeId: '', note: '' }, LEASE)
        .errors.reason,
    ).toContain('not the end of the term');
    expect(
      planInput(
        { plannedDate: '2026-11-30', reason: 'early_termination', noticeId: ID, note: 'Moving' },
        LEASE,
      ).input,
    ).toEqual({
      plannedDate: '2026-11-30',
      reason: 'early_termination',
      noticeId: ID,
      note: 'Moving',
    });
    expect(
      planInput({ plannedDate: '2025-12-01', reason: '', noticeId: 'x', note: '' }, LEASE).errors,
    ).toEqual({
      plannedDate: 'The move-out cannot be before the lease starts, on 15 Jan 2026',
      reason: 'Choose why the tenancy is ending',
      noticeId: 'Choose a notice from the list',
    });
    expect(isEarly('2026-11-30', LEASE.endDate)).toBe(true);
    expect(isEarly(LEASE.endDate, LEASE.endDate)).toBe(false);
  });

  it('shows the live move-out, else the newest one not cancelled', () => {
    expect(currentMoveOut([{ status: 'cancelled' }, { status: 'closed' }])).toEqual({
      status: 'closed',
    });
    expect(currentMoveOut([{ status: 'refund_paid' }, { status: 'awaiting_approval' }])).toEqual({
      status: 'awaiting_approval',
    });
    expect(currentMoveOut([{ status: 'cancelled' }])).toBeNull();
  });
});

describe('MI-11 ★ deductions never exceed the deposit held', () => {
  it('works out what is left, ignoring withdrawn deductions', () => {
    const list = [deduction(80_00), deduction(50_00, { withdrawnAt: '2026-11-05T10:00:00.000Z' })];
    expect(depositLeftMinor(200_00, list)).toBe(120_00);
    expect(depositLeftMinor(50_00, [deduction(80_00)])).toBe(0);
  });

  it('refuses a deduction over what is left, and says how much is left', () => {
    const draft = {
      ...emptyDeduction,
      kind: 'cleaning' as const,
      amount: '150',
      reason: 'Deep clean',
    };
    expect(deductionInput(draft, 120_00).errors.amount).toBe(
      'Only GH₵120.00 of the deposit is left. Record damage beyond the deposit as a charge.',
    );
    expect(deductionInput(draft, 0).errors.amount).toBe(
      'Nothing is left of the deposit. Record damage beyond the deposit as a charge.',
    );
    expect(deductionInput({ ...draft, amount: '120' }, 120_00)).toEqual({
      input: {
        kind: 'cleaning',
        amountMinor: 120_00,
        reason: 'Deep clean',
        inspectionItemIds: [],
        photoIds: [],
      },
      errors: {},
    });
  });

  it('needs the inspection items behind damage, and a reason', () => {
    const damage = { ...emptyDeduction, kind: 'damage' as const, amount: '20', reason: 'x' };
    expect(deductionInput(damage, 100_00).errors).toEqual({
      reason: 'Give the reason, at least 3 characters',
      evidence: 'Choose the inspection items that show it',
    });
    expect(
      deductionInput({ ...damage, reason: 'Broken door', itemIds: [ID], photoIds: [ID] }, 100_00)
        .input,
    ).toEqual({
      kind: 'damage',
      amountMinor: 20_00,
      reason: 'Broken door',
      inspectionItemIds: [ID],
      photoIds: [ID],
    });
  });

  it('tells the approver when no photo stands behind a deduction', () => {
    expect(deductionEvidence(deduction(1, { photoIds: [ID] }))).toBe('photos');
    expect(deductionEvidence(deduction(1, { inspectionItemIds: [ID] }))).toBe('items');
    expect(deductionEvidence(deduction(1))).toBe('none');
  });
});

describe('AR-04 and TL-11 agreed charges for an early end', () => {
  it('ignores blank rows and checks the rest', () => {
    expect(
      chargesInput([
        { description: 'Early exit fee', amount: '1,500' },
        { description: ' ', amount: '' },
      ]),
    ).toEqual({ charges: [{ description: 'Early exit fee', amountMinor: 1_500_00 }], errors: {} });
    expect(chargesInput([{ description: 'x', amount: '10' }]).errors).toEqual({
      0: 'Describe the charge in 2 to 120 characters',
    });
    expect(chargesInput([{ description: 'Repaint', amount: 'ten' }]).charges).toBeNull();
    expect(rowsOfCharges([{ description: 'Repaint', amountMinor: 1_234_50 }])).toEqual([
      { description: 'Repaint', amount: '1234.50' },
    ]);
  });
});

describe('TL-11 ★ the final statement balances, and the screen shows it', () => {
  it('checks both identities on the API’s figures', () => {
    expect(checkStatement(STATEMENT)).toEqual({
      balances: true,
      inMinor: 250_00,
      outMinor: 250_00,
      owedMinor: 120_00,
      settledMinor: 120_00,
    });
  });

  it('flags figures that do not add up, so nobody approves them', () => {
    expect(checkStatement({ ...STATEMENT, depositRefundMinor: 71_00 }).balances).toBe(false);
    expect(checkStatement({ ...STATEMENT, stillOwedMinor: 1 }).balances).toBe(false);
    expect(checkStatement({ ...STATEMENT, refundMinor: 1 }).balances).toBe(false);
  });

  it('lays it out held, owed, settled and left, keeping the essential rows even at zero', () => {
    const sections = statementSections(STATEMENT);
    expect(sections.map((s) => s.key)).toEqual(['held', 'owed', 'applied', 'result']);
    expect(sections[1]!.rows.map((r) => r.key)).toEqual(['arrears', 'charges', 'deductions']);
    expect(sections[3]!.rows.map((r) => [r.key, r.amountMinor])).toEqual([
      ['depositRefund', 70_00],
      ['refund', 70_00],
      ['stillOwed', 0],
    ]);
  });
});

describe('TL-11 the refund recorded as paid', () => {
  it('needs the date, a reference and the account, not before the approval', () => {
    expect(
      refundInput(
        { paidOn: '2026-11-05', reference: 'TRF-1', paidFrom: 'owner_account' },
        '2026-11-04',
        '2026-11-05',
      ),
    ).toEqual({
      input: { paidOn: '2026-11-05', reference: 'TRF-1', paidFrom: 'owner_account' },
      errors: {},
    });
    expect(
      refundInput({ paidOn: '2026-11-03', reference: '', paidFrom: '' }, '2026-11-04', '2026-11-05')
        .errors,
    ).toEqual({
      paidOn: 'It cannot be paid before it was approved, on 4 Nov 2026',
      reference: 'Enter the transfer or MoMo reference',
      paidFrom: 'Choose the account it was paid from',
    });
    expect(
      refundInput(
        { paidOn: '2026-11-06', reference: 'TRF', paidFrom: 'agency_account' },
        null,
        '2026-11-05',
      ).errors.paidOn,
    ).toBe('The date cannot be in the future');
  });
});

describe('TL-11 a quick move-out’s deposit is settled through the same flow', () => {
  it('is offered on an ended or terminated lease with a deposit and no move-out', () => {
    const base = { leaseStatus: 'ended', depositHeldMinor: 100_00, moveOuts: [] };
    expect(mayOfferDepositSettlement(base)).toBe(true);
    expect(mayOfferDepositSettlement({ ...base, leaseStatus: 'terminated' })).toBe(true);
    expect(
      mayOfferDepositSettlement({ ...base, moveOuts: [{ status: 'cancelled' as const }] }),
    ).toBe(true);
    expect(
      mayOfferDepositSettlement({ ...base, moveOuts: [{ status: 'refund_paid' as const }] }),
    ).toBe(false);
    expect(mayOfferDepositSettlement({ ...base, leaseStatus: 'active' })).toBe(false);
    expect(mayOfferDepositSettlement({ ...base, depositHeldMinor: 0 })).toBe(false);
    expect(mayOfferDepositSettlement({ ...base, depositHeldMinor: null })).toBe(false);
  });

  it('says what comes next, encouraging the inspection first', () => {
    expect(
      moveOutNext({
        status: 'settlement_drafted',
        kind: 'deposit_settlement',
        inspectionId: null,
        statement: null,
        refundPaid: null,
      }),
    ).toContain('inspect the unit if you can');
    expect(
      moveOutNext({
        status: 'approved',
        kind: 'move_out',
        inspectionId: ID,
        statement: STATEMENT,
        refundPaid: null,
      }),
    ).toContain('record it as paid');
    expect(
      moveOutNext({
        status: 'approved',
        kind: 'move_out',
        inspectionId: ID,
        statement: { ...STATEMENT, refundMinor: 0 },
        refundPaid: null,
      }),
    ).toBe('Approved. Nothing is left to refund.');
    expect(moveOutReasonText(null)).toBe('The lease had already ended');
    expect(moveOutReasonText('tenant_notice')).toBe('The tenant gave notice');
  });
});

describe('TL-11 ★ the settlement is approved by a second person, with its figures', () => {
  const payload = {
    moveOutId: ID,
    leaseId: ID,
    unitCode: 'ACC-LEG-B2-02',
    tenantName: 'Esi (demo)',
    kind: 'move_out',
    lastDay: '2026-11-30',
    early: true,
    open: true,
    depositHeldMinor: 200_00,
    deductionsMinor: 60_00,
    refundMinor: 70_00,
    stillOwedMinor: 0,
    charges: [{ description: 'Early exit fee', amountMinor: 30_00 }],
    deductions: [],
  };

  it('names the request and summarises it fact by fact', () => {
    expect(approvalActionLabel('lease.move_out_settlement')).toBe(
      'Settle a move-out: the deposit, deductions and refund',
    );
    const facts = approvalFacts('lease.move_out_settlement', payload);
    expect(facts.map((f) => [f.label, f.value])).toEqual(
      expect.arrayContaining([
        ['Kind', 'Move-out, ending early'],
        ['Last day of the tenancy', '30 Nov 2026'],
        ['Deposit held', 'GH₵200.00'],
        ['Deductions', 'GH₵60.00'],
        ['Agreed charges', 'Early exit fee, GH₵30.00'],
        ['Refund to the tenant', 'GH₵70.00'],
        ['Unit', 'ACC-LEG-B2-02'],
      ]),
    );
    expect(
      approvalFacts('lease.move_out_settlement', { ...payload, kind: 'deposit_settlement' }),
    ).toContainEqual({
      label: 'Kind',
      value: 'Deposit settlement after the lease ended',
    });
  });

  it('warns when the figures have moved on, and links to the move-out', () => {
    expect(approvalWarning('lease.move_out_settlement', { ...payload, open: false })?.title).toBe(
      'The figures no longer hold',
    );
    expect(approvalWarning('lease.move_out_settlement', payload)).toBeNull();
    expect(subjectHref({ subjectType: 'move_out', subjectId: ID, payload })).toBe(
      `/leases/${ID}/move-out`,
    );
  });
});
