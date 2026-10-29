import { beforeEach, describe, expect, it } from 'vitest';
import type { AddressLookupPort, GhanaPostAddress } from '../address-lookup/address-lookup';

export interface AddressLookupHarness {
  readonly port: AddressLookupPort;
  /** An address the provider knows. */
  readonly known: GhanaPostAddress;
  /** A well-formed code the provider does not know. */
  readonly unknownCode: string;
}

/** What every address lookup adapter must do. */
export function addressLookupContract(
  adapter: string,
  makeHarness: () => AddressLookupHarness | Promise<AddressLookupHarness>,
): void {
  describe(`PLATFORM integration contracts: address lookup (${adapter})`, () => {
    let h: AddressLookupHarness;
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('resolves a known digital address to its region, district and coordinates', async () => {
      expect(await h.port.lookup(h.known.code)).toEqual(h.known);
    });

    it('accepts the code in lower case, with spaces for hyphens, and answers with the canonical code', async () => {
      const typed = `  ${h.known.code.toLowerCase().replaceAll('-', ' ')} `;
      expect(await h.port.lookup(typed)).toEqual(h.known);
    });

    it('returns null for a well-formed code it does not know', async () => {
      expect(await h.port.lookup(h.unknownCode)).toBeNull();
    });

    it('returns null, without an error, for something that is not a digital address', async () => {
      for (const code of [
        '',
        'Accra',
        'GA-12-3456',
        'GA-1234-567',
        '1A-123-4567',
        'GA-123-4567-8',
      ]) {
        expect(await h.port.lookup(code)).toBeNull();
      }
    });
  });
}
