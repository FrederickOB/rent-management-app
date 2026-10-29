import { describe, expect, it } from 'vitest';
import {
  buildScope,
  scopePickersFor,
  scopeProblems,
  scopeSummary,
  scopeToSave,
} from '../app/(app)/settings/users/scope';

const OWNER = '019a3000-0000-7000-8000-00000000000a';
const LEG = '019a3000-0000-7000-8000-000000000101';
const OSU = '019a3000-0000-7000-8000-000000000102';

describe('AD-02 access pickers on the users screen', () => {
  it('gives caretakers a required property picker and no owner picker', () => {
    expect(scopePickersFor('caretaker', 'agency')).toEqual({
      owners: 'hidden',
      properties: 'required',
    });
    expect(scopePickersFor('caretaker', 'landlord')).toEqual({
      owners: 'hidden',
      properties: 'required',
    });
  });

  it('gives agency client owners and advisers a required owner picker', () => {
    expect(scopePickersFor('owner', 'agency')).toEqual({
      owners: 'required',
      properties: 'optional',
    });
    expect(scopePickersFor('adviser', 'agency')).toEqual({
      owners: 'required',
      properties: 'optional',
    });
  });

  it('lets managers and everyone else be limited either way, or not at all', () => {
    for (const role of ['property_manager', 'agency_admin', 'accountant'] as const)
      expect(scopePickersFor(role, 'agency')).toEqual({
        owners: 'optional',
        properties: 'optional',
      });
    expect(scopePickersFor('adviser', 'landlord')).toEqual({
      owners: 'optional',
      properties: 'optional',
    });
  });

  it('needs a choice where the role sees nothing without one', () => {
    const caretaker = scopePickersFor('caretaker', 'agency');
    expect(scopeProblems(caretaker, [], [])).toEqual({
      properties: 'Choose at least one property.',
    });
    expect(scopeProblems(caretaker, [], [LEG])).toEqual({});
    const manager = scopePickersFor('property_manager', 'agency');
    expect(scopeProblems(manager, [], [])).toEqual({});
  });

  it('saves a canonical scope, dropping lists the role ignores', () => {
    const caretaker = scopePickersFor('caretaker', 'agency');
    expect(scopeToSave(caretaker, [OWNER], [OSU, LEG, LEG])).toEqual({ properties: [LEG, OSU] });
    expect(buildScope([], [])).toEqual({});
  });

  it('names the scope when it can, and counts it otherwise', () => {
    const names = { owners: new Map([[OWNER, 'Ama']]), properties: new Map([[LEG, 'ACC-LEG']]) };
    expect(scopeSummary({}, names)).toBe('Whole company');
    expect(scopeSummary({ properties: [LEG] }, names)).toBe('Only ACC-LEG');
    expect(scopeSummary({ owners: [OWNER], properties: [LEG, OSU] }, names)).toBe(
      'Only Ama and 2 properties',
    );
  });
});
