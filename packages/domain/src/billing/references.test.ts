import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  isValidReference,
  normaliseReference,
  referenceFrom,
  REFERENCE_LENGTH,
} from './references';

const value = fc.integer({ min: 0, max: 31 });
const reference = fc
  .array(value, { minLength: 6, maxLength: 6 })
  .map(referenceFrom)
  .filter((r): r is string => r !== null);

describe('BC-03 payment references', () => {
  it('are seven letters and digits from the Crockford alphabet, and check out', () => {
    fc.assert(
      fc.property(reference, (ref) => {
        expect(ref).toHaveLength(REFERENCE_LENGTH);
        expect([...ref].every((c) => CROCKFORD_ALPHABET.includes(c))).toBe(true);
        expect(isValidReference(ref)).toBe(true);
      }),
    );
  });

  it('catch every single-character slip', () => {
    fc.assert(
      fc.property(reference, fc.nat({ max: 6 }), value, (ref, at, replacement) => {
        const char = CROCKFORD_ALPHABET[replacement] as string;
        fc.pre(ref[at] !== char);
        const typo = ref.slice(0, at) + char + ref.slice(at + 1);
        expect(isValidReference(typo)).toBe(false);
      }),
    );
  });

  it('catch every swap of neighbours', () => {
    fc.assert(
      fc.property(reference, fc.nat({ max: 5 }), (ref, at) => {
        fc.pre(ref[at] !== ref[at + 1]);
        const swapped = ref.slice(0, at) + ref[at + 1] + ref[at] + ref.slice(at + 2);
        expect(isValidReference(swapped)).toBe(false);
      }),
    );
  });

  it('never put 0 next to Z, the one swap Luhn mod 32 cannot see', () => {
    // 0 then Z: 0 and 31 swap undetected, so the generator draws again.
    expect(referenceFrom([0, 31, 1, 2, 3, 4])).toBeNull();
    fc.assert(
      fc.property(reference, (ref) => {
        expect(/0Z|Z0/.test(ref)).toBe(false);
      }),
    );
  });

  it('read what people type: any case, spaces, dashes and Crockford’s look-alikes', () => {
    fc.assert(
      fc.property(reference, (ref) => {
        const typed = `${ref.slice(0, 3).toLowerCase()} -${ref.slice(3)}`
          .replace(/0/g, 'o')
          .replace(/1/g, 'l');
        expect(normaliseReference(typed)).toBe(ref);
      }),
    );
    expect(normaliseReference('ABC')).toBeNull();
    expect(normaliseReference('UUUUUUU')).toBeNull();
  });

  it('are unique enough to draw at random: 32 to the sixth, about a billion', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(reference, (ref) => {
        seen.add(ref);
      }),
      { numRuns: 2000 },
    );
    expect(seen.size).toBeGreaterThan(1990);
  });
});
