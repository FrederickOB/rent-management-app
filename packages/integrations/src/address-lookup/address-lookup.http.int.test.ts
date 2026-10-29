import { describe, expect, it } from 'vitest';
import { addressLookupContract, fakeProvidersContext } from '../testing';
import {
  FAKE_GHANA_POST_ADDRESSES,
  FakeProvidersAddressLookup,
  type GhanaPostAddress,
} from './address-lookup';

addressLookupContract('fake-providers over HTTP', () => ({
  port: new FakeProvidersAddressLookup(fakeProvidersContext().baseUrl),
  known: FAKE_GHANA_POST_ADDRESSES['GA-000-0001'] as GhanaPostAddress,
  unknownCode: 'GA-000-0999',
}));

describe('PLATFORM integration contracts: address lookup (fake-providers over HTTP, fixtures)', () => {
  it('serves exactly the fake addresses the in-memory adapter knows', async () => {
    const port = new FakeProvidersAddressLookup(fakeProvidersContext().baseUrl);
    for (const address of Object.values(FAKE_GHANA_POST_ADDRESSES)) {
      expect(await port.lookup(address.code)).toEqual(address);
    }
  });
});
