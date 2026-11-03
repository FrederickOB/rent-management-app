import { expect, type APIRequestContext } from '@playwright/test';
import { ok } from './tenancy-support';

/**
 * Helpers for the tenant app's money specs (TL-01, BC-04, TL-12; M4b plan 4.10). The tenant pays
 * on the links pay page through the fake provider, whose test controls approve a MoMo prompt as
 * the tenant's phone would.
 */
const FAKE_PROVIDERS = process.env.FAKE_PROVIDERS_URL ?? 'http://localhost:4010';
/** The fake's development key (apps/fake-providers); not a secret. */
const FAKE_PAYMENTS_KEY = process.env.FAKE_PAYMENTS_SECRET_KEY || 'sk_test_fake_providers_dev_only';

interface FakeTransaction {
  readonly reference: string;
  readonly status: string;
  readonly amount: number;
  readonly customer: { readonly phone: string | null };
}

async function charges(): Promise<FakeTransaction[]> {
  const to = new Date(Date.now() + 60_000).toISOString();
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const response = await fetch(
    `${FAKE_PROVIDERS}/payments/transaction?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { headers: { authorization: `Bearer ${FAKE_PAYMENTS_KEY}` } },
  );
  expect(response.status, 'list the fake provider’s charges').toBe(200);
  return ((await response.json()) as { data: FakeTransaction[] }).data;
}

/** The tenant approves the MoMo prompt the pay page sent to their phone (E.164). */
export async function approveMomoPrompt(phone: string): Promise<FakeTransaction> {
  let found: FakeTransaction | undefined;
  await expect
    .poll(
      async () => {
        found = (await charges()).find(
          (tx) => tx.customer.phone === phone && tx.status === 'pending',
        );
        return Boolean(found);
      },
      { message: 'the MoMo prompt reaches the fake provider' },
    )
    .toBe(true);
  const response = await fetch(
    `${FAKE_PROVIDERS}/payments/_test/charges/${encodeURIComponent(found!.reference)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'success' }),
    },
  );
  expect(response.status, `approve the charge: ${await response.text()}`).toBe(200);
  return found!;
}

/** A lease's money as its landlord's staff see it (AR-02), in pesewas. */
export async function leaseBilling(api: APIRequestContext, leaseId: string) {
  return ok<{
    dueNowMinor: number;
    paidUntil: string | null;
    paymentReference: string | null;
  }>(await api.get(`/leases/${leaseId}/billing`), 'the lease’s billing');
}

/** Waits until billing has issued the lease's first rent invoice. */
export async function firstInvoiceIssued(api: APIRequestContext, leaseId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await ok<{ kind: string }[]>(
            await api.get(`/invoices?leaseId=${leaseId}`),
            'the lease’s invoices',
          )
        ).some((invoice) => invoice.kind === 'cycle'),
      { message: 'billing issues the first rent invoice', timeout: 45_000 },
    )
    .toBe(true);
}
