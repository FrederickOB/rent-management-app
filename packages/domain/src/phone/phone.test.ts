import { describe, expect, it } from 'vitest';
import { maskPhone, normalisePhone, tryNormalisePhone } from './phone';

describe('NFR-LOC phone numbers', () => {
  it('normalises Ghanaian formats to E.164', () => {
    expect(normalisePhone('024 412 3456')).toBe('+233244123456');
    expect(normalisePhone('+233 24 412 3456')).toBe('+233244123456');
    expect(normalisePhone('0201234567')).toBe('+233201234567');
    expect(normalisePhone('+44 7400 123456')).toBe('+447400123456'); // libphonenumber's GB example number
  });

  it('rejects numbers that are not valid', () => {
    expect(tryNormalisePhone('12345')).toBeNull();
    expect(() => normalisePhone('024 412')).toThrow();
  });

  it('masks all but the last four digits', () => {
    expect(maskPhone('+233244123456')).toBe('+233 ** *** 3456');
  });
});
