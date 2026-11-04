import { describe, expect, it } from 'vitest';
import { waitingNote } from './money-requests';

describe('BC-05, decision 3 and decision 7 money waits for a second person', () => {
  it('tells the person who asked that a second person approves it', () => {
    expect(waitingNote({ mode: 'two_person', coolingOffUntil: null }, 'Africa/Accra')).toBe(
      'A second person must approve it before it takes effect.',
    );
  });

  it('tells a landlord who works alone when they can confirm it themselves, naming the time zone', () => {
    const note = waitingNote(
      { mode: 'single_user', coolingOffUntil: '2026-10-31T09:30:00.000Z' },
      'Africa/Accra',
    );
    expect(note).toContain('Nobody else in your company can approve it');
    expect(note).toContain('31 Oct 2026, 09:30 GMT (Africa/Accra)');
    expect(note).toContain('A nominated second approver removes the wait.');
  });
});
