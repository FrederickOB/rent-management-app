import type { FinalStatementView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { needsReceiptFlag, NO_RECEIPT } from './expenses';
import { warnOnLeave, type PageEvents } from './in-flight';
import { submitReadiness } from './inspections';
import { emergencyAlertText } from './maintenance';
import { checkStatement, settlementBlock, settlementVerdict } from './move-out';

// M8 review round: new tests beside the earlier ones, which stay as they passed.

const BASE: FinalStatementView = {
  lastDay: '2026-11-30',
  early: false,
  depositHeldMinor: 50_000,
  creditMinor: 0,
  arrearsMinor: 0,
  chargesMinor: 0,
  breakCreditMinor: 0,
  creditToArrears: [],
  depositToArrears: [],
  deductionsMinor: 0,
  retainedMinor: 0,
  deductionsChargedMinor: 0,
  creditAppliedMinor: 0,
  depositAppliedMinor: 0,
  creditRefundMinor: 0,
  depositRefundMinor: 50_000,
  refundMinor: 50_000,
  stillOwedMinor: 0,
};

const line = (amountMinor: number) => ({
  lineId: '019a3000-0000-7000-8000-0000000000f1',
  invoiceNumber: 'INV-9',
  label: 'One-off charge',
  periodStart: null,
  periodEnd: null,
  amountMinor,
});

describe('TL-11 review BE 1 and WEB 7 the statement is checked with the domain’s identities', () => {
  it('balances with charges inside arrears, never adding them in again (the reviewer’s first case)', () => {
    // Deposit 50,000 kept for a 50,000 deduction; a 20,000 charge for damage beyond it stays owed.
    const statement: FinalStatementView = {
      ...BASE,
      arrearsMinor: 20_000,
      chargesMinor: 20_000,
      deductionsMinor: 50_000,
      retainedMinor: 50_000,
      depositRefundMinor: 0,
      refundMinor: 0,
      stillOwedMinor: 20_000,
    };
    expect(checkStatement(statement)).toEqual({
      balances: true,
      inMinor: 50_000,
      outMinor: 50_000,
      owedMinor: 20_000,
      settledMinor: 20_000,
    });
  });

  it('balances with the break credit inside credit (the reviewer’s second case)', () => {
    // A 66,667 unused-days credit and a 200,000 deposit: nothing owed, everything refunded.
    const statement: FinalStatementView = {
      ...BASE,
      early: true,
      depositHeldMinor: 200_000,
      creditMinor: 66_667,
      breakCreditMinor: 66_667,
      creditRefundMinor: 66_667,
      depositRefundMinor: 200_000,
      refundMinor: 266_667,
    };
    expect(checkStatement(statement).balances).toBe(true);
    // The old reading, with the break credit counted again on one side, does not balance.
    expect(checkStatement({ ...statement, creditMinor: 0 }).balances).toBe(false);
  });

  it('balances with both, and the deposit applied to arrears line by line', () => {
    const statement: FinalStatementView = {
      ...BASE,
      early: true,
      depositHeldMinor: 100_000,
      creditMinor: 10_000,
      arrearsMinor: 60_000,
      chargesMinor: 30_000,
      breakCreditMinor: 10_000,
      creditToArrears: [line(10_000)],
      depositToArrears: [line(50_000)],
      deductionsMinor: 20_000,
      retainedMinor: 20_000,
      creditAppliedMinor: 10_000,
      depositAppliedMinor: 50_000,
      depositRefundMinor: 30_000,
      refundMinor: 30_000,
    };
    expect(checkStatement(statement).balances).toBe(true);
    expect(checkStatement({ ...statement, retainedMinor: 120_000 }).balances).toBe(false);
  });
});

describe('TL-11 review WEB 4 a settlement is approved only on a loaded, balancing statement', () => {
  const detail = { statement: BASE, approvalFiguresHold: true };

  it('holds Approve while loading, failed, missing, stale or not balancing', () => {
    expect(settlementVerdict(null)).toBe('loading');
    expect(settlementVerdict(null, true)).toBe('failed');
    expect(settlementVerdict({ ...detail, statement: null })).toBe('unavailable');
    expect(settlementVerdict({ ...detail, approvalFiguresHold: false })).toBe('stale');
    expect(settlementVerdict({ ...detail, statement: { ...BASE, refundMinor: 1 } })).toBe(
      'unbalanced',
    );
    for (const verdict of ['loading', 'failed', 'unavailable', 'stale', 'unbalanced'] as const)
      expect(settlementBlock(verdict)).not.toBeNull();
  });

  it('lets it be approved once it balances and the figures still hold', () => {
    expect(settlementVerdict(detail)).toBe('balances');
    expect(settlementVerdict({ ...detail, approvalFiguresHold: null })).toBe('balances');
    expect(settlementBlock('balances')).toBeNull();
  });
});

describe('MI-10 review WEB 2 Submit waits for chosen photos and saves on a phone', () => {
  const items = [{ condition: 'good' as const }, { condition: 'fair' as const }];

  it('holds a complete inspection while a photo is chosen and not added, or an item is saving', () => {
    expect(submitReadiness(items, { unsentPhotos: 1, saving: 0 })).toEqual({
      ready: false,
      left: 0,
      text: '1 chosen photo has not been added yet: add or remove it first.',
    });
    expect(submitReadiness(items, { unsentPhotos: 2, saving: 1 }).text).toBe(
      '2 chosen photos have not been added yet: add or remove them first. Wait until everything is saved.',
    );
    expect(submitReadiness(items, { unsentPhotos: 0, saving: 0 }).ready).toBe(true);
  });

  it('keeps saying which items need a condition first', () => {
    expect(
      submitReadiness([{ condition: null }, { condition: 'good' }], { unsentPhotos: 1, saving: 0 })
        .text,
    ).toBe(
      '1 item still needs a condition before it can be submitted. 1 chosen photo has not been added yet: add or remove it first.',
    );
  });
});

type Listener = (event: Event) => void;
function target(): PageEvents & { readonly listeners: Map<string, Listener[]> } {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
  };
}
function click(onLink: boolean) {
  const state = { prevented: false };
  const fake = {
    target: { closest: () => (onLink ? {} : null) },
    preventDefault: () => {
      state.prevented = true;
    },
    stopPropagation: () => undefined,
  } as unknown as Event;
  return { fake, state };
}

