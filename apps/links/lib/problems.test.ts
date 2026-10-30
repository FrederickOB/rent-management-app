import { describe, expect, it } from 'vitest';
import { problemText } from './problems';

describe('TL-07 a signing page explains a failed action', () => {
  it('words the API’s code, with the tries left', () => {
    expect(problemText({})).toBeNull();
    expect(problemText({ error: 'CODE_WRONG', left: '2' })).toBe(
      'That code is not right. You have 2 tries left.',
    );
    expect(problemText({ error: 'CODE_WRONG', left: '1' })).toBe(
      'That code is not right. You have 1 try left.',
    );
  });

  it('never reads a code the page does not know from what objects inherit', () => {
    const fallback = 'Something went wrong on our side. Try again in a minute.';
    for (const error of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'NOT_A_CODE'])
      expect(problemText({ error })).toBe(fallback);
  });
});
