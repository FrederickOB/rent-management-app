import { describe, expect, it } from 'vitest';
import {
  certificateEffect,
  certificateForm,
  emptyWithholding,
  rateNote,
  suggestedInput,
  withholdingForm,
  withholdingMoves,
  withholdingWriteOffForm,
  withholdableLines,
  withholdingRate,
  type InvoiceLineFacts,
  type RuleRowFacts,
  type WithholdableLine,
  type WithholdingMovesInput,
} from './withholding';

/** Worked example B (docs/architecture.md): GH₵10,000 commercial rent, 15% withheld. */
const rent: WithholdableLine = {
  id: 'line-rent',
  invoiceNumber: 'INV-000201',
  label: 'Rent, 1 Nov 2026 to 30 Nov 2026',
  netMinor: 1_000_000,
  outstandingMinor: 1_000_000,
};
const service: WithholdableLine = {
  id: 'line-service',
  invoiceNumber: 'INV-000201',
  label: 'Service charge, 1 Nov 2026 to 30 Nov 2026',
  netMinor: 200_000,
  outstandingMinor: 50_000,
};
const today = '2026-11-05';

describe('TX-04 withholding is recorded against the lines it was withheld on', () => {
  it('records worked example B: GH₵1,500 withheld on the rent line', () => {
    const parsed = withholdingForm(
      { ...emptyWithholding(today), amounts: { [rent.id]: '1,500' } },
      [rent, service],
      1500,
      today,
    );
    expect(parsed.input).toEqual({
      valueDate: today,
      note: null,
      lines: [{ lineId: rent.id, amountMinor: 150_000 }],
    });
    expect(parsed.totalMinor).toBe(150_000);
    expect(parsed.differsFromRate).toEqual([]);
  });

  it('accepts an amount that is not the rate, and says which line to check', () => {
    const parsed = withholdingForm(
      { ...emptyWithholding(today), amounts: { [rent.id]: '1000', [service.id]: '300' } },
      [rent, service],
      1500,
      today,
    );
    expect(parsed.input?.lines).toEqual([
      { lineId: rent.id, amountMinor: 100_000 },
      { lineId: service.id, amountMinor: 30_000 },
    ]);
    expect(parsed.differsFromRate).toEqual([rent.id]);
    expect(rateNote(rent, 1500)).toBe(
      '15% of GH₵10,000.00 is GH₵1,500.00. Check the amount against the tenant’s advice or certificate.',
    );
  });

  it('never takes more than a line still owes, nor nothing at all', () => {
    const tooMuch = withholdingForm(
      { ...emptyWithholding(today), amounts: { [service.id]: '600' } },
      [rent, service],
      1500,
      today,
    );
    expect(tooMuch.input).toBeNull();
    expect(tooMuch.errors[`line:${service.id}`]).toBe(
      'At most GH₵500.00, what is still owed on this line',
    );
    const none = withholdingForm(emptyWithholding(today), [rent, service], 1500, today);
    expect(none.errors).toEqual({ lines: 'Enter the amount withheld on at least one line' });
    const zero = withholdingForm(
      { ...emptyWithholding(today), amounts: { [rent.id]: '0' } },
      [rent],
      1500,
      today,
    );
    expect(zero.errors[`line:${rent.id}`]).toBe('Enter an amount above zero');
  });

  it('refuses a future date and a line that is no longer on the form', () => {
    const parsed = withholdingForm(
      { amounts: { gone: '10', [rent.id]: '10' }, valueDate: '2026-11-06', note: '' },
      [rent],
      null,
      today,
    );
    expect(parsed.errors).toEqual({
      lines: 'A line has changed since the form opened. Reload the page.',
      valueDate: 'The date cannot be in the future',
    });
  });

  it('suggests the rate on a line, never more than it still owes', () => {
    expect(suggestedInput(rent, 1500)).toBe('1500.00');
    expect(suggestedInput(service, 1500)).toBe('300.00');
    expect(suggestedInput({ ...service, outstandingMinor: 10_000 }, 1500)).toBe('100.00');
  });

  it('says what a confirmed certificate did for the owner, by its account (decision 2)', () => {
    expect(certificateEffect('2200')).toContain('settles the owner’s rent tax');
    expect(certificateEffect('1160')).toContain('tax credit');
    expect(certificateEffect(null)).toBeNull();
  });
});

