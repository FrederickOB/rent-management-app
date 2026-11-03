import { PAY_LINK_PROBLEMS } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  channelsLabel,
  ladderWords,
  MANUAL_INSTRUCTIONS_MAX,
  manualInstructionsOf,
  PAY_LINK_PROBLEM_LABELS,
  payLinkState,
  payLinkOffered,
  payLinkOutcome,
} from './collection';
import {
  EXCEPTION_WORDS,
  RESOLVE_NOTE,
  sortExceptions,
  type ReconciliationException,
} from './reconciliation';
import { reversalSummary } from './billing-format';
import {
  confirmMatchText,
  MATCH_REASON_LABELS,
  openRefundText,
  providerFacts,
  queueOwnerOf,
  REFUND_REASON,
  reasonsOf,
  refundForm,
} from './unmatched-queue';

describe('BC-12 suggestions in the unmatched queue say why', () => {
  it('names every reason the API can give, in the API’s order', () => {
    expect(
      reasonsOf({ reasons: ['amount_is_due_now', 'phone_is_tenant', 'near_due_date'] }),
    ).toEqual([
      'The amount is exactly what is due now',
      'Paid from the tenant’s phone or a contact’s',
      'Paid within a week of a due date',
    ]);
    for (const label of Object.values(MATCH_REASON_LABELS)) expect(label).not.toMatch(/_/);
  });

  it('P23 asks the person to confirm each match, saying it pays the oldest debt first', () => {
    const text = confirmMatchText('GH₵1,200.00', {
      unitCode: 'ACC-LEG-B1-01',
      tenantName: 'Ama Tenant (demo)',
    });
    expect(text).toContain('Match GH₵1,200.00 to ACC-LEG-B1-01 (Ama Tenant (demo))?');
    expect(text).toContain('oldest debt first');
    expect(text).toContain('a second person approves');
  });
});

describe('BC-12 provider payments in the unmatched queue', () => {
  const OWNER = '019a3000-0000-7000-8000-0000000000a1';
  const provider = {
    receivedInto: 'provider' as const,
    settlesInto: 'owner_account' as const,
    ownerId: OWNER,
    ownerName: 'Ama Owner-London (demo)',
    method: 'momo' as const,
    provider: 'paystack',
    providerReference: 'T123456789',
    payerName: 'Kwame Mensah',
    payerPhoneMasked: '024 *** 4821',
  };

  it('says how it was paid, through whom, and by whom, with the phone masked', () => {
    expect(providerFacts(provider)).toEqual([
      'Mobile money through Paystack',
      'Provider’s reference: T123456789',
      'Paid by Kwame Mensah, 024 *** 4821',
    ]);
    expect(providerFacts({ ...provider, payerName: null, providerReference: null })).toEqual([
      'Mobile money through Paystack',
      'Paid by 024 *** 4821',
    ]);
    // A transfer recorded by hand has its own reference and note instead.
    expect(providerFacts({ ...provider, receivedInto: 'agency_account' })).toEqual([]);
  });

  it('P23 offers only the owner’s leases for money that settles into the owner’s account', () => {
    expect(queueOwnerOf(provider)).toEqual({ ownerId: OWNER, ownerName: provider.ownerName });
    expect(queueOwnerOf({ ...provider, settlesInto: 'agency_account' })).toBeNull();
    expect(
      queueOwnerOf({ ...provider, receivedInto: 'owner_account', settlesInto: undefined }),
    ).toEqual({ ownerId: OWNER, ownerName: provider.ownerName });
    expect(queueOwnerOf({ ...provider, receivedInto: 'agency_account' })).toBeNull();
  });

  it('P31 says a refund already asked for, waiting or approved', () => {
    const refund = {
      refundId: '019a3000-0000-7000-8000-0000000000b1',
      approvalId: '019a3000-0000-7000-8000-0000000000b2',
    };
    expect(openRefundText({ ...refund, status: 'awaiting_approval' })).toBe(
      'A refund to the payer is waiting for a second person.',
    );
    expect(openRefundText({ ...refund, status: 'approved' })).toBe(
      'A refund to the payer was approved and is on its way.',
    );
  });
});

