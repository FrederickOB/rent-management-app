import { STARTER_TEMPLATES } from '@rent/domain/tenancy';
import { describe, expect, it } from 'vitest';
import {
  addClause,
  addSection,
  contentProblem,
  findClause,
  keyFrom,
  moveClause,
  removeClause,
  removeSection,
  sameContent,
  unknownPlaceholders,
  updateClause,
} from './template-editor';

const starter = STARTER_TEMPLATES.residential;
const section = starter.sections[0]!.key;

describe('TL-05 the lease template editor', () => {
  it('starts from a starter that can be published as it is', () => {
    expect(contentProblem(starter)).toBeNull();
  });

  it('keeps required clauses, and the wording of clauses that are not editable', () => {
    expect(removeClause(starter, 'rent')).toEqual(starter);
    const rent = findClause(starter, 'rent')!;
    expect(rent.editable).toBe(false);
    expect(findClause(updateClause(starter, 'rent', { body: 'Changed' }), 'rent')).toEqual(rent);
    const repairs = findClause(starter, 'repairs')!;
    expect(repairs.editable).toBe(true);
    const edited = updateClause(starter, 'repairs', { body: 'The tenant keeps the unit clean.' });
    expect(findClause(edited, 'repairs')?.body).toBe('The tenant keeps the unit clean.');
    expect(sameContent(edited, starter)).toBe(false);
    expect(findClause(removeClause(edited, 'repairs'), 'repairs')).toBeUndefined();
  });

  it('adds clauses and sections with keys that are valid and unique', () => {
    expect(keyFrom('Use of the garden', starter)).toBe('use_of_the_garden');
    expect(keyFrom('Repairs', starter)).toBe('repairs_2');
    expect(keyFrom('2nd floor', starter)).toBe('clause_2nd_floor');
    const added = addClause(starter, section, 'Use of the garden');
    const clause = findClause(added, 'use_of_the_garden');
    expect(clause).toMatchObject({ required: false, editable: true, body: '' });
    expect(contentProblem(added)).toBeNull();
    const withSection = addSection(added, 'Schedule of fittings');
    expect(withSection.sections.at(-1)).toMatchObject({ key: 'schedule_of_fittings', clauses: [] });
    // A section holding required clauses cannot go; an empty one can.
    expect(removeSection(withSection, section).sections).toHaveLength(2);
    expect(removeSection(withSection, 'schedule_of_fittings').sections).toHaveLength(1);
  });

  it('moves a clause within its section', () => {
    const keys = (c: typeof starter) => c.sections[0]!.clauses.map((x) => x.key);
    const before = keys(starter);
    const moved = keys(moveClause(starter, before[1]!, -1));
    expect(moved.slice(0, 2)).toEqual([before[1], before[0]]);
    expect(keys(moveClause(starter, before[0]!, -1))).toEqual(before);
  });

  it('flags placeholders that are not on the fixed list, as the API refuses them', () => {
    expect(
      unknownPlaceholders('Pay {{rent.monthly}} to {{landlord.bank}} {{landlord.bank}}'),
    ).toEqual(['landlord.bank']);
    const bad = updateClause(starter, 'repairs', { body: 'Call {{caretaker.phone}}' });
    expect(contentProblem(bad)).toMatch(/not a known placeholder/);
    const html = updateClause(starter, 'repairs', { body: '<b>Bold</b>' });
    expect(contentProblem(html)).toMatch(/plain text/);
  });
});
