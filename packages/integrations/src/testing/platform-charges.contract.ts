import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import type {
  PaymentsPort,
  PaymentsTestControls,
  PlatformChargeRequest,
  PlatformMomoRequest,
} from '../payments/payments';
import { fakeEmail, fakePhone, uniqueReference } from './fixtures';

export interface PlatformChargesHarness {
  readonly port: PaymentsPort & PaymentsTestControls;
}

const refusedWith = async (promise: Promise<unknown>, status: number) => {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).retryable).toBe(false);
  expect((error as ProviderError).status).toBe(status);
};

const around = (msBefore: number, msAfter: number) => ({
  from: new Date(Date.now() - msBefore).toISOString(),
  to: new Date(Date.now() + msAfter).toISOString(),
});

/**
 * M10 decision 9: what every payments adapter does with the platform's own charges (the
 * subscription). They name no subaccount, so they settle to the platform's balance, apart from any
 * landlord's or agency's payout (D1 governs rent); their references start `SUB-`.
 */
export function platformChargesContract(
  adapter: string,
  makeHarness: () => PlatformChargesHarness | Promise<PlatformChargesHarness>,
): void {
  describe(`PB-07 platform charges with no subaccount (${adapter})`, () => {
    let h: PlatformChargesHarness;

    const card = (overrides: Partial<PlatformChargeRequest> = {}): PlatformChargeRequest => ({
      reference: uniqueReference('SUB'),
      amountMinor: 15_000,
      currency: 'GHS',
      email: fakeEmail(),
      metadata: { purpose: 'invoices' },
      ...overrides,
    });
    const momo = (overrides: Partial<PlatformMomoRequest> = {}): PlatformMomoRequest => ({
      reference: uniqueReference('SUB'),
      amountMinor: 15_000,
      currency: 'GHS',
      email: fakeEmail(),
      phone: fakePhone(),
      network: 'mtn',
      metadata: { purpose: 'annual' },
      ...overrides,
    });

    beforeEach(async () => {
      h = await makeHarness();
    });

    it('starts a card charge on the checkout page; verify reports it pending, with no subaccount', async () => {
      const request = card();
      const started = await h.port.initializePlatform(request);
      expect(started).toMatchObject({ provider: h.port.provider, status: 'pending' });
      expect(URL.canParse(started.authorizationUrl ?? '')).toBe(true);
      expect(await h.port.verify(request.reference)).toEqual({
        status: 'pending',
        amountMinor: 15_000,
        currency: 'GHS',
        reference: request.reference,
        channel: 'card',
        metadata: request.metadata,
      });
      expect((await h.port.verifyTransaction(request.reference)).subaccountCode).toBe('');
    });

    it('starts a MoMo charge whose prompt goes to the phone, then a signed webhook once paid', async () => {
      const request = momo();
      const started = await h.port.chargePlatformMomo(request);
      expect(started).toMatchObject({ status: 'pending' });
      expect(started.authorizationUrl).toBeUndefined();
      expect((await h.port.verify(request.reference)).channel).toBe('momo');
      const webhook = await h.port.completeCharge(request.reference, { status: 'success' });
      expect(webhook).not.toBeNull();
      expect(h.port.verifyWebhookSignature(webhook!.rawBody, webhook!.headers)).toBe(true);
      expect(h.port.parseWebhook(webhook!.rawBody)).toMatchObject({
        type: 'charge.success',
        reference: request.reference,
      });
      expect(await h.port.verifyTransaction(request.reference)).toMatchObject({
        status: 'success',
        amountMinor: 15_000,
        subaccountCode: '',
      });
    });

    it('refuses a reference without the platform prefix, a bad amount, phone or currency', async () => {
      await refusedWith(h.port.initializePlatform(card({ reference: uniqueReference('pi') })), 400);
      await refusedWith(
        h.port.chargePlatformMomo(momo({ reference: uniqueReference('ext') })),
        400,
      );
      await refusedWith(h.port.initializePlatform(card({ amountMinor: 150.5 })), 400);
      await refusedWith(h.port.initializePlatform(card({ amountMinor: 0 })), 400);
      await refusedWith(h.port.initializePlatform(card({ currency: 'NGN' as 'GHS' })), 400);
      await refusedWith(h.port.chargePlatformMomo(momo({ phone: '0240000000' })), 400);
    });

    it('refuses a reference used before with 409', async () => {
      const request = card();
      await h.port.initializePlatform(request);
      await refusedWith(h.port.initializePlatform(request), 409);
    });

    it('pays the platform out on its own, never in a landlord’s settlement, less fees and chargebacks', async () => {
      const { subaccountCode } = await h.port.createSubaccount({
        businessName: 'Test Landlord Ltd',
        settlementBank: 'TEST',
        accountNumber: '0123456789',
      });
      const rent = {
        reference: uniqueReference('pay'),
        amountMinor: 150_000,
        currency: 'GHS' as const,
        channel: 'card' as const,
        customer: { email: fakeEmail() },
        subaccountCode,
        metadata: {},
      };
      const first = card({ amountMinor: 20_000 });
      const second = momo({ amountMinor: 5_000 });
      await h.port.initialiseCharge(rent);
      await h.port.initializePlatform(first);
      await h.port.chargePlatformMomo(second);
      await h.port.completeCharge(rent.reference, { status: 'success', feesMinor: 2_000 });
      await h.port.completeCharge(first.reference, { status: 'success', feesMinor: 300 });
      await h.port.completeCharge(second.reference, { status: 'success', feesMinor: 75 });
      await h.port.settle();
      // The fake over HTTP is shared, so another suite may pay these out first: each charge is
      // found in whichever settlement holds it.
      const listed = await h.port.listSettlements(around(60_000, 60_000));
      const holding = (reference: string) => listed.filter((s) => s.references.includes(reference));
      for (const reference of [first.reference, second.reference]) {
        expect(holding(reference)).toHaveLength(1);
        expect(holding(reference)[0]!.subaccountCode).toBe('');
      }
      expect(holding(rent.reference)).toHaveLength(1);
      expect(holding(rent.reference)[0]!.subaccountCode).toBe(subaccountCode);
      expect(holding(rent.reference)[0]!.references).not.toContain(first.reference);
      for (const s of listed.filter((x) => x.subaccountCode === ''))
        expect(s.netMinor).toBe(s.grossMinor - s.feesMinor - s.deductionsMinor);
      const own = holding(first.reference)[0]!;
      expect(own.grossMinor).toBeGreaterThanOrEqual(
        own === holding(second.reference)[0] ? 25_000 : 20_000,
      );

      // A chargeback on a platform charge comes out of a later payout of the platform's balance.
      await h.port.chargeback(first.reference);
      expect((await h.port.verify(first.reference)).status).toBe('reversed');
      expect(await h.port.reversals(first.reference)).toEqual([
        expect.objectContaining({ kind: 'chargeback', status: 'processed', amountMinor: 20_000 }),
      ]);
      const later = card({ amountMinor: 30_000 });
      await h.port.initializePlatform(later);
      await h.port.completeCharge(later.reference, { status: 'success' });
      await h.port.settle();
      const deducted = (await h.port.listSettlements(around(60_000, 60_000))).filter((s) =>
        s.deductedReferences.some((d) => d.reference === first.reference),
      );
      expect(deducted).toHaveLength(1);
      expect(deducted[0]!.subaccountCode).toBe('');
      expect(deducted[0]!.deductedReferences).toContainEqual({
        reference: first.reference,
        amountMinor: 20_000,
      });
    });
  });
}
