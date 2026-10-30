import { describe, expect, it } from 'vitest';
import { checkSignature, signingComplete } from '../esign/signing';
import { deadlineAfter, dueReminderSteps, dueRenewalReminders, endsWithin } from './deadlines';
import {
  checkGhanaCard,
  checkIdNumber,
  checkPassport,
  checkTin,
  maskIdNumber,
} from './identity-numbers';
import { checkTemplateContent, fillPlaceholders, type TemplateContent } from './templates';

describe('TL-02 ID numbers', () => {
  it('normalises Ghana Card numbers and masks them by default', () => {
    expect(checkGhanaCard('gha 123456789 0')).toBe('GHA-123456789-0');
    expect(checkGhanaCard('GHA-123456789-0')).toBe('GHA-123456789-0');
    expect(() => checkGhanaCard('GHA-12345-0')).toThrow(/Ghana Card/);
    expect(maskIdNumber('GHA-123456789-0')).toBe('GHA-*******89-0');
  });

  it('records passports with their issuing country, and TINs', () => {
    expect(checkPassport('a1234 567', 'ng')).toEqual({ number: 'A1234567', country: 'NG' });
    expect(() => checkPassport('A1', 'NG')).toThrow(/passport/);
    expect(checkIdNumber('ghana_card', 'GHA1234567890')).toEqual({
      number: 'GHA-123456789-0',
      country: 'GH',
    });
    expect(checkTin('gha123456789-0')).toBe('GHA-123456789-0');
    expect(checkTin('c0012345678')).toBe('C0012345678');
    expect(maskIdNumber('C0012345678')).toBe('*******5678');
  });
});

describe('TL-09 and TX-05 deadlines and reminders', () => {
  it('computes deadlines from the rules table periods', () => {
    expect(deadlineAfter('2026-11-01', { days: 14 })).toBe('2026-11-15');
    expect(deadlineAfter('2026-12-31', { months: 2 })).toBe('2027-02-28');
  });

  it('gives each reminder step a stable key, then weekly steps after the deadline', () => {
    const steps = dueReminderSteps('2026-11-15', [7, 2, 0], '2026-11-29');
    expect(steps.map((s) => s.key)).toEqual([
      'before-7',
      'before-2',
      'before-0',
      'after-week-1',
      'after-week-2',
    ]);
    expect(dueReminderSteps('2026-11-15', [7, 2, 0], '2026-11-01')).toEqual([]);
  });

  it('fires renewal reminders at 90, 60 and 30 days, once each', () => {
    const due = dueRenewalReminders('2027-10-31', [90, 60, 30], '2027-09-15');
    expect(due.map((s) => [s.key, s.date])).toEqual([
      ['before-90', '2027-08-02'],
      ['before-60', '2027-09-01'],
    ]);
    expect(endsWithin('2027-10-31', '2027-09-15', 90)).toBe(true);
    expect(endsWithin('2027-10-31', '2027-06-01', 90)).toBe(false);
  });
});

const content = (extra: Partial<TemplateContent> = {}): TemplateContent => ({
  sections: [
    {
      key: 'agreement',
      heading: 'Agreement',
      clauses: ['parties', 'premises', 'term', 'rent', 'electronic_service', 'signatures'].map(
        (key) => ({
          key,
          title: null,
          body: key === 'parties' ? 'Between {{landlord.name}} and {{tenant.name}}.' : 'Text.',
          required: true,
          editable: key !== 'parties',
        }),
      ),
    },
  ],
  ...extra,
});

describe('TL-05 lease templates', () => {
  it('accepts plain-text clauses with known placeholders', () => {
    expect(() => checkTemplateContent(content())).not.toThrow();
  });

  it('refuses unknown placeholders, markup, and removing a required clause', () => {
    const withBody = (body: string) => {
      const c = content();
      return {
        sections: [
          {
            ...c.sections[0]!,
            clauses: [
              ...c.sections[0]!.clauses,
              { key: 'extra', title: null, body, required: false, editable: true },
            ],
          },
        ],
      };
    };
    expect(() => checkTemplateContent(withBody('Pay {{tenant.salary}}'))).toThrow(
      /not a known placeholder/,
    );
    expect(() => checkTemplateContent(withBody('<b>bold</b>'))).toThrow(/plain text/);
    const c = content();
    const without = {
      sections: [
        {
          ...c.sections[0]!,
          clauses: c.sections[0]!.clauses.filter((x) => x.key !== 'electronic_service'),
        },
      ],
    };
    expect(() => checkTemplateContent(without)).toThrow(/electronic_service/);
  });

  it('fills placeholders and leaves a visible gap where a value is missing', () => {
    expect(
      fillPlaceholders('Between {{landlord.name}} and {{ tenant.name }}.', {
        'landlord.name': 'Ama',
      }),
    ).toBe('Between Ama and ________.');
  });
});

describe('TL-07 signing rules', () => {
  it('completes only when every required signer has signed and nobody declined', () => {
    expect(
      signingComplete([
        { required: true, status: 'signed' },
        { required: false, status: 'pending' },
      ]),
    ).toBe(true);
    expect(
      signingComplete([
        { required: true, status: 'signed' },
        { required: true, status: 'pending' },
      ]),
    ).toBe(false);
    expect(
      signingComplete([
        { required: true, status: 'signed' },
        { required: false, status: 'declined' },
      ]),
    ).toBe(false);
    expect(signingComplete([])).toBe(false);
  });

  it('needs a typed name or a drawing', () => {
    expect(checkSignature({ method: 'typed', typedName: ' Ama Tenant ' })).toEqual({
      method: 'typed',
      typedName: 'Ama Tenant',
    });
    expect(() => checkSignature({ method: 'typed', typedName: 'A' })).toThrow(/name/);
    expect(() => checkSignature({ method: 'drawn' })).toThrow(/Draw/);
  });
});

describe('TL-05 starter templates', () => {
  it('passes the template checks, and marks every legal clause for a lawyer', async () => {
    const { STARTER_TEMPLATES, LAWYER_WORDING } = await import('./starter-templates');
    for (const template of Object.values(STARTER_TEMPLATES)) {
      expect(() => checkTemplateContent(template)).not.toThrow();
      const editable = template.sections.flatMap((s) => s.clauses).filter((c) => c.editable);
      expect(editable.length).toBeGreaterThan(0);
      for (const clause of editable) expect(clause.body).toBe(LAWYER_WORDING);
    }
  });
});
