import type { FastifyInstance } from 'fastify';

const GHANA_POST_GPS = /^[A-Z][A-Z0-9]-\d{3,4}-\d{4}$/;

/**
 * Invented addresses in the unused 000 area, labelled fake so they are never mistaken for GhanaPost
 * data. They match FAKE_GHANA_POST_ADDRESSES in packages/integrations; the contract tests check that.
 */
export const FAKE_ADDRESSES: Readonly<Record<string, Readonly<Record<string, string | number>>>> = {
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

/** GhanaPost GPS lookups for the fixed fake codes above; any other code is not found. */
export function registerAddressLookup(app: FastifyInstance): void {
  app.get<{ Params: { code: string } }>('/address-lookup/:code', async (request, reply) => {
    const code = request.params.code
      .trim()
      .toUpperCase()
      .replace(/\s*[\s–—-]\s*/g, '-');
    if (!GHANA_POST_GPS.test(code)) {
      return reply.code(400).send({ error: 'not a GhanaPost GPS digital address' });
    }
    const address = Object.hasOwn(FAKE_ADDRESSES, code) ? FAKE_ADDRESSES[code] : undefined;
    if (!address) return reply.code(404).send({ error: 'address not found' });
    return reply.send(address);
  });
}
