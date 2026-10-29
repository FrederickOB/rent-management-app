import { describe, expect, it } from 'vitest';
import { formatIntegerList, parseInteger, parseIntegerList } from './integers';

describe('AD-01 company settings lists', () => {
  it('reads reminder offsets typed with commas or spaces, including a typographic minus', () => {
    expect(parseIntegerList('-7, 0, 3, 7, 14')).toEqual([-7, 0, 3, 7, 14]);
    expect(parseIntegerList('−7 0  3')).toEqual([-7, 0, 3]);
    expect(formatIntegerList([90, 60, 30])).toBe('90, 60, 30');
  });

  it('refuses anything that is not a list of whole numbers', () => {
    expect(parseIntegerList('')).toBeNull();
    expect(parseIntegerList('1.5, 2')).toBeNull();
    expect(parseIntegerList('seven')).toBeNull();
    expect(parseInteger(' 24 ')).toBe(24);
    expect(parseInteger('24h')).toBeNull();
  });
});
