import { describe, expect, it } from 'vitest';
import {
  approvalActionLabel,
  approvalEvidence,
  approvalFacts,
  approvalWarning,
  subjectHref,
} from './approvals';

const ACCOUNT = '019a3000-0000-7000-8000-0000000000f2';
const PAYMENT = '019a3000-0000-7000-8000-0000000000f3';
const PROOF = '019a3000-0000-7000-8000-0000000000f4';
const OWNER = '019a3000-0000-7000-8000-0000000000f6';
const REFUND = '019a3000-0000-7000-8000-0000000000f7';

/** `settlement_account.change` as the API stores it (packages/server settlement-accounts). */
const addPayload = {
  accountId: ACCOUNT,
  holder: 'owner',
  ownerId: OWNER,
  ownerName: 'Nana Owner-Accra (demo)',
  bankName: 'GCB Bank',
  branch: 'Legon',
  numberMasked: '•••• 4821',
  accountName: 'Nana Owner-Accra',
  accountNameChecked: 'NANA OWNER-ACCRA',
  awaiting: true,
};

describe('ADR-008 a settlement account request reads plainly to the second person', () => {
  it('names the request and shows the bank, the masked number and both names', () => {
    expect(approvalActionLabel('settlement_account.change')).toBe(
      'Add a bank account rent settles into',
    );
    expect(approvalActionLabel('settlement_account.retire')).toBe(
      'Stop settling rent into a bank account',
    );
    expect(approvalFacts('settlement_account.change', addPayload)).toEqual([
      { label: 'Owner', value: 'Nana Owner-Accra (demo)' },
      { label: 'Bank', value: 'GCB Bank, Legon branch' },
      { label: 'Account number', value: '•••• 4821' },
      { label: 'Name on the account', value: 'Nana Owner-Accra' },
      { label: 'Name the bank gave', value: 'NANA OWNER-ACCRA' },
    ]);
  });

  it('says whose account it is when it is the agency’s', () => {
    expect(
      approvalFacts('settlement_account.change', {
        ...addPayload,
        holder: 'agency',
        ownerId: null,
        ownerName: null,
        branch: null,
      }).slice(0, 2),
    ).toEqual([
      { label: 'Whose account', value: 'The agency’s client account' },
      { label: 'Bank', value: 'GCB Bank' },
    ]);
  });

  it('warns the approver when the bank’s name differs or could not be checked', () => {
    expect(approvalWarning('settlement_account.change', addPayload)).toBeNull();
    expect(
      approvalWarning('settlement_account.change', {
        ...addPayload,
        accountNameChecked: 'KWAME MENSAH',
      }),
    ).toEqual({
      title: 'Check the name on the account',
      text: expect.stringContaining('“KWAME MENSAH”') as string,
    });
    expect(
      approvalWarning('settlement_account.change', { ...addPayload, accountNameChecked: null })
        ?.text,
    ).toMatch(/could not confirm the name/);
    expect(approvalWarning('payment.reversal', addPayload)).toBeNull();
  });

  it('says when the account has been decided since it was asked for', () => {
    expect(
      approvalWarning('settlement_account.change', { ...addPayload, awaiting: false })?.title,
    ).toBe('No longer waiting');
  });

  it('a retire request shows its reason, and that rent stops settling there', () => {
    const retire = {
      accountId: ACCOUNT,
      holder: 'owner',
      ownerName: 'Nana Owner-Accra (demo)',
      bankName: 'GCB Bank',
      numberMasked: '•••• 4821',
      reason: 'The owner closed this account',
      live: true,
    };
    expect(approvalFacts('settlement_account.retire', retire)).toEqual([
      { label: 'Owner', value: 'Nana Owner-Accra (demo)' },
      { label: 'Bank', value: 'GCB Bank' },
      { label: 'Account number', value: '•••• 4821' },
      { label: 'Reason', value: 'The owner closed this account' },
    ]);
    expect(approvalWarning('settlement_account.retire', retire)?.title).toBe(
      'Rent stops settling into this account',
    );
    expect(approvalWarning('settlement_account.retire', { ...retire, live: false })?.title).toBe(
      'No longer in use',
    );
  });

  it('carries no evidence, and leads to the settlement accounts screen', () => {
    expect(approvalEvidence('settlement_account.change', addPayload)).toBeNull();
    expect(subjectHref({ subjectType: 'settlement_account', subjectId: ACCOUNT })).toBe(
      '/settings/settlement',
    );
  });
});

describe('P31 a refund request reads plainly, with its proof', () => {
  /** `payment.refund_unmatched` as the API stores it (packages/server queue). */
  const refund = {
    refundId: REFUND,
    paymentId: PAYMENT,
    amountMinor: 120_000,
    receivedOn: '2026-11-01',
    method: 'momo',
    receivedInto: 'provider',
    ownerName: null,
    payerName: 'Kwame Mensah',
    payerPhoneMasked: '024 *** 4821',
    reason: 'Sent to the wrong landlord',
    evidenceDocumentId: null,
    refundable: true,
  };

  it('names the request, the amount from pesewas, the masked payer and the reason', () => {
    expect(approvalActionLabel('payment.refund_unmatched')).toBe(
      'Refund unmatched money to its payer',
    );
    expect(approvalFacts('payment.refund_unmatched', refund)).toEqual([
      { label: 'Amount', value: 'GH₵1,200.00' },
      { label: 'How it was paid', value: 'Mobile money' },
      { label: 'Received on', value: '1 Nov 2026' },
      { label: 'Paid by', value: 'Kwame Mensah' },
      { label: 'Payer’s phone', value: '024 *** 4821' },
      { label: 'Received into', value: 'The payment provider' },
      { label: 'Reason', value: 'Sent to the wrong landlord' },
    ]);
  });

  it('opens the proof of a transfer sent back outside the provider', () => {
    expect(
      approvalEvidence('payment.refund_unmatched', {
        ...refund,
        receivedInto: 'agency_account',
        evidenceDocumentId: PROOF,
      }),
    ).toEqual({ documentId: PROOF, kind: 'transfer_proof' });
    expect(approvalEvidence('payment.refund_unmatched', refund)).toBeNull();
  });

  it('says when the money can no longer be refunded', () => {
    expect(approvalWarning('payment.refund_unmatched', refund)).toBeNull();
    expect(
      approvalWarning('payment.refund_unmatched', { ...refund, refundable: false })?.title,
    ).toBe('No longer refundable');
  });
});