describe('MI-10 review WEB 2 leaving with photos not yet added asks first', () => {
  it('asks the browser on closing, and asks before following a link', () => {
    const win = target();
    const doc = target();
    let answer = false;
    const release = warnOnLeave(win, doc, () => answer);
    const unload = { preventDefault: () => undefined, returnValue: 'x' } as unknown as Event;
    win.listeners.get('beforeunload')![0]!(unload);
    expect((unload as unknown as { returnValue: string }).returnValue).toBe('');

    const stay = click(true);
    doc.listeners.get('click')![0]!(stay.fake);
    expect(stay.state.prevented).toBe(true);
    answer = true;
    const leave = click(true);
    doc.listeners.get('click')![0]!(leave.fake);
    expect(leave.state.prevented).toBe(false);
    const elsewhere = click(false);
    doc.listeners.get('click')![0]!(elsewhere.fake);
    expect(elsewhere.state.prevented).toBe(false);

    release();
    expect(win.listeners.get('beforeunload')).toEqual([]);
    expect(doc.listeners.get('click')).toEqual([]);
  });
});

describe('MI-02 review WEB 7 the emergency banner names only what was sent', () => {
  it('lists who was alerted and on which channels, from the timeline', () => {
    expect(emergencyAlertText([])).toBe('No emergency alert has been recorded on this job yet.');
    expect(
      emergencyAlertText([
        { kind: 'alerted', data: { channels: ['sms'], recipientName: 'Kojo (demo)' } },
        { kind: 'alerted', data: { channels: ['sms', 'whatsapp'], recipientName: 'Kofi (demo)' } },
        { kind: 'note', data: { note: 'x' } },
      ]),
    ).toBe('Alerted: Kojo (demo), Kofi (demo), by WhatsApp and SMS.');
    expect(emergencyAlertText([{ kind: 'alerted', data: { channels: ['sms'] } }])).toBe(
      'Alerted: 1 person, by SMS.',
    );
  });
});

describe('AC-03 F3 an expense without a receipt is flagged', () => {
  it('follows the API’s flag, and leaves reversed expenses unflagged', () => {
    expect(NO_RECEIPT).toBe('No receipt');
    expect(needsReceiptFlag({ noReceipt: true, status: 'unpaid' })).toBe(true);
    expect(needsReceiptFlag({ noReceipt: false, status: 'paid' })).toBe(false);
    expect(needsReceiptFlag({ noReceipt: true, status: 'reversed' })).toBe(false);
  });
});
