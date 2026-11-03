import type { TenancyGroupView } from '@rent/contracts';
import type { api } from './api';

export type Payment = Awaited<ReturnType<typeof api.tenantMoney.payments>>[number];

export interface LandlordPayments {
  readonly key: string;
  readonly name: string;
  readonly payments: Payment[];
}

/**
 * The tenant's payments, one box per landlord (TL-12). A payment belongs to a lease, and the
 * tenancies say whose lease it is; a payment on a lease no longer listed keeps the landlord name
 * it came with. Newest first within each box.
 */
export function byLandlord(
  payments: readonly Payment[],
  groups: readonly TenancyGroupView[] | null,
): LandlordPayments[] {
  const landlordOf = new Map<string, { key: string; name: string }>();
  for (const group of groups ?? [])
    for (const tenancy of group.tenancies)
      landlordOf.set(tenancy.leaseId, {
        key: group.landlord.companyId,
        name: group.landlord.name,
      });
  const boxes = new Map<string, LandlordPayments>();
  for (const payment of payments) {
    const landlord = landlordOf.get(payment.leaseId) ?? {
      key: `name:${payment.landlordName}`,
      name: payment.landlordName,
    };
    const box = boxes.get(landlord.key) ?? { ...landlord, payments: [] };
    box.payments.push(payment);
    boxes.set(landlord.key, box);
  }
  for (const box of boxes.values())
    box.payments.sort((a, b) =>
      a.receivedOn < b.receivedOn ? 1 : a.receivedOn > b.receivedOn ? -1 : 0,
    );
  return [...boxes.values()];
}

export function unitsOf(groups: readonly TenancyGroupView[] | null): Map<string, string> {
  const units = new Map<string, string>();
  for (const group of groups ?? [])
    for (const tenancy of group.tenancies) units.set(tenancy.leaseId, tenancy.unitCode);
  return units;
}
