import type { TenancyGroupView } from '@rent/contracts';
import type { api } from '../src/api';
import { AGENCY, card, LANDLORD } from './fixtures';

// What the tenant money endpoints return (packages/contracts/src/payments.ts), for the screen tests.

export type Billing = Awaited<ReturnType<typeof api.tenantMoney.billing>>;
export type Payment = Awaited<ReturnType<typeof api.tenantMoney.payments>>[number];

export const AGENCY_LEASE = '0193a7c0-0000-7000-8000-0000000000a1';
export const LANDLORD_LEASE = '0193a7c0-0000-7000-8000-0000000000b1';
export const PAY_LINK = 'http://localhost:3702/p/Tz8wzlGq2fz3T8ulnkmXH5m9vDkYB1dC0aCqfbnT2Xw';
export const RECEIPT_URL = 'http://localhost:8333/receipts/r-1.pdf?X-Amz-Signature=abc';

export function billing(overrides: Partial<Billing> = {}): Billing {
  return {
    leaseId: AGENCY_LEASE,
    landlordName: AGENCY.name,
    unitCode: 'ACC-ELG-B1-05',
    paymentReference: 'ELG105-4K',
    dueNowMinor: 220_000,
    paidUntil: '2026-10-31',
    partial: null,
    creditMinor: 0,
    nextDue: { dueDate: '2026-12-01', amountMinor: 220_000 },
    canPay: true,
    cannotPayReason: null,
    fetchedAt: '2026-11-03T09:15:00.000Z',
    ...overrides,
  };
}

/** The agency's lease and the self-managing landlord's, each with figures of its own (TL-12). */
export const BILLING: Record<string, Billing> = {
  [AGENCY_LEASE]: billing(),
  [LANDLORD_LEASE]: billing({
    leaseId: LANDLORD_LEASE,
    landlordName: LANDLORD.name,
    unitCode: 'TEM-EST-B1-01',
    paymentReference: 'TEM101-9Z',
    dueNowMinor: 0,
    paidUntil: '2027-05-14',
    partial: { monthStart: '2027-05-15', amountMinor: 120_050 },
    creditMinor: 120_050,
    nextDue: { dueDate: '2027-05-15', amountMinor: 2_700_300 },
    canPay: false,
    cannotPayReason: 'Kwabena Owusu is not taking payments in the app yet.',
    fetchedAt: '2026-11-03T09:15:01.000Z',
  }),
};

export function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: '0193a7c0-0000-7000-8000-0000000000f1',
    leaseId: AGENCY_LEASE,
    landlordName: AGENCY.name,
    amountMinor: 220_000,
    receivedOn: '2026-10-01',
    method: 'momo',
    status: 'confirmed',
    receiptId: '0193a7c0-0000-7000-8000-0000000000e9',
    receiptNumber: 'RCT-2026-000041',
    ...overrides,
  };
}

export const PAYMENTS: Payment[] = [
  payment(),
  payment({
    id: '0193a7c0-0000-7000-8000-0000000000f2',
    receivedOn: '2026-11-01',
    amountMinor: 50_000,
    method: 'card',
    receiptId: '0193a7c0-0000-7000-8000-0000000000ea',
    receiptNumber: 'RCT-2026-000057',
  }),
  payment({
    id: '0193a7c0-0000-7000-8000-0000000000f3',
    leaseId: LANDLORD_LEASE,
    landlordName: LANDLORD.name,
    amountMinor: 2_820_350,
    receivedOn: '2026-05-15',
    method: 'bank_transfer',
    receiptId: '0193a7c0-0000-7000-8000-0000000000eb',
    receiptNumber: 'KO-000012',
  }),
];

/** A tenancy on the new two-yearly cycle (M4b decision 9): 24 months to a payment. */
export const TWO_YEARLY: TenancyGroupView[] = [
  {
    landlord: LANDLORD,
    tenancies: [
      card({
        leaseId: LANDLORD_LEASE,
        unitCode: 'TEM-EST-B1-01',
        propertyName: 'Tema estate house',
        startDate: '2026-05-15',
        endDate: '2028-05-14',
        monthlyRentMinor: 450_050,
        cycle: 'two_yearly',
        documentId: null,
      }),
    ],
  },
];
