import { describe, expect, it } from 'vitest';
import { creditNoteWithheld } from './credit-withheld';
import { moneyProblem } from './idempotency';

const MESSAGE =
  'This month has tax the tenant withheld; a credit note cannot take that back. Settle it by hand.';
/** The refusal as the typed client throws it. */
const refusal = { status: 422, code: 'CREDIT_NOTE_WITHHELD', message: MESSAGE };

describe('TX-04 decision 9 a credit note on withheld tax is refused with the API’s own words', () => {
  it('reads the refusal and gives its message as given', () => {
    expect(creditNoteWithheld(refusal)).toBe(MESSAGE);
    expect(creditNoteWithheld({ status: 409, code: 'NOT_ENDED_EARLY', message: 'x' })).toBeNull();
    expect(creditNoteWithheld(new TypeError('offline'))).toBeNull();
  });

  it('shows the same words on the credit note form, which says nothing about sending it again', () => {
    expect(moneyProblem(refusal)).toBe(MESSAGE);
  });
});
