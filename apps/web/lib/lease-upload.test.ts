import { describe, expect, it } from 'vitest';
import {
  leasePaperProblems,
  NO_ID_COPY_NOTE,
  NO_ID_COPY_PROBLEM,
  NO_ID_COPY_TICK,
} from './lease-upload';
import { fileTypesLabel, LEASE_PAPER_UPLOAD, sizeLabel } from './upload';

const scan = { name: 'lease.pdf', type: 'application/pdf', size: 40_000 };

describe('decision 7 and CLAUDE.md section 10 lease papers carry no ID card copy', () => {
  it('says plainly that ID card and passport copies stay out, and asks for a tick', () => {
    expect(NO_ID_COPY_NOTE).toBe(
      'Leave out any copy of an ID card or passport. We must not store them.',
    );
    expect(NO_ID_COPY_TICK).toBe('This file has no ID card or passport copy');
  });

  it('accepts a lease paper only once the tick confirms it has no ID copy', () => {
    expect(
      leasePaperProblems(scan, { noIdCopy: false, missing: 'Upload the signed lease.' }),
    ).toEqual({ file: null, tick: NO_ID_COPY_PROBLEM });
    expect(
      leasePaperProblems(scan, { noIdCopy: true, missing: 'Upload the signed lease.' }),
    ).toEqual({ file: null, tick: null });
  });

  it('asks for the file first when one is needed, and checks nothing when it is optional', () => {
    expect(
      leasePaperProblems(undefined, { noIdCopy: false, missing: 'Choose the stamped copy.' }),
    ).toEqual({ file: 'Choose the stamped copy.', tick: null });
    // The formal lease's wet-signed copy is optional.
    expect(leasePaperProblems(undefined, { noIdCopy: false })).toEqual({ file: null, tick: null });
  });

  it('refuses a wrong type or size before anything is sent', () => {
    expect(leasePaperProblems({ ...scan, type: 'image/gif' }, { noIdCopy: true }).file).toBe(
      'Choose a PDF, JPEG or PNG file.',
    );
    expect(
      leasePaperProblems({ ...scan, size: LEASE_PAPER_UPLOAD.maxBytes + 1 }, { noIdCopy: true })
        .file,
    ).toBe('The file must be 20 MB or smaller.');
  });
});

describe('decision 7, OQ-44 and OQ-45 lease-paper limits come from the upload contract', () => {
  it('takes the types and the size limit that POST /lease-uploads accepts', () => {
    expect(LEASE_PAPER_UPLOAD.types).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    expect(LEASE_PAPER_UPLOAD.maxBytes).toBe(20_000_000);
    expect(fileTypesLabel(LEASE_PAPER_UPLOAD)).toBe('PDF, JPEG or PNG');
    expect(sizeLabel(LEASE_PAPER_UPLOAD.maxBytes)).toBe('20 MB');
  });
});
