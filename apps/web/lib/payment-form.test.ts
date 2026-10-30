import { referenceFrom } from '@rent/domain/billing';
import { describe, expect, it } from 'vitest';
import {
  amountMinorOf,
  bankable,
  bankableHoldings,
  bankingForm,
  cashForm,
  correctionForm,
  emptyCash,
  emptyTransfer,
  holdingKey,
  referenceCheck,
  reversalForm,
  transferForm,
  type CollectorCash,
} from './payment-form';

const TODAY = '2026-10-30';
const LEASE = '019a3000-0000-7000-8000-0000000000d1';
const PAYMENT = '019a3000-0000-7000-8000-0000000000d2';
const KOJO = '019a3000-0000-7000-8000-0000000000a1';
const ABENA = '019a3000-0000-7000-8000-0000000000a2';
const OWNER_A = '019a3000-0000-7000-8000-0000000000b1';
const OWNER_B = '019a3000-0000-7000-8000-0000000000b2';

const holding = (overrides: Partial<CollectorCash> = {}): CollectorCash => ({
  collectorPersonId: KOJO,
  collectorName: 'Kojo Caretaker (demo)',
  ownerId: OWNER_A,
  ownerName: 'Ama Owner-London (demo)',
  heldMinor: 120_000,
  bankingPendingMinor: 0,
  oldestUnbankedOn: '2026-10-28',
  ...overrides,
});

describe('BC-05 amounts are typed in cedis and sent as pesewas', () => {
  it('parses cedis exactly, with or without commas and the currency sign', () => {
    expect(amountMinorOf('1500')).toEqual({ value: 150_000, problem: null });
    expect(amountMinorOf('1,500.5')).toEqual({ value: 150_050, problem: null });
    expect(amountMinorOf('GH₵ 0.07')).toEqual({ value: 7, problem: null });
    expect(amountMinorOf(' 2,000.00 ')).toEqual({ value: 200_000, problem: null });
  });

  it('refuses blanks, zero, negatives, too many decimals and words', () => {
    expect(amountMinorOf('').problem).toBe('Enter the amount');
    expect(amountMinorOf('0').problem).toBe('Enter an amount above zero');
    expect(amountMinorOf('-5').problem).toBe('Enter an amount above zero');
    expect(amountMinorOf('10.555').problem).toBe(
      'Enter an amount in cedis, such as 1500 or 1,500.50',
    );
    expect(amountMinorOf('ten').problem).toBe('Enter an amount in cedis, such as 1500 or 1,500.50');
    expect(amountMinorOf('1000000001').problem).toBe('That amount is too large');
  });
});

describe('BC-05 cash form', () => {
  it('sends cash with the lease, the payer and the date it was received', () => {
    const draft = {
      ...emptyCash(TODAY, LEASE),
      amount: '800',
      payerName: '  Kwame Monthly (demo) ',
      note: ' Paid at the gate ',
    };
    expect(cashForm(draft, TODAY)).toEqual({
      input: {
        leaseId: LEASE,
        method: 'cash',
        amountMinor: 80_000,
        receivedOn: TODAY,
        payerName: 'Kwame Monthly (demo)',
        chequeNumber: null,
        chequeBank: null,
        note: 'Paid at the gate',
      },
      errors: {},
    });
  });

  it('names who holds the money when it is someone other than the person recording it', () => {
    const draft = {
      ...emptyCash(TODAY, LEASE),
      amount: '800',
      payerName: 'Kwame',
      collectorPersonId: KOJO,
    };
    expect(cashForm(draft, TODAY).input).toMatchObject({ collectorPersonId: KOJO });
    expect(cashForm({ ...draft, collectorPersonId: '' }, TODAY).input).not.toHaveProperty(
      'collectorPersonId',
    );
  });

  it('asks for the cheque’s number and bank for a cheque, and drops them for cash', () => {
    const cheque = {
      ...emptyCash(TODAY, LEASE),
      method: 'cheque' as const,
      amount: '900',
      payerName: 'Osu Pharmacy',
    };
    expect(cashForm(cheque, TODAY).errors).toEqual({
      chequeNumber: 'Enter the cheque number',
      chequeBank: 'Enter the bank the cheque is drawn on',
    });
    const filled = { ...cheque, chequeNumber: '000123', chequeBank: 'GCB Bank' };
    expect(cashForm(filled, TODAY).input).toMatchObject({
      method: 'cheque',
      chequeNumber: '000123',
      chequeBank: 'GCB Bank',
    });
    expect(cashForm({ ...filled, method: 'cash' }, TODAY).input).toMatchObject({
      chequeNumber: null,
      chequeBank: null,
    });
  });

  it('refuses a missing lease, a missing payer and a date in the future', () => {
    const { input, errors } = cashForm(
      { ...emptyCash(TODAY), amount: '50', receivedOn: '2026-10-31' },
      TODAY,
    );
    expect(input).toBeNull();
    expect(errors).toEqual({
      leaseId: 'Choose the lease this money is for',
      payerName: 'Enter the name of the person who paid',
      receivedOn: 'The date cannot be in the future',
    });
    expect(cashForm({ ...emptyCash(TODAY, LEASE), receivedOn: '' }, TODAY).errors.receivedOn).toBe(
      'Choose the date the money was received',
    );
  });
});

