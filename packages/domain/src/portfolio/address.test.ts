import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkGhanaPostGps,
  checkMapPin,
  isGhanaPostGpsFormat,
  mapsLink,
  normaliseGhanaPostGps,
} from './address';

describe('PR-03 addresses', () => {
  it('normalises GhanaPost GPS addresses typed in any case and spacing', () => {
    expect(normaliseGhanaPostGps(' ga 183 8164 ')).toBe('GA-183-8164');
    expect(normaliseGhanaPostGps('ak-039–5028')).toBe('AK-039-5028');
    expect(checkGhanaPostGps('GA - 0123 - 4567')).toBe('GA-0123-4567');
  });

  it('accepts every address in the documented format', () => {
    const upper = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
    const district = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''));
    const digits = (n: number) =>
      fc
        .array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n })
        .map((a) => a.join(''));
    fc.assert(
      fc.property(
        upper,
        district,
        fc.oneof(digits(3), digits(4)),
        digits(4),
        fc.constantFrom('-', ' ', ' - ', '–'),
        fc.boolean(),
        (r, d, area, number, sep, lower) => {
          const typed = `${r}${d}${sep}${area}${sep}${number}`;
          const input = lower ? typed.toLowerCase() : typed;
          expect(isGhanaPostGpsFormat(input)).toBe(true);
          expect(checkGhanaPostGps(input)).toBe(`${r}${d}-${area}-${number}`);
        },
      ),
    );
  });

  it('refuses text that is not a digital address', () => {
    for (const bad of ['', 'GA1838164', 'G-183-8164', 'GA-18-8164', 'GA-183-81640', 'Legon'])
      expect(() => checkGhanaPostGps(bad)).toThrow(/GhanaPost GPS/);
  });

  it('checks map pins and keeps them as typed', () => {
    expect(checkMapPin('5.6505', -0.1862)).toEqual({ latitude: '5.6505', longitude: '-0.1862' });
    expect(() => checkMapPin('91', '0')).toThrow(/latitude/);
    expect(() => checkMapPin('5', '-181')).toThrow(/longitude/);
    expect(() => checkMapPin('5.1234567', '0')).toThrow(/6 decimal places/);
    expect(() => checkMapPin('north', '0')).toThrow();
  });

  it('links a pin to a maps app without a key', () => {
    expect(mapsLink({ latitude: '5.6505', longitude: '-0.1862' })).toBe(
      'https://www.google.com/maps/search/?api=1&query=5.6505%2C-0.1862',
    );
  });
});
