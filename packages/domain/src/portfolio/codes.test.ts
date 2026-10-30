import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkAreaCode,
  checkBlockCode,
  checkPropertyPart,
  checkUnitLabel,
  freePropertyPart,
  nextUnitLabels,
  parseUnitCode,
  propertyCode,
  suggestAreaCode,
  suggestPropertyPart,
  unitCode,
} from './codes';

const letters = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
const alnum = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''));
const part = (chars: fc.Arbitrary<string>, min: number, max: number) =>
  fc.array(chars, { minLength: min, maxLength: max }).map((a) => a.join(''));

describe('PR-01 unit codes', () => {
  it('builds codes in the four-part pattern, such as ACC-LEG-B2-04', () => {
    expect(propertyCode('acc', 'leg')).toBe('ACC-LEG');
    expect(unitCode('ACC-LEG', 'b2', '04')).toBe('ACC-LEG-B2-04');
    expect(unitCode('TEM-EST', 'B1', '01')).toBe('TEM-EST-B1-01');
    expect(unitCode('ACC-OSU', 'G', 'S01')).toBe('ACC-OSU-G-S01');
  });

  it('refuses parts that break the format', () => {
    expect(() => checkAreaCode('A')).toThrow(/area/);
    expect(() => checkAreaCode('AC1')).toThrow(/letters/);
    expect(() => checkPropertyPart('LEGON')).toThrow(/property/);
    expect(() => checkBlockCode('BLOCK')).toThrow(/block/);
    expect(() => checkUnitLabel('04-A')).toThrow(/unit/);
    expect(checkUnitLabel('4')).toBe('04');
    expect(checkUnitLabel('004')).toBe('04');
    expect(checkUnitLabel('s01')).toBe('S01');
    expect(() => unitCode('ACC', 'B1', '01')).toThrow(/property code/);
  });

  it('round-trips every valid code, and never exceeds 18 characters', () => {
    fc.assert(
      fc.property(
        part(letters, 2, 4),
        part(alnum, 2, 4),
        part(alnum, 1, 3),
        part(alnum, 1, 4),
        (area, prop, block, unit) => {
          const code = unitCode(propertyCode(area, prop), block, unit);
          expect(code.length).toBeLessThanOrEqual(18);
          expect(code).toMatch(/^[A-Z0-9-]+$/);
          expect(parseUnitCode(code)).toEqual({
            area,
            property: prop,
            block,
            unit: checkUnitLabel(unit),
          });
        },
      ),
    );
  });

  it('numbers new units after the highest number ever used in the block', () => {
    expect(nextUnitLabels([], 3)).toEqual(['01', '02', '03']);
    // 05 belongs to an archived unit: it is never handed out again.
    expect(nextUnitLabels(['01', '02', '05', 'S01'], 2)).toEqual(['06', '07']);
    expect(nextUnitLabels(['99'], 2)).toEqual(['100', '101']);
    expect(() => nextUnitLabels([], 0)).toThrow();
    expect(() => nextUnitLabels([], 201)).toThrow(/200/);
  });

  it('never hands out a label that is already used', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 500 }), { maxLength: 40 }),
        fc.integer({ min: 1, max: 50 }),
        (used, count) => {
          const usedLabels = used.map((n) => String(n).padStart(2, '0'));
          const next = nextUnitLabels(usedLabels, count);
          expect(next).toHaveLength(count);
          for (const label of next) {
            expect(usedLabels).not.toContain(label);
            expect(() => checkUnitLabel(label)).not.toThrow();
          }
        },
      ),
    );
  });

  it('suggests code parts from names and towns, and a free part on a collision', () => {
    expect(suggestAreaCode('Accra')).toBe('ACC');
    expect(suggestAreaCode('Tema Community 25')).toBe('TEM');
    expect(suggestPropertyPart('Legon compound house')).toBe('LEG');
    expect(freePropertyPart('LEG', new Set(['LEG']))).toBe('LEG2');
    expect(freePropertyPart('OSUX', new Set(['OSUX', 'OSU2']))).toBe('OSU3');
    expect(freePropertyPart('ELG', new Set())).toBe('ELG');
  });
});
