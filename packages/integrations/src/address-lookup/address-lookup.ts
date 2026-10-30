import { isGhanaPostGpsFormat, normaliseGhanaPostGps } from '@rent/domain/portfolio';
import { ProviderError, requestJson } from '../http';
import { z } from 'zod';
import { unexpectedResponse } from '../validation';

/**
 * GhanaPost GPS digital addresses (PR-03; OQ-23). There is no published API yet: lookups must come
 * from a licensed source (M2), and addresses are entered by hand and checked against the pattern.
 */
export interface GhanaPostAddress {
  readonly code: string;
  readonly region: string;
  readonly district: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface AddressLookupPort {
  readonly provider: string;
  /** Null for an unknown code, and for one that is not a digital address (no lookup is made). */
  lookup(code: string): Promise<GhanaPostAddress | null>;
}

// The format check lives in packages/domain, so forms, the import and this adapter share it (M2).
export { isGhanaPostGpsFormat, normaliseGhanaPostGps };

/**
 * Invented addresses for tests and local development, in the unused 000 area. Labelled fake so
 * they are never mistaken for GhanaPost data.
 */
export const FAKE_GHANA_POST_ADDRESSES: Readonly<Record<string, GhanaPostAddress>> = {
  'GA-000-0001': {
    code: 'GA-000-0001',
    region: 'Greater Accra (fake test data)',
    district: 'Test district A (fake)',
    latitude: 5.6505,
    longitude: -0.1862,
  },
  'GA-000-0002': {
    code: 'GA-000-0002',
    region: 'Greater Accra (fake test data)',
    district: 'Test district B (fake)',
    latitude: 5.556,
    longitude: -0.1819,
  },
  'AK-000-0001': {
    code: 'AK-000-0001',
    region: 'Ashanti (fake test data)',
    district: 'Test district C (fake)',
    latitude: 6.6885,
    longitude: -1.6244,
  },
};

/** Answers from a fixed table, by default the fake addresses above. */
export class InMemoryAddressLookup implements AddressLookupPort {
  readonly provider = 'memory';
  constructor(
    private readonly addresses: Readonly<
      Record<string, GhanaPostAddress>
    > = FAKE_GHANA_POST_ADDRESSES,
  ) {}

  async lookup(code: string): Promise<GhanaPostAddress | null> {
    const normalised = normaliseGhanaPostGps(code);
    if (!isGhanaPostGpsFormat(normalised)) return null;
    const found = Object.hasOwn(this.addresses, normalised)
      ? this.addresses[normalised]
      : undefined;
    return found ? { ...found } : null;
  }
}

const address = z.object({
  code: z.string().min(1),
  region: z.string().min(1),
  district: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** Talks to `apps/fake-providers` over HTTP. */
export class FakeProvidersAddressLookup implements AddressLookupPort {
  readonly provider = 'fake-providers';
  constructor(private readonly baseUrl: string) {}

  async lookup(code: string): Promise<GhanaPostAddress | null> {
    const normalised = normaliseGhanaPostGps(code);
    if (!isGhanaPostGpsFormat(normalised)) return null;
    let response: unknown;
    try {
      response = await requestJson<unknown>(
        this.provider,
        `${this.baseUrl}/address-lookup/${encodeURIComponent(normalised)}`,
      );
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null;
      throw error;
    }
    const parsed = address.safeParse(response);
    if (!parsed.success) throw unexpectedResponse(this.provider);
    return parsed.data;
  }
}
