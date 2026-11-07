import { describe, expect, it } from 'vitest';
import { MOVE_OUT_REFUSAL_TEXT, moveOutRefusal } from './move-out';

// M8 review round: the API's new move-out refusals, each in plain words for its screen.

const refusal = (code: string, status = 409) => ({ status, data: { body: { code } } });

describe('TL-11 the move-out refusals are named in plain words', () => {
  it('recognises each code, as a guard or a handler sends it', () => {
    expect(moveOutRefusal(refusal('LEASE_ENDED_FIRST'))).toBe('lease_ended_first');
    expect(moveOutRefusal({ status: 409, code: 'DEPOSIT_CHARGED_BACK' })).toBe(
      'deposit_charged_back',
    );
    expect(moveOutRefusal(refusal('payment_deposit_settled'))).toBe('payment_deposit_settled');
    expect(moveOutRefusal(refusal('MOVE_OUT_LIVE'))).toBe('move_out_live');
    expect(moveOutRefusal(refusal('DEDUCTIONS_EXCEED_DEPOSIT'))).toBeNull();
    expect(moveOutRefusal(new TypeError('offline'))).toBeNull();
  });

  it('tells the person what to do next on each screen', () => {
    // Submit: cancel this move-out, then settle the deposit.
    expect(MOVE_OUT_REFUSAL_TEXT.lease_ended_first).toContain('Cancel this move-out');
    expect(MOVE_OUT_REFUSAL_TEXT.lease_ended_first).toContain('settle the deposit');
    // Refund paid: nothing recorded, and someone must look at it.
    expect(MOVE_OUT_REFUSAL_TEXT.deposit_charged_back).toMatch(/^Nothing was recorded\./);
    expect(MOVE_OUT_REFUSAL_TEXT.deposit_charged_back).toContain('charged back');
    expect(MOVE_OUT_REFUSAL_TEXT.deposit_charged_back).toContain('someone has looked at');
    // A payment reversal: the deposit was used by a move-out.
    expect(MOVE_OUT_REFUSAL_TEXT.payment_deposit_settled).toContain('cannot be reversed here');
    expect(MOVE_OUT_REFUSAL_TEXT.payment_deposit_settled).toContain('move-out has already used');
    // M3's quick move-out: the live move-out carries on.
    expect(MOVE_OUT_REFUSAL_TEXT.move_out_live).toContain('Open the move-out');
  });
});
