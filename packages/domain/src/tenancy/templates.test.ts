import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES } from './starter-templates';
import { checkTemplateVersion, type TemplateClause, type TemplateContent } from './templates';

const previous = STARTER_TEMPLATES.residential;

/** The residential starter with each clause changed, or dropped where `change` returns null. */
const edited = (change: (clause: TemplateClause) => TemplateClause | null): TemplateContent => ({
  sections: previous.sections.map((section) => ({
    ...section,
    clauses: section.clauses.flatMap((clause) => {
      const next = change(clause);
      return next ? [next] : [];
    }),
  })),
});

/** The code of the domain error a check throws, if it throws one. */
const refusal = (check: () => unknown): string | undefined => {
  try {
    check();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('TL-05 template versions', () => {
  it('takes new wording in an editable clause, a clause of its own, and an optional clause dropped', () => {
    const next = edited((c) =>
      c.key === 'repairs'
        ? { ...c, body: 'The landlord keeps the roof sound.' }
        : c.key === 'use'
          ? null
          : c,
    );
    const own: TemplateClause = {
      key: 'parking',
      title: 'Parking',
      body: 'One parking space comes with the unit.',
      required: false,
      editable: true,
    };
    const withOwn: TemplateContent = {
      sections: [{ ...next.sections[0]!, clauses: [...next.sections[0]!.clauses, own] }],
    };
    expect(refusal(() => checkTemplateVersion(previous, withOwn))).toBeUndefined();
  });

  it('keeps a clause the last version fixed word for word, and fixed', () => {
    for (const change of [
      { body: 'The rent is GH₵1.00 a month.' },
      { title: 'Payment' },
      { editable: true },
    ])
      expect(
        refusal(() =>
          checkTemplateVersion(
            previous,
            edited((c) => (c.key === 'rent' ? { ...c, ...change } : c)),
          ),
        ),
        JSON.stringify(change),
      ).toBe('template.clause_fixed');
  });

  it('keeps every clause the last version required, and required', () => {
    // The deposit clause is not one of the six every template keeps, but the starter requires it.
    expect(
      refusal(() =>
        checkTemplateVersion(
          previous,
          edited((c) => (c.key === 'deposit' ? null : c)),
        ),
      ),
    ).toBe('template.clause_required');
    expect(
      refusal(() =>
        checkTemplateVersion(
          previous,
          edited((c) => (c.key === 'deposit' ? { ...c, required: false } : c)),
        ),
      ),
    ).toBe('template.clause_required');
  });

  it('still checks the new version on its own terms', () => {
    expect(
      refusal(() =>
        checkTemplateVersion(
          previous,
          edited((c) => (c.key === 'repairs' ? { ...c, body: 'Pay {{tenant.salary}}' } : c)),
        ),
      ),
    ).toBe('template.placeholder_unknown');
  });
});
