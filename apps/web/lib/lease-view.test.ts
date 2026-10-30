import type { LeaseDetailView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { COUNSEL_WARNING, otherWarnings, stillTracked, wasSigned } from './lease-view';

type Signing = LeaseDetailView['signing'];
const unsigned: Signing = {
  signedAt: null,
  method: null,
  signedOnPaper: false,
  signedDocument: false,
};
const onPaper: Signing = {
  signedAt: '2026-10-22T00:00:00.000Z',
  method: 'paper',
  signedOnPaper: true,
  signedDocument: true,
};
const electronically: Signing = {
  signedAt: '2026-10-29T11:05:00.000Z',
  method: 'esign',
  signedOnPaper: false,
  signedDocument: true,
};

const lease = (status: LeaseDetailView['status'], signing: Signing) => ({ status, signing });

describe('AD-05 and TL-06 a lease cancelled after signing keeps what signing made', () => {
  it('reads "it was signed" from the signing record, not the status', () => {
    expect(wasSigned(lease('draft', unsigned))).toBe(false);
    expect(wasSigned(lease('pending_signatures', unsigned))).toBe(false);
    expect(wasSigned(lease('signed', electronically))).toBe(true);
    expect(wasSigned(lease('active', onPaper))).toBe(true);
    expect(wasSigned(lease('ended', onPaper))).toBe(true);
    // Cancelled with approval before it started: its documents, schedule and trackers stay.
    expect(wasSigned(lease('cancelled', electronically))).toBe(true);
    expect(wasSigned(lease('cancelled', onPaper))).toBe(true);
    // A cancelled draft was never signed.
    expect(wasSigned(lease('cancelled', unsigned))).toBe(false);
  });

  it('stops tracking a lease that is no longer in force', () => {
    expect(stillTracked({ status: 'signed' })).toBe(true);
    expect(stillTracked({ status: 'active' })).toBe(true);
    expect(stillTracked({ status: 'ending' })).toBe(true);
    expect(stillTracked({ status: 'holding_over' })).toBe(true);
    expect(stillTracked({ status: 'ended' })).toBe(false);
    expect(stillTracked({ status: 'terminated' })).toBe(false);
    expect(stillTracked({ status: 'cancelled' })).toBe(false);
  });
});

describe('TL-05 the counsel-review warning shows once on a draft', () => {
  it('leaves out the preview’s copy of it, and keeps its other warnings', () => {
    expect(otherWarnings([COUNSEL_WARNING])).toEqual([]);
    expect(
      otherWarnings([
        'This template version has not been reviewed by your lawyer. Something new.',
        'A placeholder has no value yet.',
      ]),
    ).toEqual(['A placeholder has no value yet.']);
  });
});
