import { describe, expect, it } from 'vitest';
import { formatValue, summarise } from './audit-summary';

describe('AD-07 audit summary', () => {
  it('lists only the fields a row change touched, with before and after', () => {
    const summary = summarise({
      before: {
        id: 'c1',
        sender_name: 'Osu Ridge',
        primary_colour: '#0F766E',
        display_name: 'Osu',
        updated_at: '2026-10-28T10:00:00Z',
      },
      after: {
        id: 'c1',
        sender_name: 'Osu Ridge PM',
        primary_colour: '#123456',
        display_name: 'Osu',
        updated_at: '2026-10-28T11:00:00Z',
      },
    });
    expect(summary.kind).toBe('changed');
    expect(summary.changes).toEqual([
      { field: 'Sender name', before: 'Osu Ridge', after: 'Osu Ridge PM' },
      { field: 'Primary colour', before: '#0F766E', after: '#123456' },
    ]);
  });

  it('compares nested settings key by key', () => {
    const summary = summarise({
      before: { settings: { advanceRentPolicy: 'off', renewalReminderDays: [90, 60, 30] } },
      after: { settings: { advanceRentPolicy: 'warn', renewalReminderDays: [90, 60, 30] } },
    });
    expect(summary.changes).toEqual([
      { field: 'Settings: Advance rent over the limit', before: 'off', after: 'warn' },
    ]);
  });

  it('shows a role change in words and keeps redacted columns hidden', () => {
    const summary = summarise({
      before: { role: 'property_manager', nominated_approver: false },
      after: { role: 'accountant', nominated_approver: true },
      redacted_changed: ['secret_column'],
    });
    expect(summary.changes).toEqual([
      { field: 'Role', before: 'Property manager', after: 'Accountant' },
      { field: 'Nominated approver', before: 'No', after: 'Yes' },
      { field: 'Secret column', before: '(hidden)', after: '(hidden)' },
    ]);
  });

  it('describes a new row without its bookkeeping columns', () => {
    const summary = summarise({
      after: {
        id: 'm1',
        company_id: 'c1',
        role: 'caretaker',
        scope: {},
        created_at: 'x',
        updated_at: 'x',
      },
    });
    expect(summary.kind).toBe('created');
    expect(summary.changes).toEqual([
      { field: 'Role', before: null, after: 'Caretaker' },
      { field: 'Scope', before: null, after: '(none)' },
    ]);
  });

  it('shows a service event payload as details', () => {
    expect(summarise({ authMethod: 'password_totp' })).toEqual({
      kind: 'details',
      changes: [
        { field: 'Sign-in method', before: null, after: 'Password and authenticator code' },
      ],
    });
    expect(summarise(null)).toEqual({ kind: 'none', changes: [] });
    expect(summarise({})).toEqual({ kind: 'none', changes: [] });
  });

  it('never shows an empty value', () => {
    expect(formatValue(null)).toBe('(none)');
    expect(formatValue('')).toBe('(empty)');
    expect(formatValue([])).toBe('(none)');
    expect(formatValue([-7, 0, 3])).toBe('-7, 0, 3');
  });
});