describe('TX-04 a certificate is confirmed by a landlord user, never the person who uploaded it (decision 3)', () => {
  const can = { upload: true, confirm: true, writeOff: true };
  const uploaded: WithholdingMovesInput = {
    status: 'certificate_uploaded',
    certificateUploadedBy: 'manager',
    mayConfirm: true,
    openWriteOffApprovalId: null,
  };

  it('offers the uploader no confirmation, and says why', () => {
    expect(withholdingMoves(uploaded, 'manager', can)).toEqual({
      // One certificate is live at a time: a wrong one is rejected before another is uploaded.
      upload: false,
      confirm: false,
      confirmBlocked: 'You uploaded this certificate, so another landlord user must confirm it.',
      writeOff: true,
    });
  });

  it('offers a landlord user the confirmation', () => {
    expect(withholdingMoves(uploaded, 'owner-user', can)).toMatchObject({
      upload: false,
      confirm: true,
      confirmBlocked: null,
    });
  });

  it('offers nobody the confirmation when the API or the policy says no', () => {
    expect(withholdingMoves({ ...uploaded, mayConfirm: false }, 'other-manager', can).confirm).toBe(
      false,
    );
    expect(
      withholdingMoves(uploaded, 'other-manager', { ...can, confirm: false }).confirmBlocked,
    ).toBe(
      'A user for the owner confirms the certificate, or an agency admin where the owner has none.',
    );
  });

  it('asks for the certificate first, and offers a write-off only once', () => {
    const waiting: WithholdingMovesInput = {
      status: 'awaiting_certificate',
      certificateUploadedBy: null,
      openWriteOffApprovalId: null,
    };
    expect(withholdingMoves(waiting, 'manager', can)).toEqual({
      upload: true,
      confirm: false,
      confirmBlocked: null,
      writeOff: true,
    });
    expect(
      withholdingMoves({ ...waiting, openWriteOffApprovalId: 'approval' }, 'manager', can).writeOff,
    ).toBe(false);
  });

  it('offers nothing once confirmed or written off', () => {
    for (const status of ['certified', 'written_off'] as const)
      expect(withholdingMoves({ ...uploaded, status }, 'owner-user', can)).toEqual({
        upload: false,
        confirm: false,
        confirmBlocked: null,
        writeOff: false,
      });
  });

  it('takes the certificate’s number and date when given', () => {
    expect(certificateForm({ certificateNumber: ' WHT/2026/88 ', issuedOn: '' }, today)).toEqual({
      input: { certificateNumber: 'WHT/2026/88', issuedOn: null },
      errors: {},
    });
    expect(
      certificateForm({ certificateNumber: '', issuedOn: '2026-12-01' }, today).errors,
    ).toEqual({ issuedOn: 'The date cannot be in the future' });
  });

  it('writes off a certificate that never came only with a reason (P24)', () => {
    expect(withholdingWriteOffForm('no').errors).toEqual({
      reason: 'Give a reason of at least 5 characters',
    });
    expect(withholdingWriteOffForm(' The tenant closed its office ').input).toEqual({
      reason: 'The tenant closed its office',
    });
  });
});

describe('TX-04 the lines withholding may be recorded on, and the rate it is compared with', () => {
  const line = (over: Partial<InvoiceLineFacts>): InvoiceLineFacts => ({
    id: 'l',
    kind: 'rent',
    label: 'Rent, 1 Nov 2026 to 30 Nov 2026',
    netMinor: 1_000_000,
    outstandingMinor: 1_000_000,
    accrued: true,
    ...over,
  });

  it('offers rent and service charge of months that have started, still owed', () => {
    expect(
      withholdableLines([
        {
          number: 'INV-000201',
          lines: [
            line({ id: 'rent' }),
            line({ id: 'service', kind: 'service_charge', label: 'Service charge' }),
            line({ id: 'vat', kind: 'vat', label: 'VAT' }),
            line({ id: 'future', accrued: false }),
            line({ id: 'paid', outstandingMinor: 0 }),
          ],
        },
        { number: 'INV-000150', lines: [line({ id: 'deposit', kind: 'deposit' })] },
      ]).map((l) => `${l.invoiceNumber} ${l.id}`),
    ).toEqual(['INV-000201 rent', 'INV-000201 service']);
  });

  it('reads the rate for the lease’s use from the rules table', () => {
    const rules: RuleRowFacts[] = [
      {
        key: 'withholding_tax.rate.commercial',
        value: { bps: 1500 },
        verificationStatus: 'unverified',
        warning: true,
      },
      {
        key: 'withholding_tax.rate.residential',
        value: { bps: 800 },
        verificationStatus: 'unverified',
        warning: true,
      },
    ];
    expect(withholdingRate(rules, 'commercial')?.rateBps).toBe(1500);
    expect(withholdingRate(rules, 'residential')?.rateBps).toBe(800);
    expect(withholdingRate([], 'commercial')).toBeNull();
    expect(withholdingRate([{ ...rules[0]!, value: { bps: 'fifteen' } }], 'commercial')).toBeNull();
  });
});
