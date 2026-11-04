import { describe, expect, it } from 'vitest';
import { TAX_LIMITS } from './tax-limits';

describe('TX-03, TX-04 and AR-04 the tax forms read their limits from the API’s contract', () => {
  it('reads every limit the forms check', () => {
    expect(TAX_LIMITS).toEqual({
      graReceiptNumberMax: 80,
      noteMax: 500,
      certificateNumberMax: 80,
      refundReferenceMin: 2,
      refundReferenceMax: 120,
      descriptionMin: 2,
      descriptionMax: 120,
    });
  });
});

describe('TX-03 and TX-04 tax files are checked against the upload contract before sending', () => {
  it('takes a PDF or a photo up to the contract’s size', async () => {
    const { TAX_FILE_UPLOAD } = await import('./tax-upload');
    expect(TAX_FILE_UPLOAD).toEqual({
      types: ['image/jpeg', 'image/png', 'application/pdf'],
      maxBytes: 10_000_000,
    });
  });
});
