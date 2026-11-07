import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import { noticeStatement } from '../src/signing-items';

// M7 review round (LT 1): the statement that signing acknowledges receipt never goes missing.

const notice = {
  noticeId: '0193a7c0-0000-7000-8000-00000000f001',
  number: 'N-000007',
  typeLabel: 'Notice of entry',
  issuedAt: '2026-11-04T09:00:00.000Z',
  effectiveDate: null,
  statement: 'Signing acknowledges receipt only.',
};

describe('LN-04 the statement on a notice to acknowledge', () => {
  it('is the API’s, or the domain’s own words when the API sends none', () => {
    expect(noticeStatement(notice)).toBe('Signing acknowledges receipt only.');
    expect(noticeStatement({ ...notice, statement: '' })).toBe(NOTICE_SIGNING_STATEMENT);
    expect(noticeStatement({ ...notice, statement: '   ' })).toBe(NOTICE_SIGNING_STATEMENT);
  });
});