describe('P28 and P23 transfer form', () => {
  it('sends a transfer for a lease into the agency’s account', () => {
    const draft = {
      ...emptyTransfer(TODAY, { leaseId: LEASE, agency: true }),
      receivedInto: 'agency_account' as const,
      amount: '36,000',
      senderReference: ' K7Q2M4X ',
    };
    expect(transferForm(draft, TODAY)).toEqual({
      input: {
        leaseId: LEASE,
        receivedInto: 'agency_account',
        ownerId: null,
        amountMinor: 3_600_000,
        receivedOn: TODAY,
        senderReference: 'K7Q2M4X',
        note: null,
      },
      errors: {},
    });
  });

  it('asks whose account it went into when no lease is known, so it waits as unmatched in the right book', () => {
    const draft = {
      ...emptyTransfer(TODAY, { agency: true }),
      receivedInto: 'owner_account' as const,
      amount: '500',
    };
    expect(transferForm(draft, TODAY).errors).toEqual({
      ownerId: 'Choose whose account it went into',
    });
    expect(transferForm({ ...draft, ownerId: OWNER_B }, TODAY).input).toMatchObject({
      leaseId: null,
      receivedInto: 'owner_account',
      ownerId: OWNER_B,
    });
    // Into the agency's account it waits in the company's book: no owner is needed.
    expect(transferForm({ ...draft, receivedInto: 'agency_account' }, TODAY).input).toMatchObject({
      leaseId: null,
      ownerId: null,
    });
  });

  it('starts a landlord’s transfer in the landlord’s own account, and makes an agency choose', () => {
    expect(emptyTransfer(TODAY, { agency: false }).receivedInto).toBe('owner_account');
    const agency = { ...emptyTransfer(TODAY, { leaseId: LEASE, agency: true }), amount: '500' };
    expect(transferForm(agency, TODAY).errors).toEqual({
      receivedInto: 'Choose the account the money went into',
    });
  });
});

describe('P07 banking form never banks more than is held', () => {
  it('banks at most what the collector holds and has not already sent for banking', () => {
    expect(bankable(holding())).toBe(120_000);
    expect(bankable(holding({ bankingPendingMinor: 50_000 }))).toBe(70_000);
    expect(bankable(holding({ bankingPendingMinor: 200_000 }))).toBe(0);
    const rows = [holding({ bankingPendingMinor: 50_000 })];
    const draft = {
      holding: holdingKey(rows[0]!),
      bankedInto: 'owner_account' as const,
      amount: '700.01',
      bankedOn: TODAY,
      note: '',
    };
    expect(bankingForm(draft, rows, TODAY).errors).toEqual({
      amount:
        'That is more than Kojo Caretaker (demo) holds for Ama Owner-London (demo) and has not banked yet: GH₵700.00',
    });
    expect(bankingForm({ ...draft, amount: '700' }, rows, TODAY)).toEqual({
      input: {
        collectorPersonId: KOJO,
        ownerId: OWNER_A,
        bankedInto: 'owner_account',
        amountMinor: 70_000,
        bankedOn: TODAY,
        note: null,
      },
      errors: {},
    });
  });

  it('offers a person their own cash, or anyone’s with the right to bank others’ cash', () => {
    const rows = [
      holding(),
      holding({ collectorPersonId: ABENA, collectorName: 'Abena Caretaker (demo)' }),
      holding({ ownerId: OWNER_B, heldMinor: 10_000, bankingPendingMinor: 10_000 }),
    ];
    expect(bankableHoldings(rows, { personId: KOJO, others: false })).toEqual([rows[0]]);
    expect(bankableHoldings(rows, { personId: KOJO, others: true })).toEqual([rows[0], rows[1]]);
  });

  it('asks whose cash it is, where it went, and refuses a date in the future', () => {
    expect(
      bankingForm(
        { holding: '', bankedInto: '', amount: '10', bankedOn: '2026-11-01', note: '' },
        [holding()],
        TODAY,
      ).errors,
    ).toEqual({
      holding: 'Choose whose cash is banked',
      bankedInto: 'Choose where the cash went',
      bankedOn: 'The date cannot be in the future',
    });
  });
});

