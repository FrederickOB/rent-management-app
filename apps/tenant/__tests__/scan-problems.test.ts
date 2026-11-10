import { toProblem } from '../src/problems';

// NFR-SEC (M11 decision 6): a repair photo, a message attachment or a tenancy document is served
// only once its virus scan is clean. The API says why it is not, and the app says it plainly.

const refusal = (status: number, code: string) =>
  Object.assign(new Error('Refused'), { status, code, defined: false });

describe('NFR-SEC files being scanned, or refused by the scan', () => {
  it('a file still being checked, and one that failed the check, in plain words', () => {
    expect(toProblem(refusal(409, 'DOCUMENT_SCAN_PENDING'))).toEqual({
      status: 409,
      code: 'DOCUMENT_SCAN_PENDING',
      message: 'This file is still being checked for viruses. Try again in a minute.',
    });
    expect(toProblem(refusal(410, 'DOCUMENT_QUARANTINED'))).toEqual({
      status: 410,
      code: 'DOCUMENT_QUARANTINED',
      message: 'This file failed the virus check, so it cannot be opened.',
    });
    // Anything else keeps the API's own words.
    expect(toProblem(refusal(409, 'NOT_AWAITING')).message).toBe('Refused');
  });
});
