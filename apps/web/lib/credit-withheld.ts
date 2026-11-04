import { errorCode, statusOf, toProblem } from './errors';

// Decision 9 (M5): a credit note that would take back tax a tenant withheld is refused, and so is
// an early-termination settlement that would credit such a month. The API's words are shown as
// given: they say what to do ("Settle it by hand"), and nothing here rewords them.

/** The refusal's message as the API gave it, or null for any other answer. */
export function creditNoteWithheld(error: unknown): string | null {
  if (statusOf(error) !== 422 || errorCode(error) !== 'CREDIT_NOTE_WITHHELD') return null;
  return toProblem(error).message;
}
