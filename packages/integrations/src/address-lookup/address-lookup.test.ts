import { describe, expect, it } from 'vitest';
import { addressLookupContract } from '../testing';
import {
  FAKE_GHANA_POST_ADDRESSES,
  InMemoryAddressLookup,
  isGhanaPostGpsFormat,
  normaliseGhanaPostGps,
  type GhanaPostAddress,
} from './address-lookup';

const known = FAKE_GHANA_POST_ADDRESSES['GA-000-0001'] as GhanaPostAddress;

addressLookupContract('in-memory', () => ({
  port: new InMemoryAddressLookup(),
  known,
  unknownCode: 'GA-000-0999',
}));

describe('PR-03 GhanaPost GPS digital address format', () => {
  it('accepts region and district letters, a 3 or 4 digit area and a 4 digit number', () => {
    for (const code of [
      'GA-183-8164',
      'AK-039-5028',
      'GA-0123-4567',
      'ga-183-8164',
      ' GA 183 8164 ',
      'GA – 183 – 8164',
    ]) {
      expect(isGhanaPostGpsFormat(code)).toBe(true);
    }
  });

  it('accepts a digit in the district place (OQ-23)', () => {
    expect(isGhanaPostGpsFormat('G2-123-4567')).toBe(true);
  });

  it('refuses anything else', () => {
    for (const code of [
      '',
      'GA',
      'GA-12-3456',
      'GA-12345-6789',
      'GA-183-816',
      'GA-183-81645',
      '1A-183-8164',
      'G-183-8164',
      'GAB-183-8164',
      'GA1838164',
      'GA_183_8164',
      'GA--183-8164',
    ]) {
      expect(isGhanaPostGpsFormat(code)).toBe(false);
    }
  });

  it('normalises case, spaces and dashes to the canonical form', () => {
    expect(normaliseGhanaPostGps(' ga 183 - 8164 ')).toBe('GA-183-8164');
  });

  it('labels every fake fixture as fake data', () => {
    for (const address of Object.values(FAKE_GHANA_POST_ADDRESSES)) {
      expect(address.region).toContain('fake');
      expect(address.district).toContain('fake');
      expect(address.code).toMatch(/^[A-Z]{2}-000-\d{4}$/);
    }
  });
});