describe('P21b and plan 4.8 chargebacks and provider refunds on the payment page', () => {
  const base = {
    note: '',
    moneyNowIn: 'provider' as const,
    valueDate: '2026-11-02',
    approvalId: null,
    createdAt: '2026-11-02T10:00:00.000Z',
  };

  it('says a chargeback came from the provider, without approval, and comes off a settlement', () => {
    const summary = reversalSummary({ ...base, reason: 'chargeback' });
    expect(summary.byProvider).toBe(true);
    expect(summary.title).toBe('Reversed by a chargeback');
    expect(summary.lines[0]).toBe(
      'A chargeback: the payer disputed it with their bank or network, on 2 Nov 2026.',
    );
    expect(summary.lines[1]).toMatch(/comes off a later settlement/);
    expect(summary.lines[1]).toMatch(/managers were alerted/);
    expect(reversalSummary({ ...base, reason: 'provider_refund' }).title).toBe(
      'Refunded through the payment provider',
    );
  });

  it('says a person’s reversal was approved, why, and where the money was taken back from', () => {
    const summary = reversalSummary({
      ...base,
      reason: 'bounced_cheque',
      note: 'Returned by the bank',
      moneyNowIn: 'owner_account',
      approvalId: '019a3000-0000-7000-8000-0000000000c9',
    });
    expect(summary).toEqual({
      title: 'Reversed, with a second person’s approval',
      byProvider: false,
      lines: [
        'The cheque bounced, on 2 Nov 2026.',
        'Note: Returned by the bank',
        'Where the money was: in the owner’s own account. Its receipt stays, and a credit receipt was issued.',
      ],
    });
  });
});

describe('P31 refunding money that belongs to no lease', () => {
  it('takes the reason limits from the API’s contract', () => {
    expect(REFUND_REASON).toEqual({ min: 5, max: 500 });
  });

  it('needs a reason, and proof for a transfer refunded outside the provider', () => {
    expect(refundForm({ reason: ' no' }, { needsProof: false, hasProof: false })).toEqual({
      reason: null,
      errors: { reason: 'Say why, in at least 5 characters' },
    });
    expect(
      refundForm({ reason: 'Sent to the wrong landlord' }, { needsProof: true, hasProof: false })
        .errors.proof,
    ).toMatch(/proof/);
    expect(
      refundForm({ reason: '  Sent to the wrong landlord ' }, { needsProof: true, hasProof: true }),
    ).toEqual({ reason: 'Sent to the wrong landlord', errors: {} });
    expect(
      refundForm({ reason: 'x'.repeat(501) }, { needsProof: false, hasProof: false }).errors.reason,
    ).toBe('Use at most 500 characters');
  });
});

describe('BC-04 sending a pay link from staff screens', () => {
  it('offers a link only for an invoice that still asks for money', () => {
    expect(payLinkOffered({ status: 'issued', outstandingMinor: 1 })).toBe(true);
    expect(payLinkOffered({ status: 'part_paid', outstandingMinor: 50_000 })).toBe(true);
    expect(payLinkOffered({ status: 'paid', outstandingMinor: 0 })).toBe(false);
    expect(payLinkOffered({ status: 'voided', outstandingMinor: 50_000 })).toBe(false);
    expect(payLinkOffered({ status: 'written_off', outstandingMinor: 50_000 })).toBe(false);
  });

  it('offers the lease’s link before anyone tries, or says why it cannot go', () => {
    const invoiceId = '019a3000-0000-7000-8000-0000000000e4';
    expect(payLinkState({ available: true, reason: null, text: null, invoiceId })).toEqual({
      kind: 'send',
      invoiceId,
    });
    expect(
      payLinkState({
        available: false,
        reason: 'no_agreement',
        text: 'Choose where this owner’s rent goes before sending pay links',
        invoiceId,
      }),
    ).toEqual({
      kind: 'none',
      tone: 'warning',
      text: 'Choose where this owner’s rent goes before sending pay links.',
    });
    // Nothing due is information, not a problem; the words come from the API when it sends them.
    expect(
      payLinkState({ available: false, reason: 'nothing_due', text: null, invoiceId: null }),
    ).toEqual({ kind: 'none', tone: 'info', text: 'Nothing is left to pay on this lease now.' });
    for (const reason of PAY_LINK_PROBLEMS) expect(PAY_LINK_PROBLEM_LABELS[reason]).toBeTruthy();
  });

  it('says where the link went, or the API’s reason nothing went', () => {
    expect(channelsLabel(['sms', 'email'])).toBe('SMS and email');
    expect(payLinkOutcome({ channels: ['sms'], notSentReason: null })).toEqual({
      sent: true,
      text: 'Pay link sent by SMS. It works until the invoice is paid, or for 60 days.',
    });
    expect(
      payLinkOutcome({
        channels: [],
        notSentReason: 'Choose where this owner’s rent goes before sending pay links',
      }),
    ).toEqual({
      sent: false,
      text: 'No pay link was sent: choose where this owner’s rent goes before sending pay links.',
    });
    expect(payLinkOutcome({ channels: [], notSentReason: null }).sent).toBe(false);
  });
});

