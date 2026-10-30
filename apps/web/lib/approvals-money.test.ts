import { describe, expect, it } from 'vitest';
import { approvalActionLabel, approvalFacts, payloadLeaseId, subjectHref } from './approvals';

const LEASE = '019a3000-0000-7000-8000-0000000000e2';
const PAYMENT = '019a3000-0000-7000-8000-0000000000e3';
const INVOICE = '019a3000-0000-7000-8000-0000000000e4';
const LINE = '019a3000-0000-7000-8000-0000000000e5';

describe('BC-05, P07, P21, P24, P27 and P28 money requests read plainly on the approvals screen', () => {
  it('names each money action', () => {
    expect(approvalActionLabel('payment.cash_receipt')).toBe('Post cash or a cheque received');
    expect(approvalActionLabel('payment.direct_receipt')).toBe('Post a transfer received');
    expect(approvalActionLabel('cash.banking')).toBe('Record cash as banked');
    expect(approvalActionLabel('payment.reversal')).toBe('Reverse a payment');
    expect(approvalActionLabel('invoice.credit_note')).toBe('Issue a credit note');
    expect(approvalActionLabel('invoice.write_off')).toBe('Write off a debt');
  });

  it('summarises cash received: the amount from pesewas, the cheque, the payer, the unit and who holds it', () => {
    const facts = approvalFacts('payment.cash_receipt', {
      leaseId: LEASE,
      amountMinor: 80_000,
      method: 'cheque',
      chequeNumber: '000123',
      chequeBank: 'GCB Bank',
      receivedOn: '2026-10-29',
      payerName: 'Kwame Monthly (demo)',
      unitCode: 'ACC-LEG-B1-01',
      tenantName: 'Kwame Monthly (demo)',
      collectorName: 'Kojo Caretaker (demo)',
      photoUploadId: '019a3000-0000-7000-8000-0000000000e9',
    });
    expect(facts).toEqual([
      { label: 'Amount', value: 'GH₵800.00' },
      { label: 'How it was paid', value: 'Cheque' },
      { label: 'Cheque', value: '000123, GCB Bank' },
      { label: 'Received on', value: '29 Oct 2026' },
      { label: 'Paid by', value: 'Kwame Monthly (demo)' },
      { label: 'Unit', value: 'ACC-LEG-B1-01' },
      { label: 'Tenant', value: 'Kwame Monthly (demo)' },
      { label: 'Held by', value: 'Kojo Caretaker (demo)' },
    ]);
  });

  it('summarises banking and transfers with the account the money went into', () => {
    expect(
      approvalFacts('cash.banking', {
        amountMinor: 120_000,
        bankedOn: '2026-10-30',
        bankedInto: 'owner_account',
        collectorName: 'Kojo Caretaker (demo)',
        ownerName: 'Ama Owner-London (demo)',
      }),
    ).toEqual([
      { label: 'Amount', value: 'GH₵1,200.00' },
      { label: 'Banked on', value: '30 Oct 2026' },
      { label: 'Held by', value: 'Kojo Caretaker (demo)' },
      { label: 'Banked into', value: 'The owner’s own account' },
      { label: 'Owner', value: 'Ama Owner-London (demo)' },
    ]);
    expect(
      approvalFacts('payment.direct_receipt', {
        amountMinor: 3_600_000,
        receivedInto: 'agency_account',
        senderReference: 'K7Q2M4X',
      }),
    ).toContainEqual({ label: 'Received into', value: 'The agency’s account' });
  });

  it('says why a payment is reversed and where its money is now, and why a line is credited', () => {
    expect(
      approvalFacts('payment.reversal', {
        paymentId: PAYMENT,
        amountMinor: 90_000,
        reason: 'bounced_cheque',
        note: 'Returned unpaid by the bank',
        moneyNowIn: 'owner_account',
        receiptNumber: 'RC-000012',
      }),
    ).toEqual([
      { label: 'Amount', value: 'GH₵900.00' },
      { label: 'Receipt', value: 'RC-000012' },
      { label: 'Reason', value: 'The cheque bounced' },
      { label: 'Where the money is now', value: 'In the owner’s own account' },
      { label: 'Note', value: 'Returned unpaid by the bank' },
    ]);
    expect(
      approvalFacts('invoice.credit_note', {
        lineId: LINE,
        invoiceId: INVOICE,
        invoiceNumber: 'INV-000045',
        lineLabel: 'Rent, 15 Nov 2026 to 14 Dec 2026',
        amountMinor: 45_000,
        reason: 'Billed for a month after the move-out',
      }),
    ).toEqual([
      { label: 'Amount', value: 'GH₵450.00' },
      { label: 'Invoice', value: 'INV-000045' },
      { label: 'Line', value: 'Rent, 15 Nov 2026 to 14 Dec 2026' },
      { label: 'Reason', value: 'Billed for a month after the move-out' },
    ]);
  });

  it('leaves out what a payload does not carry, and summarises nothing for other requests', () => {
    expect(approvalFacts('invoice.write_off', { amountMinor: 'lots', unitCode: ' ' })).toEqual([]);
    expect(approvalFacts('invoice.write_off', null)).toEqual([]);
    expect(approvalFacts('lease.cancel_signed', { reason: 'The tenant withdrew' })).toEqual([]);
  });

  it('links each request to its record, and finds the lease a money request is about', () => {
    expect(subjectHref({ subjectType: 'payment', subjectId: PAYMENT })).toBe(
      `/payments/${PAYMENT}`,
    );
    expect(subjectHref({ subjectType: 'invoice', subjectId: INVOICE })).toBe(
      `/invoices/${INVOICE}`,
    );
    expect(subjectHref({ subjectType: 'cash_record', subjectId: PAYMENT })).toBe('/cash');
    expect(
      subjectHref({
        subjectType: 'invoice_line',
        subjectId: LINE,
        payload: { invoiceId: INVOICE },
      }),
    ).toBe(`/invoices/${INVOICE}`);
    expect(subjectHref({ subjectType: 'something', subjectId: LINE, payload: {} })).toBeNull();
    expect(payloadLeaseId({ subjectType: 'cash_record', payload: { leaseId: LEASE } })).toBe(LEASE);
    expect(payloadLeaseId({ subjectType: 'lease', payload: { leaseId: LEASE } })).toBeNull();
    expect(
      payloadLeaseId({ subjectType: 'cash_record', payload: { leaseId: 'not-an-id' } }),
    ).toBeNull();
  });
});