describe('P21 reversal request form', () => {
  it('sends the reason, an explanation and where the money is now', () => {
    expect(
      reversalForm(
        { reason: 'bounced_cheque', note: ' Returned by GCB unpaid ', moneyNowIn: 'owner_account' },
        PAYMENT,
        ['owner_account', 'collector'],
      ),
    ).toEqual({
      input: {
        paymentId: PAYMENT,
        reason: 'bounced_cheque',
        note: 'Returned by GCB unpaid',
        moneyNowIn: 'owner_account',
      },
      errors: {},
    });
  });

  it('refuses a place the money cannot be, and a missing reason or explanation', () => {
    expect(
      reversalForm({ reason: '', note: 'oops', moneyNowIn: 'provider' }, PAYMENT, ['collector'])
        .errors,
    ).toEqual({
      reason: 'Choose why it is reversed',
      note: 'Explain it in at least 5 characters',
      moneyNowIn: 'Choose where the money is now',
    });
  });
});

describe('P27 and P24 correction amounts', () => {
  it('never asks for more than the line allows', () => {
    expect(
      correctionForm('credit_note', { amount: '3000.01', reason: 'Billed twice' }, 300_000).errors,
    ).toEqual({
      amount: 'A credit note cannot take off more than the line charges: GH₵3,000.00',
    });
    expect(
      correctionForm('write_off', { amount: '401', reason: 'Tenant left Ghana' }, 40_000).errors,
    ).toEqual({
      amount: 'You can write off at most what is still owed: GH₵400.00',
    });
    expect(
      correctionForm('write_off', { amount: '400', reason: ' Tenant left Ghana ' }, 40_000),
    ).toEqual({
      input: { amountMinor: 40_000, reason: 'Tenant left Ghana' },
      errors: {},
    });
  });

  it('asks for a reason that a second person can judge', () => {
    expect(correctionForm('credit_note', { amount: '10', reason: 'no' }, 300_000).errors).toEqual({
      reason: 'Give a reason of at least 5 characters',
    });
  });
});

describe('BC-03 a transfer’s reference checked against the lease chosen', () => {
  const reference = referenceFrom([0, 10, 20, 1, 2, 3])!;
  const other = referenceFrom([5, 6, 7, 8, 9, 10])!;

  it('reads a payment reference typed with a slip as the reference it is', () => {
    const typed = `${reference.slice(0, 3).toLowerCase().replace('0', 'o')}-${reference.slice(3)}`;
    expect(referenceCheck(typed, reference)).toEqual({ kind: 'matches', reference });
    expect(referenceCheck(` ${reference} `, null)).toEqual({ kind: 'reference', reference });
  });

  it('flags a reference that belongs to another lease, and ignores text that is not one', () => {
    expect(referenceCheck(other, reference)).toEqual({ kind: 'other_lease', reference: other });
    expect(referenceCheck('Rent for October', reference)).toEqual({ kind: 'none' });
    // One wrong character fails the check character.
    const slip = `${reference.slice(0, 6)}${reference.endsWith('1') ? '2' : '1'}`;
    expect(referenceCheck(slip, reference)).toEqual({ kind: 'none' });
  });
});
