import type { Me, TenancyDetailView, TenancyGroupView, TenantSigningView } from '@rent/contracts';

// What the tenant-app endpoints return (packages/contracts/src/tenancy.ts), for the screen tests.

export const AGENCY = {
  companyId: '0193a7c0-0000-7000-8000-000000000001',
  name: 'Osu Ridge Property Managers',
};
export const LANDLORD = {
  companyId: '0193a7c0-0000-7000-8000-000000000002',
  name: 'Kwabena Owusu',
};

export const ME: Me = {
  personId: '0193a7c0-0000-7000-8000-0000000000aa',
  name: 'Abena Mensah',
  state: 'ready',
  authMethod: 'phone_otp',
  sessionExpiresAt: '2026-11-28T12:00:00.000Z',
  actorKind: 'tenant',
  activeCompanyId: null,
  role: null,
  memberships: [],
};

type Card = TenancyGroupView['tenancies'][number];

export function card(overrides: Partial<Card> = {}): Card {
  return {
    leaseId: '0193a7c0-0000-7000-8000-0000000000a1',
    status: 'active',
    unitCode: 'ACC-ELG-B1-05',
    propertyName: 'East Legon flats',
    address: '12 Lagos Avenue, East Legon, Greater Accra',
    startDate: '2026-09-01',
    endDate: '2027-08-31',
    monthlyRentMinor: 220_000,
    currency: 'GHS',
    cycle: 'monthly',
    signedOnPaper: true,
    documentId: '0193a7c0-0000-7000-8000-0000000000d1',
    ...overrides,
  };
}

/** The same person renting from the agency and from a self-managing landlord (TL-01). */
export const TWO_LANDLORDS: TenancyGroupView[] = [
  { landlord: AGENCY, tenancies: [card()] },
  {
    landlord: LANDLORD,
    tenancies: [
      card({
        leaseId: '0193a7c0-0000-7000-8000-0000000000b1',
        unitCode: 'TEM-EST-B1-01',
        propertyName: 'Tema estate house',
        address: 'Tema Community 25, Greater Accra',
        startDate: '2026-05-15',
        endDate: '2028-05-14',
        monthlyRentMinor: 450_050,
        cycle: 'six_monthly',
        documentId: null,
      }),
    ],
  },
];

export function detail(overrides: Partial<TenancyDetailView> = {}): TenancyDetailView {
  return {
    ...card(),
    landlord: AGENCY,
    depositMinor: 440_000,
    serviceChargeMonthlyMinor: 15_000,
    noticeDays: 60,
    steps: [{ effectiveFrom: '2027-03-01', monthlyRentMinor: 235_050 }],
    ...overrides,
  };
}

export const SIGNER_ID = '0193a7c0-0000-7000-8000-0000000000c1';

export function signingItem(overrides: Partial<TenantSigningView> = {}): TenantSigningView {
  return {
    signingRequestId: '0193a7c0-0000-7000-8000-0000000000e1',
    leaseId: '0193a7c0-0000-7000-8000-0000000000a9',
    status: 'pending',
    title: 'Tenancy agreement: ACC-ELG-B1-07',
    sentAt: '2026-10-29T17:05:00.000Z',
    landlord: AGENCY,
    tenancy: card({
      leaseId: '0193a7c0-0000-7000-8000-0000000000a9',
      status: 'pending_signatures',
      unitCode: 'ACC-ELG-B1-07',
      signedOnPaper: false,
      documentId: null,
    }),
    signer: { id: SIGNER_ID, name: 'Abena Mensah', status: 'pending', signedAt: null },
    signers: [
      { roleLabel: 'Tenant', name: 'Abena Mensah', status: 'pending' },
      { roleLabel: 'For the landlord', name: 'Kofi Manager', status: 'pending' },
      { roleLabel: 'Witness', name: 'Esi Witness', status: 'signed' },
    ],
    ...overrides,
  };
}

/** The tenant's signature recorded: the request stays out until the others sign. */
export function signedItem(): TenantSigningView {
  const item = signingItem();
  return {
    ...item,
    signer: { ...item.signer, status: 'signed', signedAt: '2026-10-29T17:20:00.000Z' },
    signers: item.signers.map((s) => (s.name === 'Abena Mensah' ? { ...s, status: 'signed' } : s)),
  };
}

/** An error as the typed API client throws it (an ORPCError has a status, a code and a message). */
export function apiError(status: number, code: string, message = 'Refused'): Error {
  return Object.assign(new Error(message), { status, code, defined: false });
}

/** A refusal from the API's guards, which the client keeps under `data.body`. */
export function guardError(status: number, code: string, message: string): Error {
  return Object.assign(new Error('Malformed response'), {
    status,
    code: 'MALFORMED_ORPC_ERROR_RESPONSE',
    data: { status, body: { code, message } },
  });
}
