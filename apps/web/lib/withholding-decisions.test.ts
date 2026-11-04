import { describe, expect, it } from 'vitest';
import { formLines, selfConfirmState, type OptionLine } from './withholding';

const month = (
  over: Partial<OptionLine> & Pick<OptionLine, 'lineId' | 'periodStart' | 'periodEnd'>,
): OptionLine => ({
  invoiceNumber: 'INV-000201',
  kind: 'rent',
  netMinor: 300_000,
  outstandingMinor: 300_000,
  suggestedMinor: 45_000,
  ...over,
});

describe('TX-04 decision 8 withholding on months not yet started is offered, held until each month starts', () => {
  it('offers the started months, then those not started yet, marked as such', () => {
    const lines = formLines({
      lines: [
        month({ lineId: 'nov', periodStart: '2026-11-01', periodEnd: '2026-11-30', started: true }),
      ],
      advanceLines: [
        month({
          lineId: 'dec',
          periodStart: '2026-12-01',
          periodEnd: '2026-12-31',
          started: false,
        }),
      ],
    });
    expect(lines.map((l) => [l.id, l.label, l.started])).toEqual([
      ['nov', 'Rent, 1 Nov 2026 to 30 Nov 2026', true],
      ['dec', 'Rent, 1 Dec 2026 to 31 Dec 2026', false],
    ]);
  });

  it('treats an answer without advance months as before', () => {
    expect(
      formLines({
        lines: [month({ lineId: 'nov', periodStart: '2026-11-01', periodEnd: '2026-11-30' })],
      }).map((l) => l.id),
    ).toEqual(['nov']);
  });
});

describe('TX-04 decision 7 a sole uploader confirms their own certificate after the cooling-off, with a code', () => {
  const uploader = 'akua';
  const certificate = (
    status: 'pending' | 'cooling_off' | 'approved' | 'rejected' | 'cancelled' | 'expired',
  ) => ({
    uploadedBy: uploader,
    selfConfirmation: { approvalId: 'appr-1', status, coolingOffUntil: '2026-11-04T10:00:00.000Z' },
  });
  const before = new Date('2026-11-04T09:59:00Z');
  const after = new Date('2026-11-04T10:00:00Z');

  it('waits until the cooling-off ends, then offers the confirmation through the request', () => {
    expect(selfConfirmState(certificate('cooling_off'), uploader, before)).toEqual({
      kind: 'waiting',
      approvalId: 'appr-1',
      until: '2026-11-04T10:00:00.000Z',
    });
    expect(selfConfirmState(certificate('cooling_off'), uploader, after)).toEqual({
      kind: 'ready',
      approvalId: 'appr-1',
    });
  });

  it('offers nothing to anyone but the uploader, nor without a request or once it is done', () => {
    expect(selfConfirmState(certificate('cooling_off'), 'someone-else', after)).toEqual({
      kind: 'none',
    });
    expect(
      selfConfirmState({ uploadedBy: uploader, selfConfirmation: null }, uploader, after),
    ).toEqual({
      kind: 'none',
    });
    expect(selfConfirmState({ uploadedBy: uploader }, uploader, after)).toEqual({ kind: 'none' });
    expect(selfConfirmState(certificate('approved'), uploader, after)).toEqual({ kind: 'none' });
  });

  it('says when the request closed without confirming it', () => {
    expect(selfConfirmState(certificate('expired'), uploader, after)).toEqual({
      kind: 'closed',
      status: 'expired',
    });
  });
});
