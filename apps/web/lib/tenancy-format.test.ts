import { describe, expect, it } from 'vitest';
import {
  daysLeftLabel,
  endedLabel,
  formatMinor,
  rentLabel,
  ruleNote,
  termLabel,
  timelineDetail,
  timelineLabel,
} from './tenancy-format';

describe('TL-06 lease amounts and dates on screen', () => {
  it('formats integer pesewas as cedis only at the edge', () => {
    expect(formatMinor(150_000)).toBe('GH₵1,500.00');
    expect(formatMinor(5)).toBe('GH₵0.05');
    expect(formatMinor(null)).toBe('None');
    expect(rentLabel(80_000, 'quarterly')).toBe('GH₵800.00 a month, billed quarterly');
  });

  it('names the term and the days left', () => {
    expect(termLabel('2026-11-01', '2027-10-31')).toBe('1 Nov 2026 to 31 Oct 2027');
    expect(daysLeftLabel(60)).toBe('in 60 days');
    expect(daysLeftLabel(1)).toBe('tomorrow');
    expect(daysLeftLabel(0)).toBe('today');
    expect(daysLeftLabel(-3)).toBe('3 days ago');
  });
});

describe('TX-05, OQ-44 and OQ-45 unverified rules are shown as unverified', () => {
  const rule = {
    ruleId: '019a3000-0000-7000-8000-0000000000f1',
    source: 'Stamp Duty Act s.12; counsel to confirm (OQ-45)',
    warning: true,
  };

  it('warns where a deadline rests on a rule counsel has not verified', () => {
    const note = ruleNote({ ...rule, verificationStatus: 'unverified' });
    expect(note.warn).toBe(true);
    expect(note.text).toContain('not yet verified');
    expect(note.text).toContain('Stamp Duty Act s.12');
    expect(ruleNote({ ...rule, verificationStatus: 'from_prd' }).warn).toBe(true);
  });

  it('does not warn about a verified rule, and says when no rule exists', () => {
    expect(ruleNote({ ...rule, verificationStatus: 'verified', warning: false }).warn).toBe(false);
    expect(ruleNote(null)).toMatchObject({ warn: true });
  });
});

describe('TL-01 tenant timeline', () => {
  it('names audit and service events in words', () => {
    expect(timelineLabel('tenant.insert')).toBe('Tenant added');
    expect(timelineLabel('consent_event.insert')).toBe('Consent recorded');
    expect(timelineLabel('id_number.revealed')).toBe('ID number shown');
    expect(timelineLabel('tenant_contact.update')).toBe('Contact changed');
    expect(timelineLabel('lease.something_new')).toBe('Lease: Something new');
  });

  it('says what consent was recorded, why a number was shown, and what changed', () => {
    expect(
      timelineDetail('consent_event.insert', { after: { channel: 'sms', action: 'grant' } }),
    ).toBe('SMS: agreed to messages');
    expect(
      timelineDetail('consent_event.insert', { after: { channel: 'email', action: 'withdraw' } }),
    ).toBe('Email: withdrew consent');
    expect(timelineDetail('id_number.revealed', { reason: 'Checking the lease ID' })).toBe(
      'Reason: Checking the lease ID',
    );
    expect(
      timelineDetail('lease.update', {
        before: { status: 'signed', updated_at: 'a', notice_days: 30 },
        after: { status: 'active', updated_at: 'b', notice_days: 60 },
      }),
    ).toBe('Status: Signed → Active. Changed: Notice days');
    expect(timelineDetail('tenant.update', { before: { updated_at: 'a' }, after: {} })).toBeNull();
  });
});

describe('TL-06 and TL-09 how a lease ended', () => {
  it('says why a lease ended when it was not a move-out', () => {
    expect(endedLabel('2027-10-31', 'moved_out')).toBe('31 Oct 2027');
    expect(endedLabel('2027-10-31', 'renewed')).toBe('31 Oct 2027, renewed');
    expect(endedLabel('2027-10-31', 'superseded')).toBe(
      '31 Oct 2027, when the next lease on the unit started',
    );
    expect(endedLabel('2027-10-31', null)).toBe('31 Oct 2027');
  });
});