describe('BC-04 and plan 4.9 the landlord’s own payment instructions', () => {
  it('saves them trimmed, clears them when blank, and keeps to the API’s limit', () => {
    expect(MANUAL_INSTRUCTIONS_MAX).toBe(500);
    expect(
      manualInstructionsOf('  Pay by MoMo to 024 000 0000, reference on your invoice. '),
    ).toEqual({
      value: 'Pay by MoMo to 024 000 0000, reference on your invoice.',
      error: null,
    });
    expect(manualInstructionsOf('   ')).toEqual({ value: null, error: null });
    expect(manualInstructionsOf('x'.repeat(501)).error).toBe('Use at most 500 characters.');
  });
});

describe('BC-09 the reminder ladder in words', () => {
  it('reads the default ladder as the PRD says it', () => {
    expect(ladderWords([-7, 0, 3, 7, 14])).toBe(
      '7 days before the due date, on the due date, and 3, 7 and 14 days after it',
    );
  });

  it('orders and de-duplicates what was typed, and says one day', () => {
    expect(ladderWords([14, -1, 3, 3])).toBe(
      '1 day before the due date, and 3 and 14 days after it',
    );
    expect(ladderWords([0])).toBe('on the due date');
    expect(ladderWords([1])).toBe('1 day after the due date');
    expect(ladderWords([-14, -7])).toBe('14 and 7 days before the due date');
    expect(ladderWords([])).toBe('');
  });
});

describe('BC-02 and plan 4.8 reconciliation exceptions for a person', () => {
  const row = (overrides: Partial<ReconciliationException>): ReconciliationException => ({
    id: '019a3000-0000-7000-8000-000000000001',
    kind: 'missing_here',
    provider: 'paystack',
    reference: 'RP-1',
    settlementId: null,
    detail: 'Reported by the provider',
    amountMinor: 120_000,
    createdAt: '2026-11-02T02:00:00.000Z',
    resolvedAt: null,
    resolutionNote: null,
    ...overrides,
  });

  it('explains every kind the API reports, in plain words', () => {
    for (const words of Object.values(EXCEPTION_WORDS)) {
      expect(words.title).not.toMatch(/_/);
      expect(words.check.length).toBeGreaterThan(20);
    }
  });

  it('lists open ones oldest first, then resolved ones most recent first', () => {
    const rows = [
      row({ id: 'r-old', resolvedAt: '2026-11-01T10:00:00.000Z' }),
      row({ id: 'open-new', createdAt: '2026-11-03T02:00:00.000Z' }),
      row({ id: 'r-new', resolvedAt: '2026-11-02T10:00:00.000Z' }),
      row({ id: 'open-old', createdAt: '2026-11-01T02:00:00.000Z' }),
    ];
    expect(sortExceptions(rows).map((r) => r.id)).toEqual([
      'open-old',
      'open-new',
      'r-new',
      'r-old',
    ]);
  });

  it('takes the resolution note limits from the API’s contract', () => {
    expect(RESOLVE_NOTE).toEqual({ min: 5, max: 500 });
  });
});
