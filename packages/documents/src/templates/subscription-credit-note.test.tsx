import { describe, expect, it } from 'vitest';
import { renderHtml, templates } from './index';
import { subscriptionCreditNoteV1, type SubscriptionCreditNoteDocumentData } from './subscription';
import { sampleBranding } from './test-fixtures';

const platform = { ...sampleBranding, senderName: 'Rent Platform' };

const note: SubscriptionCreditNoteDocumentData = {
  platformName: 'Rent Platform',
  subscriberName: 'Osu Ridge Property Managers',
  number: 'SUBC-2026-000001',
  issuedOn: '2026-11-09',
  invoiceNumber: 'SUB-2026-000012',
  netMinor: 10_000,
  vatMinor: 2_000,
  amountMinor: 12_000,
  toCreditMinor: 4_000,
  reason: 'Units billed twice in October',
};

describe('BE-6 the subscription credit note PDF (founder answer Q2)', () => {
  it('is registered, and shows its number, invoice, reason, amounts and the credit held', () => {
    expect(templates.get('subscription.credit-note', 1)).toBeTruthy();
    const html = renderHtml(subscriptionCreditNoteV1, note, platform);
    for (const text of [
      'Credit note',
      'SUBC-2026-000001',
      'SUB-2026-000012',
      'Units billed twice in October',
      'GH₵100.00',
      'GH₵20.00',
      'GH₵120.00',
      'held as prepaid credit',
    ])
      expect(html).toContain(text);
  });

  it('refuses data that does not fit the schema', () => {
    expect(() => subscriptionCreditNoteV1.element({ ...note, amountMinor: 0 }, platform)).toThrow();
  });
});
